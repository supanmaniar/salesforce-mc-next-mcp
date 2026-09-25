# Security Policy

This document describes the security model of `mc-next-mcp-server`: what it
protects, what it explicitly does **not** protect, and how to report a
vulnerability.

The guiding principle is honesty. Where a guarantee is partial, it is stated as
partial rather than glossed over.

---

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and steps to reproduce.

Please include, where relevant:

- A description of the vulnerability and its impact
- Reproduction steps or a proof of concept
- The affected version (or commit)
- Any suggested remediation

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | Within 5 business days |
| Initial assessment | Within 10 business days |
| Fix or mitigation for confirmed issues | As soon as is practical, coordinated with you |

This is a volunteer-maintained project, so these are good-faith targets rather
than contractual guarantees. Please allow reasonable time before public
disclosure, and we will credit you in the release notes unless you prefer
otherwise.

### In scope

- Credential leakage (secrets written to logs, stdout, or files)
- Bypass of either safety gate
- Injection into request construction (path, query, or header)
- Dependency vulnerabilities with a demonstrated exploit path
- Anything that lets a destructive operation execute with the gates closed

### Out of scope

- Vulnerabilities in Salesforce itself, or in the Salesforce APIs
- Misconfiguration by the operator (wrong URLs, over-broad scopes, secrets in a
  committed config file)
- The fact that enabling the safety gates permits destructive operations — that
  is the documented, intended behaviour
- Attacks requiring an already-compromised local machine or an attacker who can
  already read your environment variables
- Social engineering

---

## Threat model

### What this server is

A **local, stdio-transported MCP server** that proxies requests to Salesforce
APIs using a single OAuth 2.0 client-credentials token. It is launched by an MCP
client (VS Code, Claude Desktop, a CLI) as a child process on the user's machine.

### Trust boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│ TRUSTED: the local machine                                          │
│                                                                     │
│  ┌────────────────┐   stdio (JSON-RPC)   ┌──────────────────────┐   │
│  │  MCP client    │ ◄──────────────────► │ mc-next-mcp-server   │   │
│  │  (VS Code,     │                      │  (this project)      │   │
│  │   Claude)      │                      │                      │   │
│  └────────────────┘                      │  • holds credentials │   │
│                                          │  • holds the token   │   │
│                                          └──────────┬───────────┘   │
└─────────────────────────────────────────────────────┼───────────────┘
                                                      │ HTTPS + Bearer
                                                      ▼
                                        ┌──────────────────────────────┐
                                        │ SALESFORCE (external)        │
                                        │  • authorizes every request  │
                                        │  • enforces FLS / sharing    │
                                        └──────────────────────────────┘
```

**The critical assumption:** the MCP client and the local machine are trusted.
The server does not defend against a malicious client, because a client that can
launch the server can also read its environment variables and invoke any tool.

### What this server DOES protect against

| Threat | How |
| --- | --- |
| Accidental data destruction | `MC_NEXT_ALLOW_DESTRUCTIVE` blocks 63 destructive operations |
| Accidental schema changes | `MC_NEXT_ALLOW_METADATA_CHANGES` blocks custom object/field create+delete |
| Credential leakage into logs | The client secret and bearer token are never logged |
| Credential leakage into stdout | Nothing is written to stdout except MCP protocol frames |
| Credential leakage into the repo | `.env` is gitignored; no credential is persisted by the server |
| Eavesdropping in transit | All Salesforce traffic is HTTPS (TLS) |
| Unauthorized data access | Every request is authorized by Salesforce, not by this server |

### What this server does NOT protect against

Be explicit about these. They are the honest limits of the design.

| Not protected | Why / what it means |
| --- | --- |
| **A malicious MCP client** | It can read your env vars, call any tool, and set the gate flags at launch. The server cannot distinguish a well-behaved client from a hostile one. |
| **A compromised local machine** | Credentials live in the process environment. Anyone who can read the process environment has your Connected App credentials. |
| **Over-privileged credentials** | The server faithfully executes whatever the Connected App is permitted to do. If the integration user is an admin, the server is effectively an admin. |
| **Prompt injection** | A model instructed by hostile content (e.g. a malicious record body it reads) can be steered into calling tools. The safety gates limit blast radius, but there is no semantic validation of *intent*. |
| **Rate-limit abuse** | There is no request budget. The server will issue calls until Salesforce refuses them. |
| **Input sanitization of business data** | Request bodies are passed through to Salesforce. The server is not a data-validation layer; Salesforce is the authority. |
| **Multi-tenancy** | One process serves one org. There is no per-user isolation within a process. |
| **Audit non-repudiation** | Debug logs are opt-in, local, and tamperable. They are not a compliance-grade audit trail. |
| **Data residency / DLP** | No data classification, redaction, or residency controls are applied. |
| **Supply chain** | Beyond pinning via the lockfile and `npm audit`, there is no SBOM, signing, or provenance attestation. |

---

## Data in motion

### Transport security

All communication with Salesforce uses **HTTPS**:

- The OAuth token request goes to `SF_LOGIN_URL` (default
  `https://login.salesforce.com`) over TLS.
- Every API call goes to your configured base URLs over TLS.

TLS certificate validation uses the Node.js runtime's default trust store. There
is **no option to disable certificate verification** — the server has no
"insecure" flag, by design.

### Where data flows

| Direction | Content |
| --- | --- |
| Client → server | Tool name, arguments (including any request bodies you supply) |
| Server → Salesforce | The same, plus the bearer token in the `Authorization` header |
| Salesforce → server | API responses (may contain org data) |
| Server → client | Response payloads, truncated at 100,000 characters |

### Local transport (stdio)

Client↔server communication is **stdio** — a pipe between parent and child
process, not a network socket. It is not encrypted, and does not need to be:
it does not cross a network boundary, and anything able to read it already has
equivalent local access.

**There is no HTTP/SSE transport.** The server opens no port, so there is no
network listener to secure — and, correspondingly, no way to expose it as a
shared remote service.

### OAuth token scope boundaries

A **single** client-credentials token is shared across all three API families.
This is a deliberate design choice with a security consequence:

- The token carries the union of every scope enabled on the Connected App.
- The server **does not** re-check scope per call. If a scope is enabled, every
  tool can use it.
- Therefore the token's effective authority is the **broadest** scope granted,
  for **every** API family.

**Mitigation:** enable only the scopes you need. A token for a CMS-only
integration should not carry `cdp_*` scopes. See the
[scope mapping](docs/SALESFORCE-CONNECTED-APP-GUIDE.md#scope--capability-mapping).

The token is also **not scoped to a subset of endpoints**. Scope granularity is
per API family, not per resource.

---

## Data at rest

### The server persists nothing

This is a hard property of the implementation:

| Data | Where it lives | Persisted? |
| --- | --- | --- |
| Client secret | Process environment | ❌ In memory only |
| Access token | `TokenManager` in-memory cache | ❌ Lost on exit |
| API responses | Returned to the client, then discarded | ❌ Not cached |
| Debug logs | stderr (if `MC_NEXT_DEBUG=true`) | ⚠️ Wherever stderr goes |
| Catalog | `catalog/endpoints.json` (read-only) | ✅ Committed, non-sensitive |

Specifically:

- **No token cache file.** Tokens are cached in memory and never written to disk.
- **No `.env` auto-loading.** The server reads the *process environment*. A `.env`
  file is a convenience for how you supply that environment, not something the
  server reads.
- **No response caching.** Every call hits Salesforce.
- **No local database, no temp files, no state directory.**
- The only file the server *reads* is `catalog/endpoints.json`, which contains
  public API metadata — no credentials, no org data.

**Consequence:** restarting the server always means a cold start, and killing the
process leaves no credential material behind. This is why the server is safe to
run from a container with no writable volume.

### The one place data can land on disk

`MC_NEXT_DEBUG=true` writes request lines to **stderr**. If stderr is redirected
to a file (as the [deployment guide](docs/DEPLOYMENT-GUIDE.md#capturing-stderr)
shows for systemd), those lines are persisted.

Logged request lines include **full URLs**, which may contain record IDs and query
strings. They do **not** include the bearer token or client secret — this is
verified behaviour, not an aspiration:

```bash
# Verified: with MC_NEXT_DEBUG=true and a known fake secret in the environment,
# the secret does not appear anywhere in stderr output.
```

Treat debug logs as potentially sensitive, and redact before sharing them
publicly.

---

## Authentication

### The flow

OAuth 2.0 **client-credentials**, and nothing else.

```
POST {SF_LOGIN_URL}/services/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={SF_CLIENT_ID}
&client_secret={SF_CLIENT_SECRET}
```

The resulting bearer token is attached to every subsequent API request.

### What is not supported

| Flow | Supported |
| --- | --- |
| Client credentials | ✅ |
| Authorization code | ❌ |
| Implicit | ❌ (the source Data 360 collections use it; the server converts them) |
| JWT bearer | ❌ |
| Username/password | ❌ |
| Interactive / browser login | ❌ |

### Identity: one integration user, no impersonation

**Every call runs as the Connected App's "Run As" integration user.**

- There is **no per-user identity**. The server does not know who is sitting at
  the MCP client.
- There is **no impersonation**. You cannot say "run this as alice@example.com".
- There is **no per-request identity propagation**.

**This is the most important security property to understand.** The model
effectively acts with the integration user's permissions, regardless of who
prompted it. Two consequences:

1. **Salesforce sharing rules and field-level security apply to the integration
   user**, not to the human. A user who cannot see an object in the Salesforce UI
   may still see it through this server, if the integration user can.
2. **Least privilege for the integration user is the primary control you have.**
   It is more important than any flag in this server.

### Token lifecycle

| Property | Value |
| --- | --- |
| Lifetime | Salesforce-defined, typically ~2 hours |
| Storage | In memory only |
| Refresh strategy | Proactively refreshed 60s before expiry |
| On `401` | One transparent refresh-and-retry |
| On restart | Always re-authenticated (cold start) |
| Concurrent refreshes | De-duplicated (one request, not many) |
| Expiry without revocation | A leaked secret does **not** expire on its own |

Because client-credentials secrets have no automatic expiry, **rotation is the
only way to invalidate a leaked secret.** See
[rotation](docs/SALESFORCE-CONNECTED-APP-GUIDE.md#rotation).

---

## Authorization

**This server implements no authorization of its own.**

It performs no role checks, no per-user ACLs, no object-level or field-level
filtering, and no data classification. It is a transparent proxy.

Authorization is delegated entirely to Salesforce:

| Control | Enforced by |
| --- | --- |
| Object and field permissions | Salesforce (profiles, permission sets) |
| Field-level security (FLS) | Salesforce |
| Record-level sharing | Salesforce |
| Org-wide defaults | Salesforce |
| API access and scope grants | Salesforce (Connected App scopes) |
| Rate limits and quotas | Salesforce |

**Practical implication:** the server cannot grant access the integration user
lacks, and it cannot restrict access the integration user has. If you need a
boundary, set it in Salesforce.

The only access control the server adds is the pair of **safety gates** below,
which are about *reversibility*, not about *who* can do something.

---

## Safety gates

Two **independent** boolean flags, both defaulting to `false`. Neither implies the
other. They are the server's only built-in guardrails.

### `MC_NEXT_ALLOW_DESTRUCTIVE` (default `false`)

Blocks operations that **destroy data**. When closed, the server refuses:

| Blocked | Count | Enforced at |
| --- | --- | --- |
| Catalog endpoints flagged `destructive` | **63** | `src/tools.ts` |
| `DELETE` via `sf_rest_request` | — | `src/platform.ts` |
| `sf_delete_record` | — | `src/records.ts` |
| `sf_bulk_delete_records` | — | `src/records.ts` |
| `sf_composite` containing any `DELETE` | — | `src/records.ts` |

The refusal happens **before any network call is made**, so a blocked operation
cannot partially execute.

### `MC_NEXT_ALLOW_METADATA_CHANGES` (default `false`)

Blocks operations that change **org schema**. When closed, the server refuses:

| Blocked | Enforced at |
| --- | --- |
| `sf_create_custom_object` | `src/metadata.ts` |
| `sf_create_custom_field` | `src/metadata.ts` |
| `sf_delete_custom_object` | `src/metadata.ts` |
| `sf_delete_custom_field` | `src/metadata.ts` |

Gated separately because schema changes are materially harder to reverse than a
record delete: deleting a custom field destroys its data, and deleting an object
destroys all of its records.

### ⚠️ What the gates do NOT do — read this

**The server is NOT read-only by default.** This is a common and dangerous
misconception.

Of the 445 catalog endpoints:

| | Endpoints | Default behaviour |
| --- | --- | --- |
| Destructive (blocked) | **63** | ❌ Refused |
| All other endpoints | **382** | ✅ **Allowed** |

Among the 382 allowed endpoints are **180 non-destructive writes**:

| Kind | Allowed by default |
| --- | --- |
| `create` | 103 |
| `update` | 45 |
| `action` | 32 |

So with the default configuration, a model can still **create and update records
and content** — it simply cannot delete them or change schema. That is a
meaningful guardrail against irreversible mistakes, but it is **not** read-only.

Additional gaps to be aware of:

- **`sf_rest_request` allows arbitrary POST/PATCH/PUT** on any
  `/services/data/...` path by default. Only `DELETE` is gated. This is a broad
  capability — it is a deliberate escape hatch for endpoints outside the catalog,
  but it means the catalog's `destructive` flag is not the whole story for the
  core org.
- **`action` endpoints are semantic, not syntactic.** 32 non-destructive actions
  are allowed. Some "non-destructive" actions still have side effects (e.g.
  triggering a flow, publishing content).
- **Gates are launch-time configuration.** They are read from the environment at
  startup. Changing them requires restarting the server.
- **No dry-run or confirmation step.** Once a gate is open, calls execute
  immediately.

### Recommended posture

| Environment | `ALLOW_DESTRUCTIVE` | `ALLOW_METADATA_CHANGES` |
| --- | --- | --- |
| Production | `false` | `false` |
| Sandbox | `false` (enable briefly, when needed) | `false` |
| Dedicated dev org | your call | your call |

> **Enable destructive or metadata changes at your own risk.** Doing so converts
> a model mistake into permanent data or schema loss. Neither flag has an undo,
> and neither is a substitute for a backup or for least-privilege credentials.

---

## Secrets management

### What is a secret here

| Value | Secret? | Why |
| --- | --- | --- |
| `SF_CLIENT_SECRET` | 🔴 **Yes** | Grants full access as the integration user |
| `SF_CLIENT_ID` | 🟡 Semi | An identifier, but not public — treat as sensitive |
| Access token | 🔴 **Yes** | Derived; never persisted by the server |
| Base URLs | 🟢 No | Org hostnames |
| `MC_NEXT_*` flags | 🟢 No | Configuration |

### How to supply credentials

**Preferred: the MCP client's `env` block.**

```json
{
  "mcpServers": {
    "mc-next": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "...",
        "SF_CLIENT_SECRET": "..."
      }
    }
  }
}
```

**For a committed workspace config: use VS Code `inputs`.** This prompts once and
stores the value in the OS keychain rather than in the file — see
[VS-CODE-SETUP.md](docs/VS-CODE-SETUP.md#using-input-variables-for-secrets).

**For local runs: `envFile` or `--env-file`,** with `.env` gitignored (it already
is).

### Rules

1. **Never commit credentials.** Not in `mcp.json`, not in a Dockerfile `ENV`,
   not in a Compose file, not in a workflow YAML.
2. **Never pass a secret as a command-line argument.** `docker run -e SECRET=...`
   and similar are visible in `docker inspect` and shell history. Use
   `--env-file`.
3. **Never log a secret.** The server does not, and contributions that do will be
   rejected.
4. **Restrict file permissions** on any config file containing credentials
   (`chmod 600`).
5. **One Connected App per environment** (dev / sandbox / production), so
   revocation is surgical.
6. **Rotate on a schedule.** Secrets do not expire on their own.
7. **Use a least-privilege integration user.** This is the strongest control
   available — stronger than the safety gates.

### In CI

Use repository or **environment** secrets, never literals in the workflow. Gate
live-org tests behind a branch check and point them at a sandbox. The smoke test
needs no credentials at all, so most CI should never touch a real secret. See
[DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md#github-actions).

---

## Third-party dependencies

### Direct dependencies

Deliberately minimal — **two** runtime dependencies:

| Package | Version | Purpose |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `^1.12.0` | MCP protocol implementation |
| `zod` | `^3.23.8` | Runtime input-schema validation for tool arguments |

Dev-only: `typescript`, `@types/node`.

### Transitive dependencies — the honest picture

The direct list is small, but `@modelcontextprotocol/sdk` pulls in a substantial
tree. As installed at v1.0.0:

| Measure | Count |
| --- | --- |
| Direct production dependencies | **2** |
| Total production packages (incl. transitive) | **94** |
| Total packages (incl. dev) | **97** |

Notable transitive packages include `express`, `hono`, `ajv`, `cors`, and
`eventsource` — they arrive via the SDK's multi-transport support, even though
this server only uses stdio.

**So "minimal dependencies" is true of what we *declare*, not of what gets
*installed*.** Judge the supply-chain surface by the transitive count.

### Current audit status

```bash
npm audit          # 0 vulnerabilities (verified at v1.0.0)
npm audit --omit=dev   # 0 vulnerabilities
```

### Security cadence

- **Lockfile is committed** (`package-lock.json`), so installs are reproducible
  and pinned. `npm ci` is used in the Dockerfile for this reason.
- **No automatic update bot is configured.** Dependabot or Renovate would be a
  welcome contribution.
- **Run `npm audit` before releases** and after any dependency bump.
- **Review the SDK changelog** when bumping `@modelcontextprotocol/sdk` — it is
  the dominant part of the dependency tree.
- **No SBOM or artifact signing** is produced today.
- There is **no CI workflow** running `npm audit` on a schedule yet.

### Trust assumptions

The server trusts its dependencies, the Node.js runtime, and the OS trust store.
It performs no runtime integrity verification of any of them.

---

## Additional limitations

Things a security reviewer should know that do not fit the sections above:

- **No automated testing against a live org.** The smoke test asserts the tool
  surface, both gates, and validation paths without credentials. Live behaviour
  is unverified by CI.
- **No input validation beyond schema shape.** Tool arguments are validated by
  Zod for *type and shape*, not for *semantics or safety*. A well-typed request
  can still be a destructive one.
- **Error messages may echo response content.** Salesforce error bodies are
  surfaced to the client and may appear in logs, potentially including data from
  the org.
- **Response truncation at 100,000 characters.** Truncation is silent apart from a
  `truncated` flag — be aware data may be clipped.
- **No request-level tracing or correlation IDs**, which complicates incident
  analysis.
- **`stdio` only** means the server cannot be centrally governed; each client
  launches its own instance with its own configuration.

---

## Security-relevant design decisions

For transparency, these were deliberate choices:

| Decision | Rationale | Trade-off |
| --- | --- | --- |
| Client-credentials only | Works unattended; no browser | Single shared identity, no per-user audit |
| One token for all families | Simplicity; all families share an org | Token carries the union of scopes |
| Two separate gates | Schema changes are harder to reverse than deletes | More configuration to get right |
| Gates default closed | Fail safe on the irreversible | Non-destructive writes still allowed |
| No response caching | Always-fresh data | Every call costs an API request |
| stdout reserved for protocol | Prevents stream corruption | All diagnostics must go to stderr |
| No HTTP transport | No network listener to secure | Cannot be hosted as a shared service |
| `sf_rest_request` escape hatch | Covers endpoints outside the catalog | Broad POST/PATCH/PUT capability |

---

## Summary for reviewers

**Protects:** accidental destruction (63 ops), accidental schema change, credential
leakage into logs/stdout/disk, transit eavesdropping.

**Does not protect:** a malicious client, a compromised machine, prompt injection,
over-privileged credentials, non-destructive writes (180 are allowed by default),
or anything about *who* is asking.

**The three controls that actually matter:**

1. **A least-privilege integration user** — the real authorization boundary.
2. **Scope minimization** on the Connected App — bounds the token's authority.
3. **The safety gates** — bound reversibility, but do not make the server
   read-only.

---

## See also

- [SALESFORCE-CONNECTED-APP-GUIDE.md](docs/SALESFORCE-CONNECTED-APP-GUIDE.md) — scopes, secrets, rotation
- [DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md) — logging, multi-org, CI secrets
- [README.md](README.md#limitations) — functional limitations
- [CONTRIBUTING.md](CONTRIBUTING.md#safety-rules-non-negotiable) — the safety invariants
