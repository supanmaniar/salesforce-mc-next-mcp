# Postman Collections & the Catalog

Where the endpoint catalog comes from, how to regenerate it, how to validate it,
and how to handle new Salesforce API versions.

For the architectural role the catalog plays, see
[ARCHITECTURE.md](ARCHITECTURE.md#catalog-generation-and-validation).

---

## Where the catalog comes from

`catalog/endpoints.json` is **generated**, never hand-written. Its source is three
official Salesforce Postman collections:

| Collection file | Family | Endpoints |
| --- | --- | --- |
| `Salesforce Marketing Cloud Next APIs.postman_collection.json` | `mc-next` | 27 |
| `Salesforce Data 360 APIs.postman_collection.json` | `data360` | 35 |
| `Salesforce Data 360 Connect APIs.postman_collection.json` | `data360-connect` | 383 |
| | **Total** | **445** |

### These collections are NOT in this repository

They are Salesforce's own published material, and they are **deliberately excluded
for licensing reasons**. This has practical consequences:

- A fresh clone can build and run without them, because the **generated** catalog
  is committed.
- You cannot regenerate the catalog unless you obtain the collections yourself.
- Most contributions do not require regeneration at all.

By default the generator looks for them in `../Marketing Cloud Next MCP Prep`
relative to the project root — i.e. as a **sibling** of the repo:

```
your-workspace/
├── Marketing Cloud Next MCP Prep/          <- the source collections
│   ├── Salesforce Marketing Cloud Next APIs.postman_collection.json
│   ├── Salesforce Data 360 APIs.postman_collection.json
│   └── Salesforce Data 360 Connect APIs.postman_collection.json
└── mc-next-mcp-server/                     <- this repo
    └── catalog/endpoints.json              <- generated output
```

### Why the collections are worth understanding

They are the **contract** the server reflects. The catalog is a faithful
transformation of them, so a "missing endpoint" is almost always a collection gap
rather than a bug — see [Known gaps](#known-gaps-in-the-collections).

The collections also carry the endpoint documentation. That is why
`mcnext_describe_endpoint` can return a rich Markdown `description` with a request
example and a field table — it comes straight from the collection, not from
anything hand-written here.

---

## Regenerating the catalog

```bash
npm run generate
```

This runs `node scripts/generate-catalog.mjs`, which reads the three collections
and writes `catalog/endpoints.json`.

### Custom input/output paths

Both paths are positional arguments:

```bash
node scripts/generate-catalog.mjs <input-dir> <output-file>
```

Useful when your collections live elsewhere:

```bash
node scripts/generate-catalog.mjs ~/salesforce-postman ./catalog/endpoints.json
```

### When to regenerate

| Situation | Regenerate? |
| --- | --- |
| Salesforce publishes a new API version | ✅ Yes |
| Salesforce adds endpoints to an existing collection | ✅ Yes |
| You change the generator's parsing or classification logic | ✅ Yes |
| You are changing tool behaviour in `src/` | ❌ No |
| You are updating docs | ❌ No |
| Fresh clone, just building | ❌ No — the catalog is committed |

> **Never hand-edit `catalog/endpoints.json`.** It is a generated artifact. Edit
> the generator and regenerate, or your change will be silently overwritten on the
> next run.

### The generator refuses to produce a degraded catalog

Because the source collections are not in this repository, `npm run generate` on a
fresh clone has **no input**. Without a guard it would write an empty catalog and
exit `0` — indistinguishable from success, and destructive to the committed
catalog.

`scripts/generate-catalog.mjs` therefore fails loudly in two cases:

| Condition | Behaviour |
| --- | --- |
| One or more source collections missing | Lists the missing files, explains they are excluded for licensing, notes that the output was still written, and **exits `1`** |
| Fewer than 400 endpoints generated | Refuses to treat it as success and **exits `1`** |

If you trigger the first case, restore the committed catalog with:

```bash
git checkout -- catalog/endpoints.json
```

This guard is what makes it safe to run `npm run generate` in CI without risking
an accidental commit of an empty catalog.

### The full regeneration workflow

```bash
# 1. Regenerate from the source collections
npm run generate

# 2. Validate the result
npm run audit

# 3. Rebuild and test
npm run build && npm run smoke

# 4. Commit the regenerated catalog
git add catalog/endpoints.json
```

Step 2 is not optional. Never commit a regenerated catalog that fails the audit.

---

## Validating the catalog

```bash
npm run audit
```

> This is also available as `node scripts/audit-catalog.mjs` if you prefer to
> invoke the script directly.

### What the audit checks

Nine fidelity checks, reported by severity:

| Check | Severity | Why it matters |
| --- | --- | --- |
| Unresolved `{{placeholders}}` in paths | **HIGH** | Postman variables leaked into real paths |
| Duplicate endpoint ids | **HIGH** | Ids are the discovery key; duplicates break lookup |
| Path-param mismatches | **HIGH** | A declared `:param` with no spec means callers cannot supply it |
| `DELETE` endpoints not classified as `delete` | **HIGH** | Misclassification means a delete escapes the destructive gate |
| Endpoints referencing unknown base keys | **HIGH** | Would throw "No base URL configured" at call time |
| Raw bodies that failed to parse | MED | Silent loss of request-body information |
| Array schemas with no item shape | LOW | Expected for genuinely empty sample arrays |
| Endpoints with no description | LOW | Degrades the model's ability to choose correctly |

The `DELETE`-classification check is the most security-relevant: if a delete
endpoint were classified as anything other than `delete`, it would not be flagged
destructive and would bypass the gate.

### The audit fails, not just reports

Three conditions cause a non-zero exit:

| Condition | Why |
| --- | --- |
| Fewer than **400 endpoints** | A truncated or empty catalog would otherwise report `✔ 0 issues found` — a clean bill of health for a broken artifact |
| Fewer than **40 groups** | Same reason, at the grouping level |
| Destructive count below **63** | The most dangerous regression: it would mean DELETE operations escaping the gate |
| Any **HIGH**-severity finding | HIGH means a real fidelity problem, not noise |

MED and LOW findings are reported but tolerated, so the known expected LOW does not
block the build.

### Current output

```
bases: {"mcNext":27,"login":1,"data360":34,"data360Connect":383}
non-JSON bodies: 1 (ingestion-api.upload-job:text/csv)

endpoints: 445  groups: 44  destructive: 63
byKind: {"query":122,"create":115,"read":80,"update":45,"delete":45,"action":38}
byFamily: {"mc-next":27,"data360":35,"data360-connect":383}

1 issue(s):
  [LOW] 25 array schemas have no item shape
```

The single LOW is expected and documented — see below.

### A note on the `bases` line

`bases` counts endpoints **per base key**, not endpoints per family. `login: 1`
is the single OAuth token endpoint, and `data360: 34` against a family count of
35 reflects one endpoint resolving to a different base. It is a diagnostic line,
not a family breakdown.

---

## Catalog structure

The generated file has six top-level keys:

```json
{
  "$schema": "./catalog.schema.json",
  "generatedAt": "2026-09-25T...",
  "api": { },
  "stats": { },
  "groups": [ ],
  "endpoints": [ ]
}
```

| Key | Contents |
| --- | --- |
| `api` | Family metadata (label, endpoint count, source collection, auth details), the `bases` map, and the unified auth description |
| `stats` | `endpointCount`, `groupCount`, `familyCount`, and breakdowns by family, method, and kind |
| `groups` | The 44 group names |
| `endpoints` | The 445 endpoint objects |

> **Known gap:** `$schema` references `./catalog.schema.json`, but that file is
> **not present** in the repository. The reference is currently unresolvable, and
> the audit does not validate against it. Adding the schema (or removing the
> reference) is an open improvement.

### Endpoint object shape

Each endpoint carries:

| Field | Notes |
| --- | --- |
| `id` | Stable discovery key, e.g. `content.create-an-email-with-html` |
| `name`, `group`, `subGroup`, `action` | Display and grouping metadata |
| `family`, `familyLabel` | `mc-next` / `data360` / `data360-connect` |
| `kind` | `query` / `read` / `create` / `update` / `delete` / `action` |
| `method`, `path` | HTTP method and path (may contain `:params`) |
| `base` | Base key resolved against `cfg.bases` at call time |
| `pathParams`, `queryParams`, `headers` | Parameter specs |
| `bodyMode`, `bodyContentType`, `bodySchema`, `bodySample`, `formFields` | Request-body contract |
| `destructive` | Drives the destructive gate (63 endpoints) |
| `description` | Markdown docs from the collection |

### Normalizations the generator applies

These are deliberate, and changing them would be a breaking change.

#### 1. No `required` arrays in body schemas

The collections provide **sample** bodies only. Every property appears present, so
marking them all required would be wrong — especially for `PATCH` endpoints where
any subset is valid. Schemas therefore describe **shape and types, not
obligations**.

#### 2. Empty raw bodies mean "no body"

Many `GET`/`DELETE` requests declare `mode: raw` with `raw: ""`. That means *no
body*, not an empty JSON body, so they normalize to `bodyMode: null`.

#### 3. Non-JSON bodies keep their real content type

Exactly one endpoint has a non-JSON body:

```
ingestion-api.upload-job → bodyMode: raw, bodyContentType: text/csv
```

The Ingestion API's bulk upload is CSV and is passed through **verbatim** with
`Content-Type: text/csv`. It is not wrapped in JSON.

#### 4. Host placeholders resolved by longest-prefix match

The three collections use different variable styles:

| Collection | Host template |
| --- | --- |
| Marketing Cloud Next | `{{apiBaseUrl}}{{apiBasePath}}` |
| Data 360 | `{{_dcTenantUrl}}`, `{{baseUrl}}` |
| Data 360 Connect | `{{dne_cdpInstanceUrl}}`, `{{loginUrl}}` |

`resolveBaseKey()` matches against each collection's `hostMap` by **longest
prefix**, so a more specific template wins over a shorter one.

#### 5. Postman variable placeholders are stripped

Values like `{{nextPageToken}}` are not real defaults and are dropped rather than
surfaced as usable values.

#### 6. Long query defaults are summarized

Some collections embed enormous comma-separated defaults. Echoing those on every
`describe` call would waste context, so `compactParam()` replaces any default over
80 characters with a summary like `12 values, e.g. a,b,c,d,e,…`.

---

## Updating for a new Salesforce API version

Salesforce periodically publishes new API versions and refreshes its Postman
collections.

### Step 1 — Obtain the updated collections

Download the current collections from Salesforce. Their filenames must match the
expected names (see the table at the top), or the generator will not find them.

### Step 2 — Regenerate and validate

```bash
npm run generate
npm run audit
```

Read the audit output carefully. A new API version often introduces endpoints with
new patterns that the classifier has not seen. Watch for **HIGH** findings — those
indicate a real problem, not noise.

### Step 3 — Diff the catalog before committing

The catalog is ~1 MB of JSON, so a diff is unreadable. Compare the *stats* instead:

```bash
git diff --stat catalog/endpoints.json

# Compare headline numbers against the committed version
git show HEAD:catalog/endpoints.json > /tmp/old.json
node -e "
const a=require('/tmp/old.json'), b=require('./catalog/endpoints.json');
console.log('old:', a.stats.endpointCount, a.stats.groupCount, 'destructive:', a.endpoints.filter(e=>e.destructive).length);
console.log('new:', b.stats.endpointCount, b.stats.groupCount, 'destructive:', b.endpoints.filter(e=>e.destructive).length);
console.log('byKind old:', JSON.stringify(a.stats.byKind));
console.log('byKind new:', JSON.stringify(b.stats.byKind));
"
```

**Check the destructive count especially.** If it drops unexpectedly, a new
endpoint may be misclassified — which would mean a delete could bypass the gate.

### Step 4 — Rebuild and test

```bash
npm run build && npm run smoke
```

The smoke test asserts the tool surface. If it hardcodes endpoint ids or counts
that changed, it will fail — which is the intended behaviour, since it is the
regression net.

### Step 5 — Update the documented counts

Several documents quote endpoint counts. If they changed, update:

- `README.md` — the at-a-glance list and the coverage tables
- `CHANGELOG.md` — record the new totals
- `docs/ARCHITECTURE.md` — the catalog statistics
- `docs/SECURITY.md` — the destructive/allowed split (**security-relevant**)
- `SECURITY.md` — the gate coverage table

The security documents matter most: if the allowed/blocked split changes, the
security posture description becomes wrong.

### Step 6 — Commit

```bash
git add catalog/endpoints.json README.md CHANGELOG.md SECURITY.md docs/
git commit -m "chore: regenerate catalog for API vXX"
```

### If the classifier needs updating

New endpoint patterns may require changes to:

| Function | What it decides |
| --- | --- |
| `classify(method, path)` | The `kind` — **affects gating** |
| `isDestructive(method, path, actionName)` | The `destructive` flag — **affects gating** |
| `resolveBaseKey(...)` | Which host the endpoint targets |
| `inferSchema(value, depth)` | The body schema |

Any change to `classify` or `isDestructive` deserves extra scrutiny in review,
because those two functions decide what the safety gate blocks.

---

## Known gaps in the collections

These are **absent from the source collections**, not missing from this server.
Verified against the generated catalog.

| Gap | Status | Workaround |
| --- | --- | --- |
| **GraphQL API** | 0 endpoints (`graphql` matches: 0) | None |
| **SOAP API** | 0 endpoints (no `/soap/` paths) | None — matters for assignment rules, duplicate rules, owner-change options on insert |
| **Bulk API 2.0** | 0 endpoints | Use `sf_bulk_*` (Composite API, auto-chunked at 200). The 8 `/jobs/` hits are Data 360 ingest + ML jobs, **not** `/jobs/ingest` or `/jobs/query`. |
| **Metadata API deploy/retrieve** | 0 endpoints | Use the Tooling API tools. The 13 `deploy`/`retrieve` matches are Data 360 ML *retrievers* and data-kit undeploy. |
| **Tooling API passthrough** | Not general | `sf_soql_query` / `sf_describe_object` accept `tooling: true`; metadata tools use Tooling endpoints. No "call any Tooling endpoint" tool. |
| **`multipart/form-data`** | 0 endpoints | The form-data code path is unexercised. The CSV upload is sent as raw `text/csv`, not a file part. |
| **25 array schemas with no item shape** | LOW, expected | Genuinely empty sample arrays in the collections — there is no shape to infer. |
| **No `required` arrays anywhere** | By design | Samples only; see normalization #1. |

### Why these gaps exist

The collections are **hand-authored API references**, not machine-generated
specifications. They document the endpoints Salesforce chose to document in
Postman, which is a subset of the full API surface. Bulk API 2.0 and the Metadata
API are typically documented separately, and GraphQL/SOAP have their own
documentation channels.

**The practical consequence:** anything not in the collections is unreachable
through the catalog tools. For the **core org** you can fall back to
`sf_rest_request`. There is **no equivalent generic passthrough for the Data 360
tenant hosts** — an endpoint absent from the collections is simply unreachable.

---

## Contributing catalog changes

### Reporting a catalog error

If an endpoint is wrong or missing, open an issue with:

- The endpoint id (or the path, if it is missing entirely)
- What you expected versus what the catalog says
- Whether it is a **generator bug** or a **collection gap**

The distinction matters. A generator bug is fixable here; a collection gap must be
addressed with Salesforce, and can only be worked around.

### Contributing a generator fix

1. Edit `scripts/generate-catalog.mjs`.
2. Regenerate: `npm run generate`.
3. Validate: `npm run audit` — must pass.
4. Build and test: `npm run build && npm run smoke`.
5. Commit **both** the generator change and the regenerated catalog.

> **You need the source collections to do this.** They are not in the repo. If you
> cannot obtain them, say so in your PR — a maintainer can regenerate and commit
> the catalog for you. Describe the generator change precisely enough to be
> applied blind.

### Contributing a missing endpoint

You generally **cannot** add an endpoint by hand, because the catalog is
generated and would be overwritten. Options:

1. **Check whether it exists in a newer collection version** and regenerate.
2. **Use `sf_rest_request`** if the endpoint is on the core org.
3. **Open an issue** documenting the gap so it is tracked. Several gaps in the
   table above exist as documented limitations rather than silent omissions.

### Reviewing a catalog PR

Check, in order:

- [ ] `npm run audit` passes with no new HIGH/MED findings
- [ ] The destructive count did not drop unexpectedly
- [ ] `byKind` did not shift in a way that suggests misclassification
- [ ] If `classify` or `isDestructive` changed, the change is justified and tested
- [ ] Documented counts were updated (README, CHANGELOG, SECURITY)
- [ ] The regenerated `catalog/endpoints.json` is included in the commit

---

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the catalog drives tool discovery
- [CONTRIBUTING.md](../CONTRIBUTING.md#the-catalog-regeneration-workflow) — the contribution workflow
- [EXAMPLES.md](EXAMPLES.md) — using catalog ids in practice
- [SECURITY.md](../SECURITY.md#safety-gates) — why classification affects gating
