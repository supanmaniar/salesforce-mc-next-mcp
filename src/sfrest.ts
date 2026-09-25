/**
 * sfrest.ts — shared Salesforce REST client for the platform and CRUD tools.
 *
 * These calls are not catalog-driven: the caller supplies a raw path relative to
 * /services/data/vXX. Handles token injection, one-shot re-auth on 401, and
 * retry with backoff on 429/5xx.
 */

import type { McNextConfig } from './config.js';
import { log } from './config.js';
import type { TokenManager } from './auth.js';
import { ResponseCache, isCacheable, isCacheableStatus } from './cache.js';

const MAX_TEXT_CHARS = 100_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RestResult {
  status: number;
  ok: boolean;
  data: unknown;
  text: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
  /** True when this result was served from the response cache. */
  cached?: boolean;
}

export interface RestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the response cache for this call. */
  bypassCache?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SfRestClient {
  constructor(
    private readonly cfg: McNextConfig,
    private readonly tokens: TokenManager,
    /**
     * Shared response cache. Optional so the class stays usable on its own, but
     * in the server every tool group receives the same instance so that hits
     * are shared across platform, record, and metadata tools.
     */
    readonly cache: ResponseCache<RestResult> = new ResponseCache<RestResult>(
      cfg.cacheTtlMs,
      cfg.cacheMaxEntries
    )
  ) {}

  /** Replace the cache's TTL at runtime (used by the mcnext_cache tool). */
  setCacheTtl(ttlMs: number): void {
    this.cache.setTtl(ttlMs);
  }

  /** Instance URL, preferring the explicit config over the token response. */
  async instanceUrl(): Promise<string> {
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
  async apiUrl(path: string): Promise<string> {
    const base = await this.instanceUrl();
    const clean = path.startsWith('/') ? path : `/${path}`;
    // Allow callers to pass a fully-qualified path (e.g. /services/data/v66.0/...).
    if (clean.startsWith('/services/')) return base + clean;
    return `${base}/services/data/v${this.cfg.apiVersion}${clean}`;
  }

  async rest(method: string, path: string, opts: RestOptions = {}): Promise<RestResult> {
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

    // Only GETs are cacheable. Writes are never stored: a write response is not
    // reproducible from its URL.
    const cacheKey = ResponseCache.key(method, url, headers);
    if (isCacheable(method, opts)) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        log(this.cfg, `[sfrest] cache HIT ${method} ${url}`);
        return { ...hit, cached: true, durationMs: 0 };
      }
    }

    const started = Date.now();
    let attempt = 0;
    let reauthed = false;

    for (;;) {
      attempt++;
      const token = await this.tokens.getToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      log(this.cfg, `[sfrest] ${method} ${url}`);

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

      const result: RestResult = {
        status: res.status,
        ok: res.ok,
        data,
        text: clipped,
        truncated,
        durationMs: Date.now() - started,
        url,
        method,
      };

      // Store only successful GETs. Errors are never cached, so a 403 caused by
      // a missing scope does not keep looking broken after the scope is fixed.
      if (isCacheable(method, opts) && isCacheableStatus(res.status)) {
        this.cache.set(cacheKey, result);
        log(this.cfg, `[sfrest] cache STORE ${method} ${url} (ttl=${this.cache.ttl}ms)`);
      }

      return result;
    }
  }
}

/** Turn an HTTP result into a compact, model-friendly payload. */
export function formatRest(res: RestResult): {
  payload: Record<string, unknown>;
  isError: boolean;
} {
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
    payload.hint = hintForStatus(res.status);
  }
  return { payload, isError: !res.ok };
}

export function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request — check field names/types and required fields. Use sf_describe_object for the schema.';
    case 401:
      return 'Unauthorized — verify SF_CLIENT_ID / SF_CLIENT_SECRET.';
    case 403:
      return 'Forbidden — the Connected App/user lacks access to this object or field.';
    case 404:
      return 'Not found — verify the record id and that the object exists in this org.';
    case 405:
      return 'Method not allowed for this path.';
    case 429:
      return 'Rate limited — Salesforce enforces API request limits. Retry later or reduce call volume.';
    default:
      return status >= 500
        ? 'Server error from Salesforce — safe to retry.'
        : 'Unexpected response.';
  }
}
