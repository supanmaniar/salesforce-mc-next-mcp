# Roadmap

Where `mc-next-mcp-server` is going, and what would help most.

This is a **direction, not a commitment**. Priorities shift based on what people
actually need, so the fastest way to change this document is to
[open an issue](https://github.com/supanmaniar/salesforce-mc-next-mcp/issues) or
[contribute](CONTRIBUTING.md).

**Legend:** 🟢 ready to start · 🟡 needs design · 🔴 needs investigation

---

## How to influence this

| I want to… | Do this |
| --- | --- |
| Report a bug | [Bug report](https://github.com/supanmaniar/salesforce-mc-next-mcp/issues/new?template=bug_report.md) |
| Request a feature | [Feature request](https://github.com/supanmaniar/salesforce-mc-next-mcp/issues/new?template=feature_request.md) |
| Improve docs | [Documentation issue](https://github.com/supanmaniar/salesforce-mc-next-mcp/issues/new?template=documentation.md) |
| Vote on a priority | 👍 the relevant issue |
| Just build something | See [`good first issue`](https://github.com/supanmaniar/salesforce-mc-next-mcp/labels/good%20first%20issue) |

Items below that have an issue link are the ones with real demand behind them.
Items without one are planned but unclaimed.

---

## Near term (next 3 months)

**Theme: correctness, polish, and feedback.**

The foundation is in place — 445 endpoints, 28 tools, two safety gates, CI, and
full documentation. This phase is about removing rough edges before adding
surface area.

### Correctness

| Item | Status | Notes |
| --- | --- | --- |
| Resolve the missing `catalog.schema.json` | 🟢 | `catalog/endpoints.json` declares `"$schema": "./catalog.schema.json"`, but that file does not exist. Either commit the schema or drop the reference. |
| Add a live-org integration test suite | 🟡 | The smoke test asserts the tool surface without credentials. Nothing verifies behaviour against a real Salesforce org. Needs a sandbox org and CI secrets. |
| Automate dependency updates | 🟢 | Dependabot or Renovate. CI runs `npm audit` on push, but there is no update bot, so advisories surface late. |
| Add unit tests for pure functions | 🟡 | Catalog parsing, config resolution, URL building, and the destructive classifier are all pure and currently untested outside the smoke test. |

### Documentation and feedback

| Item | Status | Notes |
| --- | --- | --- |
| Gather first-user feedback | 🟡 | The most valuable thing right now. Setup friction is invisible to the author. |
| Document real-world workflows | 🟡 | `docs/EXAMPLES.md` covers individual calls. End-to-end recipes (e.g. "sync CMS content from a CSV") are missing. |
| Add a troubleshooting FAQ | 🟢 | Recurring questions from issues, consolidated. |

### Distribution

| Item | Status | Notes |
| --- | --- | --- |
| Publish to npm | 🟢 | The package is fully prepared and verified (`npm pack` → global install → speaks MCP). It has not been published yet. |
| Verify the Docker image builds | 🟢 | The `Dockerfile` and `docker-compose.yml` are written and reviewed but have never been executed in this environment. |
| List on awesome-mcp-servers | 🟢 | Entry drafted. See [Visibility](#visibility). |

---

## Medium term (6 months)

**Theme: reach and robustness.**

### Transport

| Item | Status | Notes |
| --- | --- | --- |
| ~~**HTTP/SSE transport option**~~ | ✅ | **Shipped** (opt-in, off by default). See [docs/HTTP-DEPLOYMENT.md](docs/HTTP-DEPLOYMENT.md). |
| Per-request identity | 🔴 | **Still the blocker for shared deployments.** The HTTP transport works, but every caller runs as the same integration user, so a shared server gives everyone that user's access. Needs per-user OAuth or header-based identity propagation. |

### Reliability

| Item | Status | Notes |
| --- | --- | --- |
| ~~**Response caching**~~ | ✅ | **Shipped.** GET-only, 30s default TTL, LRU-bounded, controllable via `mcnext_cache`. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md). |
| ~~**Async job handling**~~ | ✅ | **Shipped** as `mcnext_poll_job`. Deliberately does not guess terminal states, since the catalog documents no status vocabulary. See [docs/ASYNC-OPERATIONS.md](docs/ASYNC-OPERATIONS.md). |
| Per-endpoint cache TTLs | 🟡 | One TTL covers both volatile data and stable metadata. |
| In-flight request coalescing | 🟡 | Two concurrent identical cache misses both hit Salesforce. The token manager already de-duplicates; the HTTP clients do not. |
| Rate-limit awareness | 🟡 | The server retries 429s but does not budget the org's daily allowance. |
| Pagination helper for catalog tools | 🟢 | Only SOQL has `sf_soql_query_more`. |

### Correctness

| Item | Status | Notes |
| --- | --- | --- |
| Catalog schema validation in CI | 🟡 | Depends on resolving `catalog.schema.json` first. |
| Broader destructive classification review | 🟡 | 32 `action` endpoints are allowed by default. Some have real side effects. |

---

## Long term

**Theme: closing the API gaps.**

These are documented as limitations today. Each is a substantial piece of work.

### API coverage

| Item | Status | Notes |
| --- | --- | --- |
| **Bulk API 2.0 support** | 🔴 | `/jobs/ingest` and `/jobs/query` are absent from the source collections. Today bulk work uses the Composite API, auto-chunked at 200 records — fine for hundreds, not for millions. Real Bulk API support needs job lifecycle management (create → upload → close → poll). |
| **GraphQL support** | 🔴 | Not covered at all. A different query model from the catalog's REST endpoints, so it would need its own tool rather than fitting the existing generic tools. |
| **SOAP API support** | 🔴 | Not covered. One concrete gap this closes: assignment rules, duplicate rules, and owner-change options on insert are SOAP-only, so those options are unavailable today. |
| **Metadata API deploy/retrieve** | 🔴 | Today, custom object/field creation goes through the Tooling API, which is a different mechanism with different limits. Full Metadata API support means `package.xml` generation, retrieve/deploy jobs, and destructive-changes deployment. |
| Generic passthrough for Data 360 hosts | 🟡 | `sf_rest_request` covers the core org only. An endpoint absent from the catalog is unreachable on the Data 360 tenant. |

### Usability

| Item | Status | Notes |
| --- | --- | --- |
| **Browser-based auth flow** | 🔴 | Today it is client-credentials only. An authorization-code flow would enable per-user identity (unblocking the HTTP transport) and remove the "everything runs as one integration user" limitation. This is arguably the highest-value long-term item. |
| Write confirmation / dry-run mode | 🟡 | Tools execute immediately once a gate is open. A preview step would reduce the blast radius of model mistakes. |
| Structured audit logging | 🟡 | `MC_NEXT_DEBUG` logs to stderr, is opt-in, and is tamperable. Not a compliance-grade audit trail. |

---

## Explicitly not planned

Being clear about these prevents wasted effort:

| Not planned | Why |
| --- | --- |
| **Per-user impersonation** | Would require an auth model this server does not have. See browser-based auth above — that is the prerequisite. |
| **Becoming a shared multi-tenant service** | Requires solving identity first. Until then, one instance serves one org as one user. |
| **Reimplementing Salesforce's authorization** | Authorization is delegated to Salesforce by design. The server is a proxy, not a policy engine. See [SECURITY.md](SECURITY.md#authorization). |
| **Bundling the source Postman collections** | Excluded for licensing reasons. See [POSTMAN-COLLECTIONS.md](docs/POSTMAN-COLLECTIONS.md#these-collections-are-not-in-this-repository). |

---

## Visibility

Distribution work, tracked here because it is easy to forget:

| Item | Status |
| --- | --- |
| Publish to npm | 🟢 prepared, not published |
| awesome-mcp-servers listing | 🟢 entry drafted |
| README badges | ✅ added (CI, release, license, Node, MCP, endpoints) |
| npm badges | ⏸️ blocked on publishing — they render as "package not found" until then |

---

## Versioning intent

| Version | Theme |
| --- | --- |
| **1.x** | Bug fixes, docs, and the correctness items above. No breaking changes to the 28-tool surface. |
| **2.0** | The transport and identity work (HTTP/SSE, per-user auth). Expect breaking changes to how the server is deployed. |
| **3.0+** | The API-coverage gaps (Bulk API 2.0, GraphQL, SOAP, Metadata API). Additive, but large. |

The safety-gate semantics are **not** planned to change: both gates stay
independent and default to `false`. See
[CONTRIBUTING.md](CONTRIBUTING.md#safety-rules-non-negotiable).

---

## Contributing to a roadmap item

1. **Check for an existing issue.** If there is one, comment to claim it.
2. **For 🟡 and 🔴 items, open an issue first.** These need design agreement before
   code — particularly anything touching the transport or identity model.
3. **For 🟢 items, go ahead.** These are well-scoped and ready.
4. Follow [CONTRIBUTING.md](CONTRIBUTING.md). All of `npm run lint`,
   `npm run typecheck`, `npm run format:check`, `npm run build`, `npm run smoke`,
   and `npm run audit` must pass.

---

## See also

- [README.md](README.md#limitations) — current limitations
- [SECURITY.md](SECURITY.md) — threat model and trust boundaries
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#constraints-and-trade-offs) — design trade-offs
- [docs/POSTMAN-COLLECTIONS.md](docs/POSTMAN-COLLECTIONS.md#known-gaps-in-the-collections) — catalog gaps
