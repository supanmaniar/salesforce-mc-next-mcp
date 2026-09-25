# mc-next-mcp-server

[![CI](https://img.shields.io/github/actions/workflow/status/supanmaniar/salesforce-mc-next-mcp/ci.yml?branch=main&label=CI)](https://github.com/supanmaniar/salesforce-mc-next-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/supanmaniar/salesforce-mc-next-mcp)](https://github.com/supanmaniar/salesforce-mc-next-mcp/releases)
[![License](https://img.shields.io/github/license/supanmaniar/salesforce-mc-next-mcp)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Endpoints](https://img.shields.io/badge/endpoints-445-blue)](catalog/endpoints.json)

<!--
Not yet published to npm, so the npm version/downloads badges are intentionally
absent — shields.io renders "package not found" (red) for an unpublished package.
Add these once `npm publish` has run:

[![npm version](https://img.shields.io/npm/v/mc-next-mcp-server)](https://www.npmjs.com/package/mc-next-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/mc-next-mcp-server)](https://www.npmjs.com/package/mc-next-mcp-server)
-->

An MCP (Model Context Protocol) server that exposes **Salesforce Marketing Cloud Next**, **Data 360**, and **Data 360 Connect** APIs, plus a set of **Salesforce platform tools** inspired by [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded).

The endpoint catalog is generated from the official Salesforce Postman collections, so the tool surface stays in sync with the published API reference.

**At a glance**

- **445 API endpoints** across 3 families and 44 resource groups, driven by a generated catalog
- **30 MCP tools** — 8 catalog-driven, 6 platform, 8 record CRUD, 6 metadata CRUD, 2 maintenance
- **Two Salesforce hosts** — core org (Marketing Cloud Next + platform) and Data 360 tenant
- **One OAuth token** — client credentials, shared across every family
- **Two safety gates** — destructive operations and schema changes are off by default
- **No credentials needed** to browse the catalog or run the smoke test
- **Optional HTTP transport** — off by default; stdio is the default and the safer mode

## Quick Start

Get the server running and verified in about five minutes. **No Salesforce org is
required for steps 1–4** — the catalog tools work without credentials, so you can
confirm the wiring before you set up authentication.

### 1. Clone and install

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Verify — no credentials needed

```bash
npm run smoke
```

This connects to the built server over stdio as a real MCP client and asserts the
tool surface, both safety gates, and the validation paths. You should see
`✔ smoke test complete — all assertions passed`.

If this passes, the server is healthy and any remaining problem is configuration.

### 4. Try it without credentials

The server starts fine with no credentials — it warns on stderr and only fails
when you make an API call. Point your MCP client at it and ask:

```
List the endpoints available for publishing an email.
```

```
What API families and resource groups does the mc-next server cover?
```

### 5. Add credentials

To make real API calls you need a Salesforce Connected App. Set these environment
variables (in your MCP client's `env` block):

```json
{
  "env": {
    "SF_CLIENT_ID": "your_connected_app_consumer_key",
    "SF_CLIENT_SECRET": "your_connected_app_consumer_secret",
    "MC_NEXT_API_BASE_URL": "https://my-org.my.salesforce.com/services/data/v66.0",
    "DATA360_TENANT_URL": "https://my-tenant.c360a.salesforce.com",
    "DATA360_CONNECT_BASE_URL": "https://my-tenant.c360a.salesforce.com/services/data/v66.0"
  }
}
```

For a quick local test, a `.env` file works too:

```bash
cp .env.example .env
# edit .env, then:
node --env-file=.env dist/index.js
```

### 6. Wire up your client

| Client | Guide |
| --- | --- |
| **VS Code + GitHub Copilot** | [docs/VS-CODE-SETUP.md](docs/VS-CODE-SETUP.md) |
| **Claude Desktop** | [docs/CLAUDE-DESKTOP-SETUP.md](docs/CLAUDE-DESKTOP-SETUP.md) |
| **Connected App creation** | [docs/SALESFORCE-CONNECTED-APP-GUIDE.md](docs/SALESFORCE-CONNECTED-APP-GUIDE.md) |

> **Safety default:** destructive operations and schema changes are both **off**.
> The gates block the 63 destructive endpoints, but the server is **not read-only**
> — see [SECURITY.md](SECURITY.md#-what-the-gates-do-not-do--read-this).

### Where to go next

| I want to… | Read |
| --- | --- |
| Understand how the server is put together | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| See worked examples with real tool calls | [docs/EXAMPLES.md](docs/EXAMPLES.md) |
| Understand or regenerate the catalog | [docs/POSTMAN-COLLECTIONS.md](docs/POSTMAN-COLLECTIONS.md) |
| Deploy it (Docker, multi-org, monitoring) | [docs/DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md) |
| Review the security model | [SECURITY.md](SECURITY.md) |

## What it covers

| API family | Endpoints | Source collection |
| --- | --- | --- |
| `mc-next` — Marketing Cloud Next (Content / CMS) | 27 | Salesforce Marketing Cloud Next APIs |
| `data360` — Data 360 core | 35 | Salesforce Data 360 APIs |
| `data360-connect` — Data 360 Connect | 383 | Salesforce Data 360 Connect APIs |
| **Total** | **445** across 44 groups | |

Plus Salesforce platform tools: SOQL query, object list/describe, generic REST explorer, org limits, and full **record + object CRUD**.

## How it works across Salesforce products

The server spans **two different Salesforce hosts**, which is the single most important thing to understand about it. Marketing Cloud Next lives on your **core org**; Data 360 lives on a **separate tenant host**.

```
                        ┌──────────────────────────────────────┐
   one OAuth token ───► │  login.salesforce.com                │
   shared by every      │  SF_LOGIN_URL                        │
   API family           │  POST /services/oauth2/token         │
                        └──────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┴───────────────────────────────┐
        │                                                               │
        ▼                                                               ▼
┌──────────────────────────┐                    ┌──────────────────────────────────┐
│  CORE ORG HOST           │                    │  DATA 360 TENANT HOST            │
│  my-org.my.salesforce.com│                    │  my-tenant.c360a.salesforce.com  │
│                          │                    │                                  │
│  MC_NEXT_API_BASE_URL    │                    │  DATA360_TENANT_URL              │
│  SF_INSTANCE_URL         │                    │  DATA360_CONNECT_BASE_URL        │
│                          │                    │                                  │
│  ┌────────────────────┐  │                    │  ┌────────────────────────────┐  │
│  │ mc-next       (27) │  │                    │  │ data360            (35)    │  │
│  │ Content / CMS      │  │                    │  │ Query, Profile, Ingestion, │  │
│  │                    │  │                    │  │ Metadata, Data Graphs      │  │
│  ├────────────────────┤  │                    │  ├────────────────────────────┤  │
│  │ sf_* platform      │  │                    │  │ data360-connect   (383)    │  │
│  │ SOQL, describe,    │  │                    │  │ Activations, Segments,     │  │
│  │ REST, limits       │  │                    │  │ Streams, Connections, ML,  │  │
│  ├────────────────────┤  │                    │  │ Governance, Clean Rooms…   │  │
│  │ sf_* record CRUD   │  │                    │  └────────────────────────────┘  │
│  │ sf_* metadata CRUD │  │                    │                                  │
│  └────────────────────┘  │                    │                                  │
└──────────────────────────┘                    └──────────────────────────────────┘
```

The platform and CRUD tools only ever talk to the **core org host**. The catalog-driven `mcnext_*` tools pick their host per endpoint, based on the endpoint's `base` key.

### Product-by-product coverage

| Salesforce product | Host | Endpoints | What you can do |
| --- | --- | --- | --- |
| **Marketing Cloud Next** (Content / CMS) | Core org | 27 | Search content, manage workspaces, create/update/publish/clone emails and email templates |
| **Data 360** — Query & Insights | Tenant | 8 | Query API V1 & V2, Query Unified Record ID, Calculated Insights |
| **Data 360** — Profile, Ingestion, Metadata & Auth | Tenant | 27 | Profile API, Ingestion API (incl. CSV bulk upload), Metadata API, Data Graph API, Auth |
| **Data 360 Connect** — Activation | Tenant | 59 | Activations, Activation Platforms/Targets, External Platforms, Data Actions |
| **Data 360 Connect** — Data | Tenant | 99 | Data Streams, Data Lake/Model Objects, Data Spaces, Data Graphs, Data Transforms, Data Kits, Data Shares, Connections |
| **Data 360 Connect** — Identity & Segments | Tenant | 32 | Identity Resolutions, Universal ID Lookup, Segments, Profile, Search Index, Insights |
| **Data 360 Connect** — AI & Governance | Tenant | 164 | Machine Learning, Document AI, Notebook AI, Agent Configuration, Data Governance, Clean Rooms |
| **Data 360 Connect** — Platform | Tenant | 29 | Metadata, Query (Current), Query V1 & V2, Auth, Limits, Private Network Routes, Connectors, Calculated Insights |
| **Salesforce Platform** (any org) | Core org | n/a | SOQL, object describe, REST explorer, org limits, record CRUD, custom object/field CRUD |

### How a request flows

1. **Discover** — `mcnext_list_endpoints` filters the catalog by family/group/kind/search.
2. **Describe** — `mcnext_describe_endpoint` returns the resolved base URL, path params, query params, and body schema.
3. **Invoke** — the verb tool (`mcnext_query` / `read` / `create` / `update` / `delete` / `action`) resolves the endpoint's `base` key to the right host and sends the request.
4. **Authenticate** — one cached OAuth token is shared by every family; a 401 triggers a single transparent re-auth and retry.

The platform and CRUD tools bypass the catalog entirely and call `/services/data/vXX/...` directly on `SF_INSTANCE_URL`.

## Limitations

These are the honest boundaries of the current implementation.

### Authentication

- **Client credentials only.** The server uses the OAuth 2.0 client-credentials flow. There is no JWT bearer flow, no username/password flow, and no interactive/browser login. A Connected App with the client-credentials flow permitted is required.
- **One identity for everything.** All calls run as the Connected App's integration user. There is no per-user or per-request impersonation, so Salesforce sharing rules and field-level security apply to that single user.
- **One org per server instance.** The base URLs are fixed at startup from environment variables. Pointing at a second org or tenant requires a second server instance.
- **No token persistence.** Tokens are cached in memory only and re-fetched on restart.

### API surface

- **Catalog-driven coverage only.** The 445 endpoints come from the three Postman collections. Anything not in those collections is reachable only through `sf_rest_request` (core org) — there is no equivalent generic passthrough for the Data 360 tenant hosts.
- **No GraphQL.** The Salesforce GraphQL API is not covered.
- **No SOAP.** The Partner/WSDL-based SOAP API is not covered. This matters for one specific case: Inspector's Data Import uses SOAP to set assignment rules, duplicate rules, and owner-change options on inserts. Those options are **not available** here.
- **No Bulk API 2.0.** The `/jobs/ingest` and `/jobs/query` endpoints are not in the catalog. Bulk record work uses the Composite API instead, which caps at **200 records per call** — fine for hundreds of records, not for millions.
- **No Metadata API deploy/retrieve.** There is no `package.xml` generation, no retrieve/deploy jobs, and no destructive-changes deployment. Custom object and field creation goes through the **Tooling API** instead, which is a different mechanism with different limits.
- **No Tooling API passthrough for arbitrary metadata.** `sf_soql_query` and `sf_describe_object` accept a `tooling: true` flag, and the metadata CRUD tools use Tooling endpoints, but there is no general "call any Tooling endpoint" tool.
- **No file uploads.** No endpoint in the catalog uses `multipart/form-data`, so the form-data code path is currently unexercised. The Ingestion API's CSV upload is sent as a raw `text/csv` body, not as a file part.

### Features deliberately not ported

These Inspector features were left out because they depend on a browser session or a UI, not because they were overlooked:

| Inspector feature | Why it's absent |
| --- | --- |
| Data Export / Data Import UI | Browser UI over SOQL/SOAP; the underlying query and CRUD capability *is* available via `sf_soql_query` and the record CRUD tools |
| Debug Logs viewer | Needs log streaming and a viewer; `sf_rest_request` can fetch `ApexLog` bodies but there is no filtering or analysis |
| Event Monitor | Requires a long-lived CometD/streaming subscription, which does not fit a request/response MCP tool |
| Flow Scanner / Object Scanner / Dependencies Explorer | Rule engines over metadata; would need the Metadata API and a rules port |
| Field Creator UI | The *capability* is ported (`sf_create_custom_field`), minus the bulk-import spreadsheet UI |
| Org Limits UI | Ported as `sf_org_limits` |
| REST Explorer UI | Ported as `sf_rest_request` |

### Operational

- **No caching of API responses.** Every tool call hits Salesforce. Repeated `sf_describe_object` calls cost API requests.
- **No rate-limit coordination.** Retries use exponential backoff on 429/5xx, but the server does not track or budget the org's daily API allowance. Check `sf_org_limits` before bulk work.
- **No pagination helper for the catalog tools.** `mcnext_query` returns whatever the API returns; following `nextPageToken`-style cursors is the caller's responsibility. Only SOQL has a dedicated pagination tool (`sf_soql_query_more`).
- **Asynchronous metadata changes.** `sf_create_custom_object` and `sf_create_custom_field` return as soon as the Tooling API accepts the request. The object or field may take seconds to become visible; re-check with `sf_list_objects` / `sf_describe_object`.
- **No write confirmation or dry-run mode.** Tools execute immediately once the safety gates are open. There is no preview step.
- **stdio transport only.** No HTTP/SSE transport, so the server cannot be hosted as a shared remote service.
- **No automated tests against a real org.** The smoke test asserts the tool surface, safety guards, and validation logic without credentials. End-to-end behaviour against a live Salesforce org is unverified.

## Design: why 30 tools instead of 445

Exposing 445 individual MCP tools would bloat the model's context and hurt tool-selection accuracy. Instead the server exposes a small set of **generic, catalog-driven** tools. The model discovers endpoints, then invokes them:

```
mcnext_list_endpoints  ->  mcnext_describe_endpoint  ->  mcnext_query / read / create / update / delete / action
```

### Tools

**Catalog-driven (Marketing Cloud Next / Data 360)**

| Tool | Purpose |
| --- | --- |
| `mcnext_list_endpoints` | Browse/search the 445 endpoints by family, group, kind, method, or free text |
| `mcnext_describe_endpoint` | Full contract for one endpoint: path params, query params, body schema, sample body |
| `mcnext_query` | GET a collection (kind `query`) |
| `mcnext_read` | GET a single record (kind `read`) |
| `mcnext_create` | POST a new record (kind `create`) |
| `mcnext_update` | PATCH/PUT a record (kind `update`) |
| `mcnext_delete` | DELETE a record (kind `delete`) — gated |
| `mcnext_action` | Non-CRUD operations: publish, clone, activate, run, search, resolve, … — some gated |

**Salesforce platform (Inspector-style)**

| Tool | Purpose |
| --- | --- |
| `sf_soql_query` | Run SOQL (data or Tooling API) |
| `sf_soql_query_more` | Paginate via `nextRecordsUrl` |
| `sf_list_objects` | Global describe — list sObjects |
| `sf_describe_object` | Field-level metadata for an sObject |
| `sf_rest_request` | Generic REST explorer for any `/services/data/...` path |
| `sf_org_limits` | Org limits and current API usage |

**Record CRUD** — ported from Inspector's Inspect page and batch patterns

| Tool | Purpose |
| --- | --- |
| `sf_create_record` | Create one record (`POST /sobjects/{SObject}`) |
| `sf_get_record` | Read one record by Id, optionally field-limited |
| `sf_update_record` | Update one record (`PATCH`) |
| `sf_delete_record` | Delete one record — gated |
| `sf_bulk_create_records` | Create up to 200 records per call (`POST /composite/sobjects`) |
| `sf_bulk_update_records` | Update up to 200 records per call (`PATCH /composite/sobjects`) |
| `sf_bulk_delete_records` | Delete up to 200 records per call — gated |
| `sf_composite` | Batched mixed subrequests (`POST /composite`, max 25) |

**Object & field metadata CRUD** — ported from Inspector's Field Creator

| Tool | Purpose |
| --- | --- |
| `sf_create_custom_object` | Create a custom object (Tooling API `CustomObject`) — gated |
| `sf_create_custom_field` | Create a custom field, with optional field-level security — gated |
| `sf_delete_custom_field` | Delete a custom field by Tooling Id — gated |
| `sf_delete_custom_object` | Delete a custom object by Tooling Id — gated |
| `sf_list_custom_objects` | List custom objects with their Tooling Ids |
| `sf_list_custom_fields` | List custom fields with their Tooling Ids |

**Maintenance**

| Tool | Purpose |
| --- | --- |
| `mcnext_cache` | Inspect, clear, or re-tune the response cache (`stats` / `clear` / `ttl` / `off`) |
| `mcnext_poll_job` | Poll a long-running job to completion; read-only (`GET`) endpoints only |

### Resources & prompts

- Resources: `mcnext://catalog` (full catalog), `mcnext://overview` (auth model, bases, stats)
- Prompts: `explore-mc-next`, `explore-salesforce-org`

## Documentation

| Guide | What it covers |
| --- | --- |
| [VS Code + Copilot setup](docs/VS-CODE-SETUP.md) | Prerequisites, `mcp.json` format, verification prompts, troubleshooting |
| [Claude Desktop setup](docs/CLAUDE-DESKTOP-SETUP.md) | Config file locations, `mcpServers` format, logs, Claude Code CLI |
| [Salesforce Connected App guide](docs/SALESFORCE-CONNECTED-APP-GUIDE.md) | Creating the Connected App, scope → capability mapping, secrets, rotation |
| [Deployment guide](docs/DEPLOYMENT-GUIDE.md) | stdio model, env var management, multi-org, logging, monitoring |
| [Docker deployment](docs/DOCKER-DEPLOYMENT.md) | Image build, client integration, why `compose up -d` does not work |
| [Architecture](docs/ARCHITECTURE.md) | Tool taxonomy, request flow, token caching, the two-host model |
| [Examples](docs/EXAMPLES.md) | Worked tool calls and error-handling patterns |
| [Postman collections](docs/POSTMAN-COLLECTIONS.md) | Catalog provenance, regeneration, validation |
| [HTTP deployment](docs/HTTP-DEPLOYMENT.md) | Optional network transport, auth, and its identity limitation |
| [Async operations](docs/ASYNC-OPERATIONS.md) | Polling long-running jobs with `mcnext_poll_job` |
| [Performance](docs/PERFORMANCE.md) | Response caching, TTL tuning, reducing API consumption |
| [Security policy](SECURITY.md) | Threat model, what is and isn't protected, safety-gate gaps, disclosure |
| [Roadmap](ROADMAP.md) | What's planned near-, medium-, and long-term, and how to influence it |

> **Not read-only by default.** The safety gates block the **63 destructive**
> endpoints, but the other **382 — including 180 create/update/action
> endpoints — are allowed**. See [SECURITY.md](SECURITY.md#-what-the-gates-do-not-do--read-this).

## Install

### From a git clone (recommended)

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
npm run build
```

`catalog/endpoints.json` is committed, so `npm run generate` is optional — and it
cannot run without the source Postman collections, which are not in this repo.

### From npm

```bash
npm install -g mc-next-mcp-server
```

Or run it without installing:

```bash
npx mc-next-mcp-server
```

This installs the compiled `dist/` and the generated `catalog/`. You still need a
Salesforce Connected App and the environment variables described in
[Configure](#configure).

> **Not yet published.** The package is prepared for publishing but has not been
> released to the npm registry yet. Until then, use the git clone above. See
> [Publishing](#publishing) for the maintainer checklist.

### With Docker

```bash
docker build -t mc-next-mcp-server:1.0.0 .
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0
```

The `-i` flag is required — the server is stdio-only. See
[Docker deployment](docs/DOCKER-DEPLOYMENT.md).

## Publishing

Maintainers only. The `prepublishOnly` hook runs the build and the catalog audit
before anything is uploaded, so a broken or truncated catalog cannot be published.

```bash
npm login                 # if not already authenticated
npm run prepublishOnly    # build + audit — exactly what the hook runs
npm pack --dry-run        # inspect the contents
npm publish               # publishConfig sets access: public
```

`prepublishOnly` deliberately does **not** run `npm run generate`: regeneration
requires the source Postman collections, which are not in this repository, so it
would fail on a clean checkout.

## Configure

Copy `.env.example` to `.env` and fill in your values. The server reads configuration from the **process environment** — it does not auto-load `.env` files. Use your MCP client's `env` block, or run with `node --env-file=.env dist/index.js`.

### Required

| Variable | Description |
| --- | --- |
| `SF_CLIENT_ID` | Connected App consumer key |
| `SF_CLIENT_SECRET` | Connected App consumer secret |
| `MC_NEXT_API_BASE_URL` | MC Next base incl. `/services/data/vXX` |
| `DATA360_TENANT_URL` | Data 360 tenant URL (c360a host) |
| `DATA360_CONNECT_BASE_URL` | Data 360 Connect base incl. `/services/data/vXX` |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | OAuth token host (use `test.salesforce.com` for sandboxes) |
| `SF_INSTANCE_URL` | origin of `MC_NEXT_API_BASE_URL` | Instance URL for the platform tools |
| `SF_API_VERSION` | `66.0` | API version for platform tools |
| `MC_NEXT_TIMEOUT_MS` | `60000` | Request timeout |
| `MC_NEXT_MAX_RETRIES` | `3` | Retries for 429 / 5xx |
| `MC_NEXT_ALLOW_DESTRUCTIVE` | `false` | Allow DELETE and destructive actions |
| `MC_NEXT_ALLOW_METADATA_CHANGES` | `false` | Allow custom object/field creation and deletion |
| `MC_NEXT_DEBUG` | `false` | Log HTTP requests to stderr |
| `MC_NEXT_CACHE_TTL_MS` | `30000` | Response cache TTL for GETs. `0` disables caching |
| `MC_NEXT_CACHE_MAX_ENTRIES` | `500` | Max cached responses (LRU eviction) |
| `MC_NEXT_POLL_INTERVAL_MS` | `2000` | Default delay between `mcnext_poll_job` polls |
| `MC_NEXT_POLL_TIMEOUT_MS` | `120000` | Default polling time budget |
| `MC_NEXT_HTTP_ENABLED` | `false` | Enable the HTTP transport (see [HTTP deployment](docs/HTTP-DEPLOYMENT.md)) |
| `MC_NEXT_HTTP_PORT` | `3000` | HTTP listen port |
| `MC_NEXT_HTTP_HOST` | `127.0.0.1` | HTTP bind host. Non-loopback **requires** an auth token |
| `MC_NEXT_HTTP_AUTH_TOKEN` | *(unset)* | Bearer token. Required for any non-loopback bind |
| `MC_NEXT_HTTP_ALLOWED_HOSTS` | *(unset)* | Comma-separated allowed `Host` values (DNS-rebinding protection) |

## Authentication

All three API families are reached with a **single OAuth 2.0 client-credentials token**.

> **Note on the source collections.** The Marketing Cloud Next collection already uses the client-credentials grant. The two Data 360 collections use the OAuth 2.0 **implicit** grant, which is browser-only and cannot be used by a server. This server converts them to client-credentials, which requires a Connected App with the relevant scopes enabled.

Create a Connected App in Salesforce Setup with OAuth enabled, the client-credentials flow permitted, and the scopes you need:

- `sfdc_cms_api` — Marketing Cloud Next (Content/CMS)
- `cdp_query_api` — Data 360 query
- `cdp_profile_api` — Data 360 profile
- `cdp_ingest_api` — Data 360 ingestion

## Safety

There are **two independent gates**, because deleting a data row and changing org schema carry very different risk.

### `MC_NEXT_ALLOW_DESTRUCTIVE` (default `false`)

Blocks operations that destroy data:

- every `DELETE` endpoint in the catalog (45 of them)
- destructive catalog actions such as delete, remove, purge, cancel, deactivate, revoke, unpublish
- `sf_delete_record`, `sf_bulk_delete_records`
- `DELETE` via `sf_rest_request` or `sf_composite`

### `MC_NEXT_ALLOW_METADATA_CHANGES` (default `false`)

Blocks operations that change **org schema**:

- `sf_create_custom_object`, `sf_delete_custom_object`
- `sf_create_custom_field`, `sf_delete_custom_field`

Metadata changes are gated separately because they are materially harder to reverse than a record delete — removing a custom field destroys its data, and removing an object destroys all of its records.

Both flags must be set explicitly; neither is implied by the other.

> **These gates do not make the server read-only.** They block the 63 destructive
> endpoints and the tools listed above. The remaining 382 endpoints — including
> 103 `create`, 45 `update`, and 32 `action` operations — are allowed by default.
> `sf_rest_request` also permits arbitrary `POST`/`PATCH`/`PUT`; only `DELETE` is
> gated. See [SECURITY.md](SECURITY.md#-what-the-gates-do-not-do--read-this) for
> the full picture and the recommended posture per environment.

## Use with an MCP client

The example below uses the **Claude Desktop** shape (`mcpServers`). VS Code uses
the key **`servers`** and requires `"type": "stdio"` — see
[VS-CODE-SETUP.md](docs/VS-CODE-SETUP.md) for the exact format, and
[CLAUDE-DESKTOP-SETUP.md](docs/CLAUDE-DESKTOP-SETUP.md) for config file locations.

```json
{
  "mcpServers": {
    "mc-next": {
      "command": "node",
      "args": ["/absolute/path/to/mc-next-mcp-server/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "...",
        "SF_CLIENT_SECRET": "...",
        "MC_NEXT_API_BASE_URL": "https://my-org.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://my-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://my-tenant.c360a.salesforce.com/services/data/v66.0"
      }
    }
  }
}
```

## Development

```bash
npm run generate     # regenerate catalog/endpoints.json from the Postman collections
npm run build        # tsc -> dist/
npm run typecheck    # tsc --noEmit
npm run dev          # tsc --watch
npm run smoke        # end-to-end MCP client test (no credentials needed)
npm run audit        # catalog fidelity checks
npm run lint         # ESLint
npm run format       # Prettier
```

A pre-commit hook runs ESLint and Prettier on staged files. CI runs all of the
above plus a dependency audit on Node 18, 20, and 22.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the catalog regeneration workflow, code
standards, and the commit message format. For running the server in Docker, on
multiple orgs, or with debug logging, see
[DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md).

### Scripts

| Script | Purpose |
| --- | --- |
| `scripts/generate-catalog.mjs` | Postman collections → `catalog/endpoints.json` |
| `scripts/audit-catalog.mjs` | Fidelity checks on the generated catalog |
| `scripts/inspect-raw.mjs` | Diagnose raw request bodies in the source collections |
| `scripts/smoke-test.mjs` | Connects over stdio and asserts the tool surface |

> **Never hand-edit `catalog/endpoints.json`** — regenerate it with `npm run generate`.

## Catalog notes

- **No `required` arrays in body schemas.** The Postman collections only provide *sample* bodies, so every property appears present. Marking them all required would be wrong, especially for PATCH endpoints. Schemas describe shape and types, not obligations.
- **Empty raw bodies are normalized to "no body".** Many GET/DELETE requests declare `mode: raw` with an empty string; that means no body, not an empty JSON body.
- **Non-JSON bodies are typed explicitly.** The Ingestion API's bulk upload is CSV and is passed through verbatim with `Content-Type: text/csv`.
- **Postman variable placeholders are stripped.** `{{nextPageToken}}`-style values are not real defaults.

## License

MIT
