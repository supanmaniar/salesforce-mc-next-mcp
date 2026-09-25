/**
 * platform.ts — Salesforce platform tools inspired by Salesforce Inspector
 * Reloaded (SOQL query, object describe, REST explorer, org limits).
 *
 * These tools talk to the standard Salesforce REST API on the org's instance
 * URL, using the same OAuth token as the catalog-driven tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McNextConfig } from './config.js';
import { log } from './config.js';
import type { TokenManager } from './auth.js';

type ToolResponse = CallToolResult;

const MAX_TEXT_CHARS = 100_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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

interface RestResult {
  status: number;
  ok: boolean;
  data: unknown;
  text: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
}

/**
 * Minimal Salesforce REST caller for the platform tools. Kept separate from the
 * catalog client because these calls are not catalog-driven: the caller supplies
 * a raw path.
 */
class PlatformClient {
  constructor(
    private readonly cfg: McNextConfig,
    private readonly tokens: TokenManager
  ) {}

  /** Instance URL, preferring the explicit config over the token response. */
  private async instanceUrl(): Promise<string> {
    if (this.cfg.instanceUrl && !this.cfg.instanceUrl.includes('YOUR_')) {
      return this.cfg.instanceUrl;
    }
    const fromToken = this.tokens.instanceUrl;
    if (fromToken) return fromToken.replace(/\/+$/, '');
    throw new Error(
      'No Salesforce instance URL available. Set SF_INSTANCE_URL (e.g. ' +
        'https://my-org.my.salesforce.com) or ensure the OAuth token response includes instance_url.'
    );
  }

  /** Build a URL for a path relative to /services/data/vXX. */
  private async apiUrl(path: string): Promise<string> {
    const base = await this.instanceUrl();
    const version = this.cfg.apiVersion;
    const clean = path.startsWith('/') ? path : `/${path}`;
    // Allow callers to pass a fully-qualified path (e.g. /services/data/v66.0/...).
    if (clean.startsWith('/services/')) return base + clean;
    return `${base}/services/data/v${version}${clean}`;
  }

  async rest(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<RestResult> {
    const url = await this.apiUrl(path);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    let body: string | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    const started = Date.now();
    let attempt = 0;
    let reauthed = false;

    for (;;) {
      attempt++;
      const token = await this.tokens.getToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      log(this.cfg, `[platform] ${method} ${url}`);

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { ...headers, Authorization: `Bearer ${token}` },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Request to ${method} ${url} failed: ${reason}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 401 && !reauthed) {
        reauthed = true;
        this.tokens.invalidate();
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt <= this.cfg.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(2 ** attempt * 500, 15_000);
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      const truncated = text.length > MAX_TEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
      let data: unknown = null;
      if (res.headers.get('content-type')?.includes('json') || /^\s*[[{]/.test(clipped)) {
        try {
          data = JSON.parse(clipped);
        } catch {
          data = null;
        }
      }

      return {
        status: res.status,
        ok: res.ok,
        data,
        text: clipped,
        truncated,
        durationMs: Date.now() - started,
        url,
        method,
      };
    }
  }
}

function formatRest(res: RestResult): ToolResponse {
  const payload: Record<string, unknown> = {
    request: `${res.method} ${res.url}`,
    status: res.status,
    ok: res.ok,
    durationMs: res.durationMs,
  };
  if (res.data !== null) payload.data = res.data;
  else if (res.text) payload.body = res.text;
  if (res.truncated) payload.note = 'Response body was truncated for display.';
  if (!res.ok) {
    payload.hint =
      res.status === 401
        ? 'Unauthorized — verify SF_CLIENT_ID / SF_CLIENT_SECRET.'
        : res.status === 403
          ? 'Forbidden — the Connected App/user lacks access to this resource.'
          : res.status === 400
            ? 'Bad request — check the SOQL syntax or request body.'
            : 'Request failed.';
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }
  return ok(payload);
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerPlatformTools(
  server: McpServer,
  cfg: McNextConfig,
  tokens: TokenManager
): void {
  const client = new PlatformClient(cfg, tokens);

  /* ---------------------------------------------------------------------- */
  /* 1. sf_soql_query — run SOQL                                            */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_soql_query',
    {
      title: 'Run a SOQL query',
      description:
        'Execute a SOQL query against the org (Salesforce REST /query). Returns records plus ' +
        '`done` and `nextRecordsUrl` for pagination. Use sf_soql_query_more to fetch the next page. ' +
        'Example: SELECT Id, Name FROM Account LIMIT 10',
      inputSchema: {
        soql: z.string().describe('The SOQL query, e.g. "SELECT Id, Name FROM Account LIMIT 10".'),
        tooling: z
          .boolean()
          .optional()
          .describe('Query the Tooling API instead of the data API (for metadata objects). Default false.'),
      },
    },
    async ({ soql, tooling }) => {
      const path = tooling
        ? `/tooling/query/?q=${encodeURIComponent(soql)}`
        : `/query/?q=${encodeURIComponent(soql)}`;
      try {
        return formatRest(await client.rest('GET', path));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. sf_soql_query_more — paginate a SOQL result                         */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_soql_query_more',
    {
      title: 'Fetch the next page of a SOQL query',
      description:
        'Fetch the next page of results using the `nextRecordsUrl` returned by sf_soql_query.',
      inputSchema: {
        nextRecordsUrl: z
          .string()
          .describe('The nextRecordsUrl from a previous query, e.g. "/services/data/v66.0/query/01g...-2000".'),
      },
    },
    async ({ nextRecordsUrl }) => {
      try {
        return formatRest(await client.rest('GET', nextRecordsUrl));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 3. sf_list_objects — list sObjects                                     */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_list_objects',
    {
      title: 'List Salesforce objects',
      description:
        'List the sObjects in the org (global describe). Returns each object\'s name, label, ' +
        'and key prefix. Use sf_describe_object for field-level detail.',
      inputSchema: {
        tooling: z.boolean().optional().describe('List Tooling API objects instead. Default false.'),
        search: z.string().optional().describe('Filter by name or label (case-insensitive substring).'),
      },
    },
    async ({ tooling, search }) => {
      try {
        const res = await client.rest('GET', tooling ? '/tooling/sobjects/' : '/sobjects/');
        if (!res.ok || !res.data) return formatRest(res);
        const sobjects = (res.data as { sobjects?: Array<Record<string, unknown>> }).sobjects ?? [];
        const needle = search?.toLowerCase();
        const filtered = needle
          ? sobjects.filter((o) =>
              `${o.name} ${o.label}`.toLowerCase().includes(needle)
            )
          : sobjects;
        return ok({
          total: filtered.length,
          sobjects: filtered.map((o) => ({
            name: o.name,
            label: o.label,
            keyPrefix: o.keyPrefix ?? null,
            custom: o.custom ?? false,
            queryable: o.queryable ?? null,
          })),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 4. sf_describe_object — field metadata                                 */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_describe_object',
    {
      title: 'Describe a Salesforce object',
      description:
        'Get field-level metadata for an sObject: field names, types, labels, picklist values, ' +
        'and whether each field is required/createable/updateable. Essential before writing SOQL ' +
        'or building a record payload.',
      inputSchema: {
        sobject: z.string().describe('API name of the object, e.g. "Account" or "My_Object__c".'),
        tooling: z.boolean().optional().describe('Describe a Tooling API object instead. Default false.'),
        includePicklists: z
          .boolean()
          .optional()
          .describe('Include picklist values for picklist fields. Default false (keeps output small).'),
      },
    },
    async ({ sobject, tooling, includePicklists }) => {
      try {
        const prefix = tooling ? '/tooling/sobjects/' : '/sobjects/';
        const res = await client.rest('GET', `${prefix}${encodeURIComponent(sobject)}/describe/`);
        if (!res.ok || !res.data) return formatRest(res);

        const d = res.data as {
          name?: string;
          label?: string;
          fields?: Array<Record<string, unknown>>;
        };
        const fields = (d.fields ?? []).map((f) => {
          const out: Record<string, unknown> = {
            name: f.name,
            label: f.label,
            type: f.type,
            required: f.nillable === false && f.defaultedOnCreate === false,
            createable: f.createable,
            updateable: f.updateable,
            custom: f.custom,
          };
          if (f.referenceTo) out.referenceTo = f.referenceTo;
          if (includePicklists && Array.isArray(f.picklistValues)) {
            out.picklistValues = (f.picklistValues as Array<Record<string, unknown>>)
              .filter((p) => p.active !== false)
              .map((p) => p.value);
          }
          return out;
        });

        return ok({
          name: d.name,
          label: d.label,
          fieldCount: fields.length,
          fields,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 5. sf_rest_request — generic REST explorer                             */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_rest_request',
    {
      title: 'Call any Salesforce REST endpoint',
      description:
        'Generic REST explorer (like Salesforce Inspector\'s REST Explorer). Call any path under ' +
        '/services/data/vXX with any method. Paths may be relative (e.g. "/sobjects/Account/describe") ' +
        'or absolute (e.g. "/services/data/v66.0/limits"). Use this for endpoints not covered by the ' +
        'other tools.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).describe('HTTP method.'),
        path: z
          .string()
          .describe('Path relative to /services/data/vXX, or an absolute /services/data/... path.'),
        body: z.unknown().optional().describe('JSON request body for POST/PATCH/PUT.'),
        headers: z.record(z.string()).optional().describe('Additional request headers.'),
      },
    },
    async ({ method, path, body, headers }) => {
      if (method === 'DELETE' && !cfg.allowDestructive) {
        return fail(
          `Refusing to send DELETE to "${path}". Set MC_NEXT_ALLOW_DESTRUCTIVE=true to enable ` +
            'destructive REST calls.'
        );
      }
      try {
        return formatRest(await client.rest(method, path, { body, headers }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 6. sf_org_limits — API usage and limits                                */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_org_limits',
    {
      title: 'Get Salesforce org limits',
      description:
        'Read the org\'s governor limits and current usage (/limits), including DailyApiRequests, ' +
        'DataStorageMB, and FileStorageMB. Useful for checking remaining API quota before bulk work.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Only return limits whose name contains this string (case-insensitive).'),
      },
    },
    async ({ filter }) => {
      try {
        const res = await client.rest('GET', '/limits');
        if (!res.ok || !res.data) return formatRest(res);
        const all = res.data as Record<string, { Max?: number; Remaining?: number }>;
        const needle = filter?.toLowerCase();
        const entries = Object.entries(all)
          .filter(([name]) => !needle || name.toLowerCase().includes(needle))
          .map(([name, v]) => ({
            name,
            max: v.Max ?? null,
            remaining: v.Remaining ?? null,
            used: v.Max != null && v.Remaining != null ? v.Max - v.Remaining : null,
          }));
        return ok({ total: entries.length, limits: entries });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
