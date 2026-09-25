# Examples

Worked examples using the real tool surface. Every tool name, parameter name, and
output shape below was captured from a running server — not written from memory.

Two kinds of example appear here:

- **No credentials needed** — catalog discovery, describing endpoints, gate
  refusals, validation errors. These work on a fresh clone.
- **Requires credentials** — actual API calls. The request shapes are exact; the
  response bodies are illustrative, since they depend on your org's data.

---

## How to read these examples

Every tool call has the same shape:

```json
{ "name": "<tool>", "arguments": { ... } }
```

Responses are MCP tool results. Success returns text content; failure adds
`"isError": true`. Catalog-driven calls return a compact envelope:

```json
{
  "endpoint": "content.create-an-email-with-html",
  "family": "mc-next",
  "request": "POST https://my-org.my.salesforce.com/services/data/v66.0/connect/cms/contents",
  "status": 200,
  "ok": true,
  "durationMs": 412,
  "data": { }
}
```

The `hint` field appears on failures and tells you (or the model) what to try
next.

---

## 1. Listing Marketing Cloud Next content items

**Goal:** find the CMS search endpoints, then run a search.

### Step 1 — Discover

```json
{
  "name": "mcnext_list_endpoints",
  "arguments": {
    "family": "mc-next",
    "group": "Content",
    "kind": "query",
    "limit": 4
  }
}
```

**Actual output:**

```json
{
  "total": 4,
  "endpoints": [
    {
      "id": "content.search-content-in-workspace",
      "family": "mc-next",
      "method": "GET",
      "path": "/connect/cms/items/search",
      "name": "Content / Search / Search content in workspace",
      "kind": "query",
      "destructive": false
    },
    {
      "id": "content.search-by-title-only",
      "family": "mc-next",
      "method": "GET",
      "path": "/connect/cms/items/search",
      "name": "Content / Search / Search by title only",
      "kind": "query",
      "destructive": false
    },
    {
      "id": "content.filter-by-content-type",
      "family": "mc-next",
      "method": "GET",
      "path": "/connect/cms/items/search",
      "name": "Content / Search / Filter by content type",
      "kind": "query",
      "destructive": false
    },
    {
      "id": "content.filter-by-language",
      "family": "mc-next",
      "method": "GET",
      "path": "/connect/cms/items/search",
      "name": "Content / Search / Filter by language",
      "kind": "query",
      "destructive": false
    }
  ]
}
```

**Note:** `mcnext_list_endpoints` returns *summaries* only. Note also that the
`search` filter matches id, name, path, **and description** — so a term like
`publish` matches many endpoints incidentally. Always confirm with a `describe`.

### Step 2 — Describe before invoking

```json
{
  "name": "mcnext_describe_endpoint",
  "arguments": { "endpointId": "content.search-content-in-workspace" }
}
```

**Actual output (abridged):**

```json
{
  "id": "content.search-content-in-workspace",
  "name": "Content / Search / Search content in workspace",
  "family": "mc-next",
  "familyLabel": "Marketing Cloud Next",
  "group": "Content",
  "subGroup": "Search",
  "kind": "query",
  "method": "GET",
  "base": "mcNext",
  "baseUrl": "https://YOUR_INSTANCE.my.salesforce.com/services/data/v66.0",
  "path": "/connect/cms/items/search",
  "destructive": false,
  "description": "## Search content in workspace\n\n...",
  "pathParams": [],
  "queryParams": [ ],
  "bodyMode": null,
  "bodyContentType": null,
  "bodySchema": null,
  "bodySample": null,
  "formFields": null
}
```

> `baseUrl` shows the **placeholder** value here because the example ran without
> configuration. With `MC_NEXT_API_BASE_URL` set, it resolves to your real org.

### Step 3 — Invoke *(requires credentials)*

```json
{
  "name": "mcnext_query",
  "arguments": {
    "endpointId": "content.search-content-in-workspace",
    "query": { "q": "welcome", "pageSize": 10 }
  }
}
```

**Expected output shape:**

```json
{
  "endpoint": "content.search-content-in-workspace",
  "family": "mc-next",
  "request": "GET https://my-org.my.salesforce.com/services/data/v66.0/connect/cms/items/search?q=welcome&pageSize=10",
  "status": 200,
  "ok": true,
  "durationMs": 380,
  "data": {
    "items": [
      { "id": "...", "title": "Welcome Email", "contentType": "sfdc_cms__email" }
    ]
  }
}
```

**Common errors**

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403` + hint about scope | `sfdc_cms_api` not enabled | Enable the scope on the Connected App |
| `400` | Wrong query param name | `mcnext_describe_endpoint` shows the real names |
| Empty `items` | Search term matches nothing | Broaden the term or drop `q` |

---

## 2. Creating an email template

**Goal:** create an HTML email template.

### Step 1 — Describe the create endpoint

```json
{
  "name": "mcnext_describe_endpoint",
  "arguments": { "endpointId": "content.create-an-email-template-with-html" }
}
```

**Actual output (abridged — note the embedded sample body):**

```json
{
  "id": "content.create-an-email-template-with-html",
  "name": "Content / Email Template / Create an email template with html",
  "group": "Content",
  "subGroup": "Email Template",
  "kind": "create",
  "method": "POST",
  "base": "mcNext",
  "path": "/connect/cms/contents",
  "destructive": false,
  "description": "## Create an Email Template with HTML\n\n`POST /connect/cms/contents`\n\nCreates a new email template using raw HTML content. Use this approach for simple HTML templates without drag-and-drop components.\n\n### Request Body\n\n```json\n{\n  \"contentSpaceOrFolderId\": \"{contentSpaceOrFolderId}\",\n  \"contentType\": \"sfdc_cms__emailTemplate\",\n  \"contentBody\": {\n    \"messagePurpose\": \"promotional\",\n    \"preheader\": \"Updates, resources, and more\",\n    \"rawHtml\": \"<h1>Welcome</h1><p>Content here</p>\",\n    \"sfdc_cms:title\": \"Sample HTML Email Template\",\n    \"subjectLine\": \"What's New\"\n  }\n}\n```\n\n| Field | ..."
}
```

The `description` field carries the endpoint's full documentation from the source
collection, including the request-body example and a field table. This is usually
enough to build a correct request without guessing.

### Step 2 — Create *(requires credentials)*

```json
{
  "name": "mcnext_create",
  "arguments": {
    "endpointId": "content.create-an-email-template-with-html",
    "body": {
      "contentSpaceOrFolderId": "1WSxx0000000001AAA",
      "contentType": "sfdc_cms__emailTemplate",
      "contentBody": {
        "messagePurpose": "promotional",
        "preheader": "Updates, resources, and more",
        "rawHtml": "<h1>Welcome</h1><p>Content here</p>",
        "sfdc_cms:title": "Welcome Template",
        "subjectLine": "What's New"
      }
    }
  }
}
```

**Expected output shape:**

```json
{
  "endpoint": "content.create-an-email-template-with-html",
  "family": "mc-next",
  "request": "POST https://my-org.my.salesforce.com/services/data/v66.0/connect/cms/contents",
  "status": 201,
  "ok": true,
  "durationMs": 640,
  "data": { "id": "...", "contentKey": "..." }
}
```

> **This is a write, and it is allowed by default.** Only the 63 endpoints flagged
> `destructive` are gated. See
> [SECURITY.md](../SECURITY.md#-what-the-gates-do-not-do--read-this).

**Common errors**

| Symptom | Cause |
| --- | --- |
| `400` | Missing `contentSpaceOrFolderId`, or a wrong `contentType` |
| `403` | Missing `sfdc_cms_api` scope, or the integration user lacks CMS access |
| `404` | The workspace id does not exist in this org |

---

## 3. Running a SOQL query

**Goal:** query org data. Uses the **platform** tools, not the catalog.

```json
{
  "name": "sf_soql_query",
  "arguments": { "soql": "SELECT Id, Name FROM Account LIMIT 5" }
}
```

**Note the parameter name: `soql`** — not `query`. Getting this wrong produces a
schema error:

```
MCP error -32602: Input validation error: Invalid arguments for tool
sf_soql_query: Required at soql
```

**Expected output shape:**

```json
{
  "totalSize": 5,
  "done": true,
  "records": [
    { "attributes": { "type": "Account" }, "Id": "001...", "Name": "Acme" }
  ]
}
```

### Paginating

If `done` is `false`, the response includes a `nextRecordsUrl`. Pass it to the
pagination tool — this is the **only** dedicated pagination helper in the server:

```json
{
  "name": "sf_soql_query_more",
  "arguments": { "nextRecordsUrl": "/services/data/v66.0/query/01g...-2000" }
}
```

### Querying metadata instead

Both `sf_soql_query` and `sf_describe_object` accept `tooling: true` to target the
Tooling API:

```json
{
  "name": "sf_soql_query",
  "arguments": {
    "soql": "SELECT Id, DeveloperName FROM CustomObject",
    "tooling": true
  }
}
```

### Checking limits before bulk work

```json
{ "name": "sf_org_limits", "arguments": {} }
```

Returns daily API usage. Call this before large or repeated queries — the server
does not budget your API allowance for you.

**Common errors**

| Symptom | Cause |
| --- | --- |
| `Required at soql` | Wrong parameter name |
| `400` with `MALFORMED_QUERY` | SOQL syntax error — often a missing `LIMIT` or bad field |
| `403` | The integration user lacks read access to the object |
| `401` | Expired or revoked credentials |

---

## 4. Querying Data 360 segments

**Goal:** list segments. Data 360 lives on the **tenant host**, not the core org.

### Step 1 — Discover

```json
{
  "name": "mcnext_list_endpoints",
  "arguments": { "search": "segment", "kind": "query", "limit": 4 }
}
```

**Actual output:**

```json
{
  "total": 3,
  "endpoints": [
    {
      "id": "activations.get-activation-history",
      "family": "data360-connect",
      "method": "GET",
      "path": "/ssot/activations/:activationId/history",
      "name": "Activations Get activation history",
      "kind": "query",
      "destructive": false
    },
    {
      "id": "segments.get-segments",
      "family": "data360-connect",
      "method": "GET",
      "path": "/ssot/segments",
      "name": "Segments Get segments",
      "kind": "query",
      "destructive": false
    },
    {
      "id": "segments.get-segment-members",
      "family": "data360-connect",
      "method": "GET",
      "path": "/ssot/segments/:segmentApiName/members",
      "name": "Segments Get segment members",
      "kind": "query",
      "destructive": false
    }
  ]
}
```

Note the free-text search pulled in an *activation* endpoint too, because the word
"segment" appears in its description. This is the incidental-match behaviour
described in example 1.

### Step 2 — List segments *(requires credentials)*

```json
{
  "name": "mcnext_query",
  "arguments": { "endpointId": "segments.get-segments" }
}
```

### Step 3 — Members of one segment

Note the `:segmentApiName` path parameter — supply it via `pathParams`:

```json
{
  "name": "mcnext_query",
  "arguments": {
    "endpointId": "segments.get-segment-members",
    "pathParams": { "segmentApiName": "High_Value_Customers" }
  }
}
```

**Common errors**

| Symptom | Cause |
| --- | --- |
| `404` | Wrong `segmentApiName` |
| `Missing required path parameter(s): :segmentApiName` | `pathParams` omitted |
| `403` | Missing `cdp_query_api` / `cdp_profile_api` |
| Confusing 403/404 | `DATA360_TENANT_URL` pointing at the wrong host — it must be the `c360a` host |

---

## 5. Creating a custom field

**Goal:** add a field to an object. This is **gated** — and the gate fires before
field validation.

### With the gate closed (default)

```json
{
  "name": "sf_create_custom_field",
  "arguments": {
    "sobject": "Account",
    "name": "Renewal_Date",
    "label": "Renewal Date",
    "type": "Text",
    "length": 50
  }
}
```

**Actual output:**

```
Refusing to create a custom field. Schema changes are gated behind
MC_NEXT_ALLOW_METADATA_CHANGES=true (default false).
```

### With the gate open

Set `MC_NEXT_ALLOW_METADATA_CHANGES=true` and restart. Now field-type validation
applies:

**Actual outputs for invalid inputs:**

```
Field type "Text" requires a `length` (e.g. 255 for Text).
```

```
Field type "Currency" requires both `precision` and `scale`.
```

```
Field type "Picklist" requires a non-empty `picklistValues` array.
```

A valid call:

```json
{
  "name": "sf_create_custom_field",
  "arguments": {
    "sobject": "Account",
    "name": "Renewal_Date",
    "label": "Renewal Date",
    "type": "Date"
  }
}
```

**Expected output shape:**

```json
{
  "id": "00N...",
  "success": true,
  "fullName": "Account.Renewal_Date__c"
}
```

> **Asynchronous.** The Tooling API returns as soon as it accepts the request. The
> field may take seconds to become visible — re-check with `sf_describe_object`
> before assuming failure.

**To find the Tooling Id later** (needed for deletion):

```json
{
  "name": "sf_list_custom_fields",
  "arguments": { "sobject": "Account" }
}
```

**Common errors**

| Symptom | Cause |
| --- | --- |
| Gate refusal | `MC_NEXT_ALLOW_METADATA_CHANGES` not `true` |
| `requires a length` | Text-type field without `length` |
| `requires both precision and scale` | Numeric field missing one |
| Field not visible yet | Normal Tooling API propagation delay |

---

## 6. Bulk creating and updating records

**Goal:** create many records efficiently.

### Bulk create

```json
{
  "name": "sf_bulk_create_records",
  "arguments": {
    "sobject": "Account",
    "records": [
      { "Name": "Acme" },
      { "Name": "Globex" },
      { "Name": "Initech" }
    ]
  }
}
```

**Expected output shape:**

```json
{
  "sobject": "Account",
  "requested": 3,
  "batches": 1,
  "succeeded": 3
}
```

### Automatic chunking — an important behaviour

You do **not** need to split large inputs. The bulk tools accept an arbitrarily
large `records` array and split it internally into batches of **200**, issuing one
call per batch:

```json
{
  "sobject": "Account",
  "requested": 450,
  "batches": 3,
  "succeeded": 448
}
```

Read `succeeded` against `requested`. A mismatch means some records failed within
a batch — the per-record results are in the response payload.

> **The 200-record cap is per call, and the server handles it for you.** This
> differs from the Composite API's raw limit; `sf_composite` caps at **25**
> subrequests and does not auto-chunk.

### Bulk update

```json
{
  "name": "sf_bulk_update_records",
  "arguments": {
    "sobject": "Account",
    "records": [
      { "Id": "001000000000001AAA", "Name": "Acme (renamed)" }
    ]
  }
}
```

### Bulk delete — gated

```json
{
  "name": "sf_bulk_delete_records",
  "arguments": {
    "sobject": "Account",
    "ids": ["001000000000001AAA", "001000000000002AAA"]
  }
}
```

**Actual output with the gate closed:**

```
Refusing to delete 2 Account record(s). Set MC_NEXT_ALLOW_DESTRUCTIVE=true to enable ...
```

**Id validation** runs before anything is sent:

```json
{
  "name": "sf_bulk_delete_records",
  "arguments": { "sobject": "Account", "ids": ["not-a-real-id", "also-bad"] }
}
```

**Actual output:**

```
2 value(s) are not valid Salesforce Ids: not-a-real-id, also-bad
```

### Mixed operations with composite

`sf_composite` batches mixed subrequests (max 25), each needing a `referenceId`:

```json
{
  "name": "sf_composite",
  "arguments": {
    "compositeRequest": [
      { "method": "POST", "url": "/services/data/v66.0/sobjects/Account", "referenceId": "newAcct", "body": { "Name": "Acme" } },
      { "method": "GET", "url": "/services/data/v66.0/sobjects/Account/@{newAcct.id}", "referenceId": "readBack" }
    ]
  }
}
```

Omitting `referenceId` produces:

```
MCP error -32602: Input validation error: Invalid arguments for tool sf_composite:
Required at compositeRequest[0].referenceId
```

A composite containing any `DELETE` is refused unless the destructive gate is open:

```
Refusing to run a composite request containing DELETE. Set ...
```

---

## Error handling patterns

### Pattern 1 — Safety-gate refusals

Both gates default to closed. A refusal is a **success-shaped error**: the tool
returns `isError: true` with a message naming the exact flag.

```
Refusing to call destructive endpoint "content.delete-an-email"
(DELETE /connect/cms/contents/variants/:variantId). Set
MC_NEXT_ALLOW_DESTRUCTIVE=true to enable DELETE and destructive actions.
```

**Handling:** do not retry. Either this operation should not run, or a human must
deliberately open the gate and restart the server. The gates are read at startup,
so setting the variable at runtime has no effect.

### Pattern 2 — Wrong verb for an endpoint

Calling `mcnext_query` on a `create` endpoint:

**Actual output:**

```
Endpoint "content.create-an-email-with-html" is of kind "create"
(POST /connect/cms/contents), which is not valid for this tool.
Expected one of: query. Use mcnext_describe_endpoint to inspect it.
```

**Handling:** switch to the verb matching the kind — `create` → `mcnext_create`.

### Pattern 3 — Unknown endpoint id

**Actual output:**

```
Unknown endpoint id "content.create-an-email-templat". Did you mean:
content.create-an-email-template-with-components,
content.create-an-email-template-with-html,
content.create-an-email-with-html,
content.create-an-email-with-components,
content.create-a-workspace? Use mcnext_list_endpoints to browse.
```

**Handling:** the suggestions are usually right — pick one. This is a good reason
to let the model discover ids rather than you hardcoding them.

### Pattern 4 — Authentication failures

**Actual output** (verified with deliberately invalid credentials):

```
OAuth token request failed (HTTP 400): client identifier invalid. Verify
SF_CLIENT_ID / SF_CLIENT_SECRET and that the Connected App has the required
scopes enabled (e.g. sfdc_cms_api, cdp_query_api, cdp_profile_api,
cdp_ingest_api) and that client-credentials flow is permitted.
```

The message enumerates the likely causes in order of frequency. Map them:

| Message fragment | Likely cause | Fix |
| --- | --- | --- |
| `client identifier invalid` | Wrong id/secret, or trailing whitespace | Re-copy both values |
| `unsupported_grant_type` | Client Credentials Flow not enabled | Enable it on the Connected App |
| `invalid_grant` | Run As user missing or inactive | Set a valid Run As user |
| `invalid_scope` | Scope unavailable in this org/edition | Check entitlements |

**Handling:** do not retry — the credentials are wrong and will stay wrong. See
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#troubleshooting).

### Pattern 5 — HTTP status hints

Catalog-driven calls attach a hint. The full set:

| Status | Hint |
| --- | --- |
| `400` | Check required query params and body field names/types |
| `401` | Verify credentials and the client-credentials flow |
| `403` | The Connected App or user may lack the required scope |
| `404` | Verify the record id/key exists in this org/tenant |
| `405` | Method not allowed for this path |
| `429` | Rate limited — retry later or reduce call volume |
| `5xx` | Server error from Salesforce — safe to retry |

### Pattern 6 — Rate limiting (429) and retries

The server retries `429`, `500`, `502`, `503`, `504` automatically:

- Honours a numeric `Retry-After` header when present.
- Otherwise exponential backoff: `min(2^attempt × 500ms, 15s)`.
- Bounded by `MC_NEXT_MAX_RETRIES` (default **3**).

So a `429` reaching you means retries were **exhausted**. Options:

1. **Wait.** Salesforce limits are typically per 24h rolling window.
2. **Reduce call volume.** Cache describe results in your own workflow; the server
   does not cache responses, so repeated `sf_describe_object` calls each cost an
   API request.
3. **Batch.** Use `sf_bulk_*` (auto-chunked at 200) or `sf_composite` (25
   subrequests) instead of many single-record calls.
4. **Check `sf_org_limits`** to see remaining allowance.

Raising `MC_NEXT_MAX_RETRIES` only delays the failure; it does not prevent it.

### Pattern 7 — Input validation errors

Zod validation failures come back as protocol-level errors naming the missing
field:

```
MCP error -32602: Input validation error: Invalid arguments for tool sf_soql_query:
Required at soql
```

**Handling:** the field name is in the message. For catalog tools, prefer
`mcnext_describe_endpoint` over guessing.

### Pattern 8 — Validation ordering

Order matters when debugging. For metadata tools the sequence is:

```
1. Metadata gate check      → refusal if closed
2. Field-type validation    → error if invalid
3. API call
```

So with the gate closed you will **never** see a field-type error, even for
genuinely invalid input. Open the gate (in a sandbox) to reach step 2.

For catalog tools:

```
1. Unknown id?              → suggestions
2. Kind mismatch?           → error naming the expected kinds
3. Destructive + gate shut? → refusal
4. Network call
```

All three checks happen **before** any network call, so a refused operation can
never partially execute.

---

## Debugging your own examples

Enable request logging and read stderr:

```json
{ "env": { "MC_NEXT_DEBUG": "true" } }
```

You will see each request and the token acquisition:

```
[mc-next-mcp] mc-next-mcp-server v1.0.0 running on stdio
[mc-next-mcp] catalog: 445 endpoints / 44 groups / 3 families
[mc-next-mcp] POST https://login.salesforce.com/services/oauth2/token (grant_type=client_credentials)
[mc-next-mcp] GET https://my-org.my.salesforce.com/services/data/v66.0/...
```

To confirm what the server currently believes about its own configuration, read
the `mcnext://overview` resource — it reports whether credentials are configured
and whether any base URL is still a placeholder.

For log locations per client, see
[DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md#logging).

---

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the tools are shaped this way
- [POSTMAN-COLLECTIONS.md](POSTMAN-COLLECTIONS.md) — where endpoint ids come from
- [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md) — fixing auth errors
- [SECURITY.md](../SECURITY.md) — what the gates do and do not protect
