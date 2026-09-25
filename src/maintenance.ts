/**
 * maintenance.ts — cache control and async job polling tools.
 *
 * Two tools that are deliberately NOT part of the catalog-driven surface:
 *
 *  - `mcnext_cache` — inspect, clear, or re-tune the response cache.
 *  - `mcnext_poll_job` — poll an asynchronous Salesforce job until it reaches a
 *    terminal state.
 *
 * The polling tool is intentionally conservative. The catalog documents **no
 * status vocabulary** for job endpoints — there are no enums, and the strings
 * "SUCCESS"/"COMPLETED"/"FAILED"/"PENDING" do not appear anywhere in the
 * generated catalog. Hard-coding terminal states would therefore be guesswork
 * that silently returns wrong answers. Instead this tool:
 *
 *   - polls at a bounded interval with a bounded timeout,
 *   - stops when the response stops changing, or when the caller's
 *     `successValues` / `failureValues` are matched,
 *   - and reports exactly what it observed, so the model decides.
 *
 * See docs/ASYNC-OPERATIONS.md for the reasoning and the documented job
 * endpoints this works against.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McNextConfig } from './config.js';
import type { McNextClient } from './client.js';
import type { SfRestClient } from './sfrest.js';
import { getEndpoint } from './catalog.js';

type ToolResponse = CallToolResult;

function ok(payload: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function fail(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull every plausible status-looking string out of a response body, so the
 * caller can match without us having to hard-code a vocabulary.
 */
function collectStatusish(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5)) collectStatusish(v, depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/status|state|result|outcome|phase/i.test(k)) {
      if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
      else if (v && typeof v === 'object') collectStatusish(v, depth + 1, out);
    } else if (v && typeof v === 'object') {
      collectStatusish(v, depth + 1, out);
    }
  }
  return out;
}

/** A cheap structural fingerprint, used to detect "nothing is changing". */
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value).length + ':' + JSON.stringify(collectStatusish(value));
  } catch {
    return 'unfingerprintable';
  }
}

export function registerMaintenanceTools(
  server: McpServer,
  cfg: McNextConfig,
  client: McNextClient,
  rest: SfRestClient
): void {
  /**
   * Apply a cache operation to BOTH caches. There are two because the
   * catalog-driven tools and the platform/CRUD tools use different HTTP
   * clients; a user clearing "the cache" means both.
   */
  const bothCaches = () => [client.cache, rest.cache];

  /* ---------------------------------------------------------------------- */
  /* 1. mcnext_cache — inspect / clear / re-tune the response cache          */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_cache',
    {
      title: 'Inspect or clear the response cache',
      description:
        'Show response-cache statistics (hits, misses, entries, TTL), change the TTL, or clear ' +
        'the cache. The cache stores only successful GET responses; writes and errors are never ' +
        'cached. Use `action: "clear"` after changing data in Salesforce if a subsequent read ' +
        'looks stale, and `action: "off"` to disable caching entirely for this session.',
      inputSchema: {
        action: z
          .enum(['stats', 'clear', 'off', 'ttl'])
          .describe(
            'stats = report counters; clear = drop all entries; off = disable caching; ttl = set a new TTL.'
          ),
        ttlMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('New TTL in milliseconds (required for action "ttl"). 0 disables caching.'),
      },
    },
    async ({ action, ttlMs }) => {
      const combined = () => {
        const a = client.cache.stats();
        const b = rest.cache.stats();
        return {
          enabled: a.enabled || b.enabled,
          ttlMs: client.cache.ttl,
          entries: a.entries + b.entries,
          hits: a.hits + b.hits,
          misses: a.misses + b.misses,
          evictions: a.evictions + b.evictions,
          expired: a.expired + b.expired,
          byClient: { catalog: a, platform: b },
        };
      };

      if (action === 'clear') {
        const cleared = bothCaches().reduce((n, c) => n + c.clear(), 0);
        return ok({ cleared, ...combined() });
      }

      if (action === 'off') {
        for (const c of bothCaches()) c.setTtl(0);
        return ok({ note: 'Response caching disabled for this session.', ...combined() });
      }

      if (action === 'ttl') {
        if (ttlMs === undefined) {
          return fail(
            'action "ttl" requires ttlMs, e.g. { "action": "ttl", "ttlMs": 60000 }. 0 disables caching.'
          );
        }
        for (const c of bothCaches()) c.setTtl(ttlMs);
        return ok({ note: `TTL set to ${ttlMs}ms.`, ...combined() });
      }

      const s = combined();
      const total = s.hits + s.misses;
      return ok({
        ...s,
        hitRate: total ? `${((s.hits / total) * 100).toFixed(1)}%` : 'n/a',
        maxEntries: cfg.cacheMaxEntries,
        note: s.enabled
          ? 'Caching is on. Only successful GET responses are stored; writes and errors never are.'
          : 'Caching is off. Set a non-zero TTL to enable it.',
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. mcnext_poll_job — poll an async job to completion                   */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_poll_job',
    {
      title: 'Poll an asynchronous Salesforce job',
      description:
        'Repeatedly call a read-only status endpoint until the job settles, then report what was ' +
        'observed. Use this for long-running operations (ingestion jobs, ML prediction jobs, SQL ' +
        'query status, data-kit deployments) instead of polling manually. The catalog does not ' +
        'document a status vocabulary, so this tool does not guess one: it stops when the ' +
        'response stops changing, when your `successValues`/`failureValues` match, or at the ' +
        'timeout — and always returns the last payload and the full status history.',
      inputSchema: {
        endpointId: z
          .string()
          .describe(
            'A read-only (kind "query" or "read") endpoint that reports job status, e.g. ' +
              '"ingestion-api.get-job-info", "machine-learning.get-a-predict-job", ' +
              '"query-current.get-sql-query-status". Use mcnext_list_endpoints to find one.'
          ),
        pathParams: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe('Path parameter values, e.g. { "jobId": "01a..." }.'),
        query: z.record(z.unknown()).optional().describe('Query string parameters.'),
        successValues: z
          .array(z.string())
          .optional()
          .describe(
            'Status values that mean success (case-insensitive substring match). Stops polling on a match.'
          ),
        failureValues: z
          .array(z.string())
          .optional()
          .describe('Status values that mean failure (case-insensitive substring match).'),
        intervalMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Delay between polls in ms. Default ${cfg.poll.intervalMs}.`),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Give up after this long in ms. Default ${cfg.poll.timeoutMs}. Bounded so a tool call cannot hang forever.`
          ),
        maxPolls: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Hard cap on the number of polls. Default 30, maximum 100.'),
      },
    },
    async ({
      endpointId,
      pathParams,
      query,
      successValues,
      failureValues,
      intervalMs,
      timeoutMs,
      maxPolls,
    }) => {
      const endpoint = getEndpoint(endpointId);
      if (!endpoint) {
        return fail(
          `Unknown endpoint id "${endpointId}". Use mcnext_list_endpoints with kind "read" or "query" to find a job status endpoint.`
        );
      }

      // Guard: polling must never issue a write. This is the single most
      // important check in this tool.
      if (endpoint.method !== 'GET') {
        return fail(
          `Refusing to poll "${endpointId}": it is ${endpoint.method}, not GET. Polling must be read-only. ` +
            'Pass a status endpoint (kind "query" or "read").'
        );
      }
      if (endpoint.destructive && !cfg.allowDestructive) {
        return fail(
          `Refusing to poll destructive endpoint "${endpointId}". Set MC_NEXT_ALLOW_DESTRUCTIVE=true to enable it.`
        );
      }

      const interval = intervalMs ?? cfg.poll.intervalMs;
      const budget = timeoutMs ?? cfg.poll.timeoutMs;
      const cap = Math.min(maxPolls ?? 30, 100);
      const started = Date.now();

      const history: { at: number; status: number; statusish: string[] }[] = [];
      let lastFingerprint = '';
      let lastResult: Awaited<ReturnType<typeof client.call>> | null = null;
      let polls = 0;
      let outcome = 'timeout';

      // `rest` is accepted for symmetry and future job endpoints on the core
      // org; the catalog-driven client covers every job endpoint today.
      void rest;

      const lower = (xs?: string[]) => (xs ?? []).map((s) => s.toLowerCase());
      const success = lower(successValues);
      const failure = lower(failureValues);

      while (polls < cap) {
        polls++;
        // bypassCache: a cached status would defeat the purpose of polling.
        lastResult = await client.call(endpoint, { pathParams, query, bypassCache: true });

        const statusish = collectStatusish(lastResult.data ?? lastResult.text);
        history.push({ at: Date.now() - started, status: lastResult.status, statusish });

        if (!lastResult.ok) {
          outcome = 'http-error';
          break;
        }

        const joined = statusish.join(' ').toLowerCase();
        if (failure.length && failure.some((f) => joined.includes(f))) {
          outcome = 'failed';
          break;
        }
        if (success.length && success.some((s) => joined.includes(s))) {
          outcome = 'succeeded';
          break;
        }

        const fp = fingerprint(lastResult.data ?? lastResult.text);
        if (polls > 1 && fp === lastFingerprint) {
          // Nothing changed between polls. Two identical consecutive reads is a
          // reasonable "settled" signal, but it is a heuristic, not proof.
          outcome = 'settled';
          break;
        }
        lastFingerprint = fp;

        if (Date.now() - started + interval > budget) {
          outcome = 'timeout';
          break;
        }
        await sleep(interval);
      }

      if (polls >= cap && outcome === 'timeout' && Date.now() - started < budget) {
        outcome = 'max-polls';
      }

      return ok({
        endpoint: endpoint.id,
        method: endpoint.method,
        polls,
        elapsedMs: Date.now() - started,
        outcome,
        outcomeNote:
          outcome === 'settled'
            ? 'The response stopped changing between two consecutive polls. This is a heuristic, not a documented terminal state — verify the payload.'
            : outcome === 'max-polls'
              ? 'Reached maxPolls before the timeout. Re-run with a higher maxPolls if the job is still running.'
              : outcome === 'timeout'
                ? 'Timed out. The job may still be running; re-run to continue polling.'
                : undefined,
        statusHistory: history,
        lastResponse: lastResult
          ? {
              status: lastResult.status,
              ok: lastResult.ok,
              data: lastResult.data ?? lastResult.text,
            }
          : null,
      });
    }
  );
}
