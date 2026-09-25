# mc-next-mcp-server

An MCP (Model Context Protocol) server that exposes **Salesforce Marketing Cloud Next**, **Data 360**, and **Data 360 Connect** APIs, plus a set of **Salesforce platform tools** inspired by [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded).

The endpoint catalog is generated from the official Salesforce Postman collections, so the tool surface stays in sync with the published API reference.

## What it covers

| API family | Endpoints | Source collection |
| --- | --- | --- |
| `mc-next` — Marketing Cloud Next (Content / CMS) | 27 | Salesforce Marketing Cloud Next APIs |
| `data360` — Data 360 core | 35 | Salesforce Data 360 APIs |
| `data360-connect` — Data 360 Connect | 383 | Salesforce Data 360 Connect APIs |
| **Total** | **445** across 44 groups | |

Plus Salesforce platform tools: SOQL query, object list/describe, generic REST explorer, and org limits.

## Design: why 14 tools instead of 445

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

### Resources & prompts

- Resources: `mcnext://catalog` (full catalog), `mcnext://overview` (auth model, bases, stats)
- Prompts: `explore-mc-next`, `explore-salesforce-org`

## Install

```bash
npm install
npm run generate   # Postman collections -> catalog/endpoints.json
npm run build
```

`catalog/endpoints.json` is committed, so `npm run generate` is optional unless you change the source collections.

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
| `MC_NEXT_DEBUG` | `false` | Log HTTP requests to stderr |

## Authentication

All three API families are reached with a **single OAuth 2.0 client-credentials token**.

> **Note on the source collections.** The Marketing Cloud Next collection already uses the client-credentials grant. The two Data 360 collections use the OAuth 2.0 **implicit** grant, which is browser-only and cannot be used by a server. This server converts them to client-credentials, which requires a Connected App with the relevant scopes enabled.

Create a Connected App in Salesforce Setup with OAuth enabled, the client-credentials flow permitted, and the scopes you need:

- `sfdc_cms_api` — Marketing Cloud Next (Content/CMS)
- `cdp_query_api` — Data 360 query
- `cdp_profile_api` — Data 360 profile
- `cdp_ingest_api` — Data 360 ingestion

## Safety

Destructive operations are **blocked by default**. This covers:

- every `DELETE` endpoint (45 of them)
- destructive actions such as delete, remove, purge, cancel, deactivate, revoke, unpublish
- `DELETE` via `sf_rest_request`

Set `MC_NEXT_ALLOW_DESTRUCTIVE=true` to enable them.

## Use with an MCP client

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
npm run generate   # regenerate catalog/endpoints.json from the Postman collections
npm run build      # tsc -> dist/
npm run dev        # tsc --watch
npm run smoke      # end-to-end MCP client test (no credentials needed)
```

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
