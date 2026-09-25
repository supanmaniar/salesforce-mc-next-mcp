/**
 * client.ts — thin HTTP client for the Marketing Cloud Next / Data 360 APIs.
 *
 * Responsibilities:
 *  - resolve the correct base URL per endpoint family
 *  - inject the bearer token
 *  - substitute :pathParams and append query params
 *  - build JSON / form-data / raw-text bodies
 *  - retry on 429 and 5xx with exponential backoff
 *  - transparently re-authenticate once on 401
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { McNextConfig } from './config.js';
import { log } from './config.js';
import type { TokenManager } from './auth.js';
import type { Endpoint } from './catalog.js';
import { ResponseCache, isCacheable, isCacheableStatus } from './cache.js';

export interface CallOptions {
  pathParams?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** For formdata endpoints: map of field name -> value (string or absolute file path). */
  formData?: Record<string, string>;
  /** Extra headers merged over the endpoint defaults. */
  headers?: Record<string, string>;
  /** Skip the response cache for this call. */
  bypassCache?: boolean;
}

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  /** Parsed JSON when the response is JSON, otherwise null. */
  data: unknown;
  /** Raw text, truncated when very large. */
  text: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
  /** True when this result was served from the response cache. */
  cached?: boolean;
}

const MAX_TEXT_CHARS = 100_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Body type accepted by the global fetch implementation (avoids DOM lib). */
type RequestBody = NonNullable<RequestInit['body']>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class McNextClient {
  /** Shared response cache for idempotent GETs. */
  readonly cache: ResponseCache<CallResult>;

  constructor(
    private readonly cfg: McNextConfig,
    private readonly tokens: TokenManager
  ) {
    this.cache = new ResponseCache<CallResult>(cfg.cacheTtlMs, cfg.cacheMaxEntries);
  }

  /** Resolve the base URL for an endpoint's family. */
  baseUrlFor(endpoint: Endpoint): string {
    const base = this.cfg.bases[endpoint.base as keyof McNextConfig['bases']];
    if (!base) {
      throw new Error(
        `No base URL configured for "${endpoint.base}" (endpoint ${endpoint.id}). ` +
          'Check the catalog `api.bases` map and the corresponding environment variable.'
      );
    }
    return base;
  }

  /** Build the fully-qualified URL for an endpoint + options. */
  buildUrl(endpoint: Endpoint, opts: CallOptions): string {
    let path = endpoint.path;

    // Substitute :param segments.
    for (const [key, value] of Object.entries(opts.pathParams ?? {})) {
      path = path.replace(new RegExp(`:${key}(?=/|$)`, 'g'), encodeURIComponent(String(value)));
    }

    const leftover = path.match(/:[A-Za-z0-9_]+/g);
    if (leftover) {
      throw new Error(
        `Missing required path parameter(s) for ${endpoint.id}: ${leftover.join(', ')}`
      );
    }

    const url = new URL(this.baseUrlFor(endpoint) + path);

    // Endpoint-declared query params (skip Postman placeholders / disabled ones).
    for (const qp of endpoint.queryParams) {
      if (qp.disabledInPostman) continue;
      const v = qp.default;
      if (v && !/^\{\{.*\}\}$/.test(v)) url.searchParams.set(qp.name, v);
    }

    // Caller-supplied query params override defaults.
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  /** Execute an endpoint call. */
  async call(endpoint: Endpoint, opts: CallOptions = {}): Promise<CallResult> {
    const url = this.buildUrl(endpoint, opts);
    const method = endpoint.method;

    const { body, contentType } = this.buildBody(endpoint, opts);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (contentType) headers['Content-Type'] = contentType;
    for (const h of endpoint.headers) {
      if (h.value && !/^\{\{.*\}\}$/.test(h.value)) headers[h.name] = h.value;
    }
    Object.assign(headers, opts.headers ?? {});

    // --- Response cache -----------------------------------------------------
    // Only GETs are cacheable; writes are never stored. Errors are never stored
    // either, so a fixed permission problem does not keep looking broken.
    const cacheKey = ResponseCache.key(method, url, headers);
    if (isCacheable(method, opts)) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        log(this.cfg, `cache HIT ${method} ${url}`);
        return { ...hit, cached: true, durationMs: 0 };
      }
    }

    let attempt = 0;
    let reauthed = false;
    const started = Date.now();

    for (;;) {
      attempt++;
      const token = await this.tokens.getToken();
      const res = await this.send(
        method,
        url,
        { ...headers, Authorization: `Bearer ${token}` },
        body
      );

      // 401 -> refresh token once and retry immediately.
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        log(this.cfg, '401 received — refreshing access token and retrying');
        this.tokens.invalidate();
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt <= this.cfg.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(2 ** attempt * 500, 15_000);
        log(this.cfg, `HTTP ${res.status} — retrying in ${backoff}ms (attempt ${attempt})`);
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      const truncated = text.length > MAX_TEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
      const contentTypeHeader = res.headers.get('content-type');

      let data: unknown = null;
      if (contentTypeHeader?.includes('json') || /^\s*[[{]/.test(clipped)) {
        try {
          data = JSON.parse(clipped);
        } catch {
          data = null;
        }
      }

      const result: CallResult = {
        status: res.status,
        ok: res.ok,
        contentType: contentTypeHeader,
        data,
        text: clipped,
        truncated,
        durationMs: Date.now() - started,
        url,
        method,
      };

      // Store only successful GETs. Never cache errors: a 403 caused by a
      // missing scope would otherwise keep looking like a 403 after the scope
      // is fixed.
      if (isCacheable(method, opts) && isCacheableStatus(res.status)) {
        this.cache.set(cacheKey, result);
        log(this.cfg, `cache STORE ${method} ${url} (ttl=${this.cache.ttl}ms)`);
      }

      return result;
    }
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RequestBody | undefined
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    log(this.cfg, `${method} ${url}`);
    try {
      return await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Request to ${method} ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBody(
    endpoint: Endpoint,
    opts: CallOptions
  ): { body: RequestBody | undefined; contentType: string | undefined } {
    if (endpoint.bodyMode === 'formdata') {
      const form = new FormData();
      const fields = endpoint.formFields ?? [];
      const provided = opts.formData ?? {};

      for (const field of fields) {
        const value = provided[field.name];
        if (value === undefined) {
          if (field.required) {
            throw new Error(
              `Missing required form field "${field.name}" for ${endpoint.id}. ` +
                `Expected fields: ${fields.map((f) => f.name).join(', ')}`
            );
          }
          continue;
        }
        if (field.type === 'file') {
          const buf = readFileSync(value);
          form.append(field.name, new Blob([buf]), basename(value));
        } else {
          form.append(field.name, value);
        }
      }
      // Allow extra form fields not declared in the collection.
      for (const [k, v] of Object.entries(provided)) {
        if (!fields.some((f) => f.name === k)) form.append(k, v);
      }
      return { body: form, contentType: undefined }; // fetch sets the boundary
    }

    if (opts.body !== undefined && opts.body !== null) {
      // Non-JSON payloads (e.g. the Ingestion API's CSV bulk upload) are passed
      // through verbatim when the caller supplies a string.
      if (typeof opts.body === 'string' && endpoint.bodyContentType !== 'application/json') {
        return {
          body: opts.body,
          contentType: endpoint.bodyContentType ?? 'text/plain',
        };
      }
      return {
        body: JSON.stringify(opts.body),
        contentType: 'application/json',
      };
    }

    return { body: undefined, contentType: undefined };
  }
}
