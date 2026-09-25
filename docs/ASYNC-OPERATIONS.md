# Asynchronous Operations

Polling long-running Salesforce jobs with `mcnext_poll_job`.

---

## The problem this solves

Many Data 360 and Data 360 Connect operations do not finish during the request.
They return an id, and you poll a status endpoint until the work completes:

```
POST /api/v1/ingest/jobs          -> { "id": "01a..." }
GET  /api/v1/ingest/jobs/01a...   -> { "state": ... }   <- poll until done
```

Without help, that means the model has to poll by hand: call, wait, call again,
interpret an undocumented status, decide whether to continue. That is tedious,
wastes context, and is easy to get wrong.

`mcnext_poll_job` does the loop for you.

---

## Why this tool does not know what "done" means

This is the most important thing to understand about it.

The catalog is generated from Salesforce's Postman collections, and those
collections **document no status vocabulary**. Verified against the committed
catalog:

| Search | Result |
| --- | --- |
| `"SUCCESS"` | 0 occurrences |
| `"COMPLETED"` | 0 occurrences |
| `"FAILED"` | 0 occurrences |
| `"PENDING"` | 0 occurrences |
| `"RUNNING"` | 0 occurrences |
| `"InProgress"` | 1 occurrence |
| Endpoints with a `status` property in their body schema | 2 (both `{"type":"string"}`, no enum) |

So there is no reliable list of terminal states to hard-code. A tool that assumed
`"SUCCESS"` means done would silently return the wrong answer for every endpoint
that uses `"Completed"` instead — and would look like it worked.

**Therefore the tool does not guess.** It polls, and it stops on signals *you*
control, then reports exactly what it observed.

---

## How it decides to stop

Polling ends on the first of these:

| Outcome | Trigger |
| --- | --- |
| `succeeded` | A value you passed in `successValues` matched (case-insensitive substring) |
| `failed` | A value you passed in `failureValues` matched |
| `settled` | Two consecutive responses were identical — a heuristic, not a documented state |
| `http-error` | The status endpoint itself returned a non-2xx |
| `timeout` | The time budget elapsed |
| `max-polls` | The poll cap was reached before the timeout |

Every response is recorded in `statusHistory`, and the final payload is returned
whole. The model sees the raw evidence and decides — it is not told "this
succeeded" on the basis of a guess.

> **`settled` is a heuristic.** Two identical reads in a row usually means the job
> stopped moving, but it can also mean a slow job is between phases. The tool says
> so explicitly in its `outcomeNote` rather than presenting it as certainty.

---

## Usage

### Basic: poll and report

```json
{
  "name": "mcnext_poll_job",
  "arguments": {
    "endpointId": "ingestion-api.get-job-info",
    "pathParams": { "jobId": "01aXXXXXXXXXXXXXXX" }
  }
}
```

**Response shape:**

```json
{
  "endpoint": "ingestion-api.get-job-info",
  "method": "GET",
  "polls": 4,
  "elapsedMs": 6231,
  "outcome": "settled",
  "outcomeNote": "The response stopped changing between two consecutive polls. This is a heuristic, not a documented terminal state — verify the payload.",
  "statusHistory": [
    { "at": 0, "status": 200, "statusish": ["InProgress"] },
    { "at": 2011, "status": 200, "statusish": ["InProgress"] },
    { "at": 4102, "status": 200, "statusish": ["Completed"] },
    { "at": 6208, "status": 200, "statusish": ["Completed"] }
  ],
  "lastResponse": { "status": 200, "ok": true, "data": { } }
}
```

Note `statusish`: the tool extracts any status-looking value from the payload
(keys matching `status`, `state`, `result`, `outcome`, `phase`), so you can see
what the API actually returned without the tool having to interpret it.

### Recommended: tell it what "done" looks like

This is the reliable form. Check what your endpoint returns once, then pass the
values:

```json
{
  "name": "mcnext_poll_job",
  "arguments": {
    "endpointId": "machine-learning.get-a-predict-job",
    "pathParams": { "jobId": "1Pj..." },
    "successValues": ["Completed", "Succeeded"],
    "failureValues": ["Failed", "Aborted", "Cancelled"],
    "intervalMs": 5000,
    "timeoutMs": 300000
  }
}
```

Matching is a **case-insensitive substring** test against the extracted status
values, so `"complete"` matches `"Completed"` and `"COMPLETED"` alike.

### Bounding the work

| Parameter | Default | Maximum | Purpose |
| --- | --- | --- | --- |
| `intervalMs` | 2000 | — | Delay between polls |
| `timeoutMs` | 120000 (2 min) | — | Total time budget |
| `maxPolls` | 30 | 100 | Hard cap on request count |

A tool call cannot hang forever: the loop always terminates on timeout or poll
cap, whichever comes first. If a job legitimately runs for 30 minutes, poll
repeatedly — each call returns its history, so nothing is lost between calls.

---

## Documented job endpoints

These are the catalog endpoints that report job state. All are `GET`, which the
tool requires.

### Data 360 — Ingestion API

| Endpoint | Path | Notes |
| --- | --- | --- |
| `ingestion-api.get-job-info` | `/api/v1/ingest/jobs/:jobId` | Status of one ingestion job |
| `ingestion-api.get-all-jobs` | `/api/v1/ingest/jobs` | List all jobs |

The full lifecycle:

```
ingestion-api.create-job   POST   /api/v1/ingest/jobs        -> returns jobId
ingestion-api.upload-job   PUT    /api/v1/ingest/jobs/:jobId  (CSV body)
ingestion-api.close-job    PATCH  /api/v1/ingest/jobs/:jobId
        ... poll ingestion-api.get-job-info until settled ...
ingestion-api.abort-job    PATCH  /api/v1/ingest/jobs/:jobId   (if needed)
```

> `upload-job` and `close-job` are **writes**, so `mcnext_poll_job` refuses them —
> correctly. Use `mcnext_update` for those, and poll only the `GET` status endpoint.

### Data 360 Connect — Machine Learning

| Endpoint | Path |
| --- | --- |
| `machine-learning.get-a-predict-job` | `/ssot/machine-learning/jobs/:jobId` |
| `machine-learning.get-predict-job-tasks` | `/ssot/machine-learning/jobs/:jobId/tasks` |
| `machine-learning.get-a-predict-job-task` | `/ssot/machine-learning/jobs/:jobId/tasks/:taskId` |

### Data 360 Connect — others

| Endpoint | Path | Notes |
| --- | --- | --- |
| `query-current.get-sql-query-status` | `/ssot/query-sql/:queryId` | SQL query status |
| `notebook-ai.get-deep-research-status` | `/ssot/knowledge-space/deep-research/:researchId` | |
| `data-governance.get-auto-tagging-job` | `/ssot/data-governance/auto-tagging-jobs/:id` | |
| `data-kits.get-data-kit-component-status` | `/ssot/data-kits/:dataKitName/components/:componentName/deployment-status` | |

### Finding others

```json
{
  "name": "mcnext_list_endpoints",
  "arguments": { "search": "job", "kind": "query" }
}
```

---

## The read-only guarantee

`mcnext_poll_job` **refuses any endpoint that is not `GET`**:

```
Refusing to poll "ingestion-api.create-job": it is POST, not GET.
Polling must be read-only. Pass a status endpoint (kind "query" or "read").
```

This is the tool's most important safety property. A polling loop repeats an
operation many times automatically; if it could issue a write, a mistake would be
multiplied by the poll count. Refusing non-GET makes that impossible.

It also refuses destructive endpoints when the destructive gate is closed, and
unknown endpoint ids (with no fuzzy suggestion, since the correct fix is to browse
the catalog for a status endpoint).

### The cache is bypassed

Polling a cached response would be pointless — every poll would return the same
stored body. The tool passes `bypassCache` internally, so each poll is a real
request. See [PERFORMANCE.md](PERFORMANCE.md#what-is-not-cached).

---

## Worked example: CSV ingestion

```json
// 1. Create the job
{ "name": "mcnext_create",
  "arguments": { "endpointId": "ingestion-api.create-job",
                 "body": { "object": "Contact", "operation": "upsert" } } }

// -> { "id": "01aXXX", "state": "Open" }

// 2. Upload the CSV (a write, so not a poll)
{ "name": "mcnext_update",
  "arguments": { "endpointId": "ingestion-api.upload-job",
                 "pathParams": { "jobId": "01aXXX" },
                 "body": "Id,Email\n003...,a@example.com" } }

// 3. Close the job
{ "name": "mcnext_update",
  "arguments": { "endpointId": "ingestion-api.close-job",
                 "pathParams": { "jobId": "01aXXX" } } }

// 4. Poll until done
{ "name": "mcnext_poll_job",
  "arguments": { "endpointId": "ingestion-api.get-job-info",
                 "pathParams": { "jobId": "01aXXX" },
                 "successValues": ["Completed", "JobComplete"],
                 "failureValues": ["Failed", "Aborted"],
                 "intervalMs": 5000, "timeoutMs": 300000 } }
```

> **The CSV body is passed verbatim as `text/csv`.** `ingestion-api.upload-job` is
> the one catalog endpoint with a non-JSON body type. See
> [POSTMAN-COLLECTIONS.md](POSTMAN-COLLECTIONS.md#3-non-json-bodies-keep-their-real-content-type).

---

## Asynchronous metadata changes

Custom object and field creation is asynchronous in a different way: the Tooling
API accepts the request and returns immediately, but the change takes seconds to
become visible. There is no status endpoint to poll.

The practical approach is to re-read until it appears:

```json
{ "name": "sf_describe_object", "arguments": { "sobject": "Invoice__c" } }
```

If the field is not there yet, that is expected — retry rather than assuming
failure. Both `sf_create_custom_object` and `sf_create_custom_field` are gated
behind `MC_NEXT_ALLOW_METADATA_CHANGES`.

---

## Limitations

| Limitation | Detail |
| --- | --- |
| **No server-side job tracking** | The server does not remember jobs between calls. Each `mcnext_poll_job` call is independent; the model supplies the id. |
| **No background execution** | Polling occupies the tool call. There is no fire-and-forget mode. |
| **`settled` is a heuristic** | See above. Pass `successValues` when you can. |
| **No webhooks** | Salesforce job callbacks are not supported; polling is the only mechanism. |
| **Not durable** | If the process restarts mid-poll, the loop is lost. The job continues on Salesforce. |
| **Status vocabulary is undocumented** | The root cause of the design above. If Salesforce publishes a status enum, this tool could become exact. |

---

## See also

- [EXAMPLES.md](EXAMPLES.md) — other worked tool calls
- [PERFORMANCE.md](PERFORMANCE.md) — the cache, and why polling bypasses it
- [ARCHITECTURE.md](ARCHITECTURE.md) — how tools are registered
- [POSTMAN-COLLECTIONS.md](POSTMAN-COLLECTIONS.md) — why status enums are absent
