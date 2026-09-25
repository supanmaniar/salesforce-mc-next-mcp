# Performance

API consumption, the response cache, and what to expect under load.

---

## Why this matters

Salesforce enforces a **daily API request limit** per org, and this server has no
request budget of its own. Every tool call that reaches Salesforce spends from
that allowance.

The server's own contribution to waste is real: **there is no response caching by
default in the sense most people assume** — well, there is now, but it is
deliberately narrow. The common pattern that burns requests is the model
re-describing the same object repeatedly:

```
sf_describe_object("Account")   -> 1 API request
sf_describe_object("Account")   -> 1 API request  (identical!)
sf_list_objects()               -> 1 API request
sf_list_objects()               -> 1 API request  (identical!)
```

Each of those is a pure function of its URL. That is exactly what the cache is for.

---

## The response cache

### What it does

A small in-memory cache in front of every `GET` request, shared across all tool
groups.

| Property | Value |
| --- | --- |
| Default TTL | 30,000 ms (30 s) |
| Default max entries | 500 |
| Scope | Successful `GET` responses only |
| Eviction | LRU, on capacity |
| Storage | In memory, per process |
| Persistence | None — cleared on restart |

### What is cached

- **Only `GET` requests.** Writes are never cached, under any circumstances.
- **Only successful responses** (HTTP 2xx). Errors are never stored.
- **Only the response body and status** — keyed by method, full URL, and
  non-auth headers.

### What is *not* cached

| Not cached | Why |
| --- | --- |
| `POST` / `PATCH` / `PUT` / `DELETE` | A write response is not a function of its URL. Serving a stale one would be wrong. |
| Error responses (4xx, 5xx) | A `403` from a missing scope would keep looking broken long after the scope was fixed. |
| Requests with `bypassCache` | Used by `mcnext_poll_job`, where a cached status would defeat the purpose. |
| Anything when TTL is `0` | Caching is fully disabled. |
| Cross-process | Each server instance has its own cache. Nothing is shared. |

The `Authorization` header is **excluded from the cache key**, so the key is
stable across token refreshes. This is safe because the cache is per-process and
there is exactly one Salesforce identity per process.

### Verified behaviour

These are measured, not assumed. The numbers come from running the server against
a mock Salesforce that counts requests.

| Scenario | Server requests | Expected |
| --- | --- | --- |
| Two identical `sf_describe_object` calls | **1** | ✅ second served from cache |
| Two identical `sf_rest_request` GETs | **1** | ✅ shared across tool groups |
| Two identical `sf_create_record` writes | **2** | ✅ writes never cached |
| GET after `mcnext_cache` clear | **1** | ✅ cache emptied, request re-issued |
| Two GETs with TTL `0` | **2** | ✅ caching disabled |

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_NEXT_CACHE_TTL_MS` | `30000` | `0` disables caching entirely |
| `MC_NEXT_CACHE_MAX_ENTRIES` | `500` | LRU eviction beyond this |

```bash
# Aggressive: 5 minutes, fewer requests, staler reads
MC_NEXT_CACHE_TTL_MS=300000 node dist/index.js

# Off entirely
MC_NEXT_CACHE_TTL_MS=0 node dist/index.js
```

### Choosing a TTL

| TTL | Good for |
| --- | --- |
| `0` | Maximum freshness; debugging; when API allowance is not a concern |
| `30000` (default) | General use — absorbs the repeated-describe pattern without noticeable staleness |
| `300000` (5 min) | Read-heavy exploration of stable metadata |
| Longer | Rarely appropriate — schema and metadata do change |

**The cache is not a substitute for correctness.** If you are about to act on a
read, consider whether a 30-second-old value is acceptable.

---

## The `mcnext_cache` tool

Inspect, clear, or re-tune the cache at runtime — no restart needed.

### Check status

```json
{ "name": "mcnext_cache", "arguments": { "action": "stats" } }
```

```json
{
  "enabled": true,
  "ttlMs": 30000,
  "entries": 12,
  "hits": 34,
  "misses": 9,
  "evictions": 0,
  "expired": 3,
  "byClient": {
    "catalog": { "hits": 2, "misses": 5, "entries": 1, "enabled": true },
    "platform": { "hits": 32, "misses": 4, "entries": 11, "enabled": true }
  },
  "hitRate": "79.1%",
  "maxEntries": 500
}
```

`hitRate` is the headline number. If it is near zero, the cache is not earning its
keep; if it is very high, you may be able to lower the TTL for fresher reads.

> `byClient` exists because there are two caches internally: one for catalog-driven
> tools, one for platform/record/metadata tools. They share the same TTL and are
> reported together, but the split is visible for diagnosis.

### Clear it

```json
{ "name": "mcnext_cache", "arguments": { "action": "clear" } }
```

Use this after changing data in Salesforce if a subsequent read looks stale.

### Change the TTL

```json
{ "name": "mcnext_cache", "arguments": { "action": "ttl", "ttlMs": 300000 } }
```

### Turn it off

```json
{ "name": "mcnext_cache", "arguments": { "action": "off" } }
```

Equivalent to setting TTL `0`. Session-scoped — a restart restores the configured TTL.

---

## Reducing API consumption

The cache is one lever. These matter more.

### 1. Batch instead of looping

| Instead of | Use | Saves |
| --- | --- | --- |
| 200 × `sf_create_record` | `sf_bulk_create_records` | ~199 requests |
| 25 × `sf_update_record` | `sf_composite` | ~24 requests |

`sf_bulk_*` auto-chunks at 200 records per call and accepts larger arrays,
issuing one request per 200. `sf_composite` caps at 25 subrequests.

### 2. Check your allowance first

```json
{ "name": "sf_org_limits", "arguments": {} }
```

Do this before bulk work. The server does not track or budget the allowance for
you — it will keep issuing calls until Salesforce refuses them.

### 3. Reuse describe results

`sf_describe_object` is cached now, but a *fresh* describe still costs a request.
Within one workflow, describe once and keep the field names in the conversation
rather than re-describing.

### 4. Prefer SOQL over repeated single reads

One SOQL query returning 200 rows costs one request. 200 × `sf_get_record` costs 200.

### 5. Raise the cache TTL for exploration

If you are browsing metadata and schema, a longer TTL is a large win. Lower it
again before making decisions on the data.

---

## Rate limits and retries

### What the server does

Retries `429`, `500`, `502`, `503`, `504` automatically:

- Honours a numeric `Retry-After` header when present.
- Otherwise exponential backoff: `min(2^attempt × 500ms, 15s)`.
- Bounded by `MC_NEXT_MAX_RETRIES` (default **3**).

Retry attempts are **not** cached, and a retried request counts once against the
cache but potentially several times against Salesforce's limit.

### What the server does not do

| Not done | Consequence |
| --- | --- |
| Track the daily allowance | It will exhaust it |
| Queue or throttle requests | Bursts go straight through |
| Coordinate across instances | Two instances share no budget knowledge |
| Cache across processes | Each instance learns separately |

**A `429` reaching you means retries were exhausted.** Raising
`MC_NEXT_MAX_RETRIES` delays the failure; it does not prevent it. Reduce volume
instead.

---

## Memory and footprint

| Item | Size |
| --- | --- |
| Catalog | ~1 MB JSON, loaded once and held for the process lifetime |
| Cache | Bounded by `MC_NEXT_CACHE_MAX_ENTRIES`; large describe responses dominate |
| Tokens | One token, negligible |
| Sessions (HTTP) | One per client, in-memory |

The catalog is the dominant fixed cost. The cache is bounded, so a long-running
server cannot grow without limit.

> **Large responses.** A `describe` of an object with hundreds of fields produces
> a correspondingly large cached entry. If you raise `MC_NEXT_CACHE_MAX_ENTRIES`
> significantly, memory grows with it. Response bodies are truncated at 100,000
> characters for *display*, but the cache stores what was returned.

---

## HTTP transport considerations

Under HTTP, the cache is **shared across all callers**. Two consequences:

- **Better hit rates.** More clients issuing similar reads means more reuse.
- **Shared state.** One caller's cached read is served to another. The cache only
  holds successful GETs, so this is not a data leak across *users* in the usual
  sense — but it is shared. Set `MC_NEXT_CACHE_TTL_MS=0` if that is unacceptable.

Sessions are per-client, but the cache is not. See
[HTTP-DEPLOYMENT.md](HTTP-DEPLOYMENT.md#consider-disabling-the-cache).

---

## Measuring

Enable request logging to see exactly what happens:

```json
{ "env": { "MC_NEXT_DEBUG": "true" } }
```

You will see cache decisions inline:

```
[mc-next-mcp] GET https://my-org.my.salesforce.com/services/data/v66.0/sobjects/Account/describe
[mc-next-mcp] [sfrest] cache STORE GET https://... (ttl=30000ms)
[mc-next-mcp] [sfrest] cache HIT GET https://...
```

`cache HIT` means no request was made. `cache STORE` means one was.

For a summary, use `mcnext_cache` with `action: "stats"` and read `hitRate`.

---

## Known limitations

| Limitation | Detail |
| --- | --- |
| **No cross-process sharing** | Each instance has its own cache. A restart starts cold. |
| **No persistence** | Nothing survives a restart. Deliberate — it avoids writing state to disk. |
| **No conditional requests** | No `ETag` / `If-None-Match`. Every miss is a full response. |
| **No per-endpoint TTL** | One TTL for everything, though metadata and data have different volatility. |
| **No request coalescing** | Two concurrent identical misses both hit Salesforce. Unlike the token refresh, there is no in-flight de-duplication. |
| **Cache size is entry-count based** | Not byte-based, so memory use depends on response sizes. |

Adding per-endpoint TTLs or in-flight coalescing would be reasonable
contributions — see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## See also

- [ASYNC-OPERATIONS.md](ASYNC-OPERATIONS.md) — why polling bypasses the cache
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md#monitoring) — monitoring and rate limits
- [HTTP-DEPLOYMENT.md](HTTP-DEPLOYMENT.md) — shared-cache implications
- [ARCHITECTURE.md](ARCHITECTURE.md) — token caching, which is separate from this
