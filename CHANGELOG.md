# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet. See the sections below for the shape a release entry takes.

## [1.0.0] - 2026-09-25

The first public release of `mc-next-mcp-server`: a catalog-driven
[Model Context Protocol](https://modelcontextprotocol.io) server that unifies
three Salesforce API families behind a single OAuth token, plus a set of
Inspector-style Salesforce platform tools.

### Added

#### Catalog-driven API coverage

- **445 endpoints** generated from the official Salesforce Postman collections,
  across **3 API families** and **44 resource groups**:
  - `mc-next` — Marketing Cloud Next (Content / CMS): **27** endpoints
  - `data360` — Data 360 core (Query, Profile, Ingestion, Metadata, Data Graphs):
    **35** endpoints
  - `data360-connect` — Data 360 Connect (Activations, Segments, Streams,
    Connections, ML, Governance, Clean Rooms, …): **383** endpoints
- Catalog generator (`scripts/generate-catalog.mjs`) that converts the Postman
  collections into `catalog/endpoints.json`, so the tool surface stays in sync
  with the published API reference.

#### MCP tools (28 total)

- **8 catalog-driven tools** — `mcnext_list_endpoints`,
  `mcnext_describe_endpoint`, `mcnext_query`, `mcnext_read`, `mcnext_create`,
  `mcnext_update`, `mcnext_delete`, `mcnext_action`.
- **6 Salesforce platform tools** — `sf_soql_query`, `sf_soql_query_more`,
  `sf_list_objects`, `sf_describe_object`, `sf_rest_request`, `sf_org_limits`.
- **8 record CRUD tools** — `sf_create_record`, `sf_get_record`,
  `sf_update_record`, `sf_delete_record`, `sf_bulk_create_records`,
  `sf_bulk_update_records`, `sf_bulk_delete_records`, `sf_composite`
  (bulk operations cap at 200 records per call; composite at 25 subrequests).
- **6 metadata CRUD tools** — `sf_create_custom_object`,
  `sf_create_custom_field`, `sf_delete_custom_field`, `sf_delete_custom_object`,
  `sf_list_custom_objects`, `sf_list_custom_fields`, all backed by the Tooling
  API.
- **MCP resources** — `mcnext://catalog` (full catalog) and `mcnext://overview`
  (auth model, bases, stats).
- **MCP prompts** — `explore-mc-next` and `explore-salesforce-org`.

#### Authentication & transport

- Single OAuth 2.0 **client-credentials** token shared across every API family,
  with in-memory caching and a single transparent re-auth + retry on `401`.
- Multi-host request routing: the endpoint's `base` key resolves to the correct
  host (`mcNext`, `data360`, `data360Connect`, `login`).
- Environment-driven configuration via a typed config layer.
- `stdio` transport, plus an HTTP client with exponential-backoff retry on
  `429` / `5xx`.

#### Safety

- **Two independent safety gates**, both defaulting to `false`:
  - `MC_NEXT_ALLOW_DESTRUCTIVE` — blocks all 45 `DELETE` endpoints
    (**63** destructive operations in total, including destructive actions such
    as delete, remove, purge, cancel, deactivate, revoke, unpublish) and the
    corresponding record/metadata delete tools.
  - `MC_NEXT_ALLOW_METADATA_CHANGES` — blocks custom object and custom field
    creation/deletion. Gated separately because schema changes are materially
    harder to reverse than a record delete.
  - Neither flag implies the other.

#### Tooling & documentation

- End-to-end smoke test (`scripts/smoke-test.mjs`) that connects to the built
  server over `stdio` and asserts the tool surface, safety guards, and
  validation paths — **no credentials required**.
- Catalog fidelity audit (`scripts/audit-catalog.mjs`) and a raw-body diagnostic
  script (`scripts/inspect-raw.mjs`).
- `README.md` documenting cross-product coverage, request flow, the two safety
  gates, and the honest limitations of the current implementation.
- `.env.example` with every supported environment variable annotated.

### Design notes

- **28 tools instead of 445.** Exposing every endpoint as its own tool would
  bloat the model's context and hurt tool-selection accuracy. The catalog-driven
  tools instead let the model discover an endpoint and then invoke it:
  `mcnext_list_endpoints` → `mcnext_describe_endpoint` → verb tool.
- **Catalog schemas describe shape, not obligations.** The Postman collections
  provide sample bodies only, so no `required` arrays are emitted — especially
  important for `PATCH` endpoints.
- **Empty raw bodies are normalized to "no body"**, not to an empty JSON body.
- **Non-JSON bodies are typed explicitly.** The Ingestion API's bulk upload is
  CSV and is passed through verbatim as `text/csv`.

### Known limitations

Documented in full in the [README](README.md#limitations). Highlights:

- Client-credentials auth only; one identity for everything; one org per server
  instance; no token persistence.
- No GraphQL, no SOAP, no Bulk API 2.0, no Metadata API deploy/retrieve, and no
  generic passthrough for the Data 360 tenant hosts.
- No `multipart/form-data` endpoint in the catalog, so the form-data code path
  is unexercised.
- No response caching and no rate-limit budgeting.
- No automated tests against a live Salesforce org.

[Unreleased]: https://github.com/supanmaniar/salesforce-mc-next-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/supanmaniar/salesforce-mc-next-mcp/releases/tag/v1.0.0
