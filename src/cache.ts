/**
 * cache.ts — in-memory response cache for idempotent GET requests.
 *
 * Purpose: cut API consumption. Every tool call currently hits Salesforce, so
 * repeated `sf_describe_object` or catalog `query` calls each cost an API
 * request against the org's daily allowance.
 *
 * Design constraints, in order of importance:
 *
 *  1. **Never cache a non-GET.** A POST/PATCH/DELETE response is not a function
 *     of its URL alone, and serving a stale write response would be wrong.
 *  2. **Never cache an error.** A 403 today may be a 200 after a scope change;
 *     caching a failure would make the server appear broken long after it was
 *     fixed.
 *  3. **Never cache auth.** The `Authorization` header is excluded from the key,
 *     but a 401 response is never stored (covered by rule 2).
 *  4. **Bounded.** A fixed entry cap with LRU eviction, so a long-running
 *     server cannot grow without limit.
 *  5. **Off by default when TTL is 0.** Callers can disable it entirely.
 *
 * This is a deliberately simple, single-process cache. It is not shared across
 * instances, and it does not persist. See docs/PERFORMANCE.md.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expired: number;
  entries: number;
  enabled: boolean;
}

export class ResponseCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;

  constructor(
    private ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** Build a stable key. Header order must not matter. */
  static key(method: string, url: string, headers: Record<string, string> = {}): string {
    const sortedHeaders = Object.keys(headers)
      .filter((h) => h.toLowerCase() !== 'authorization')
      .sort()
      .map((h) => `${h.toLowerCase()}=${headers[h]}`)
      .join('&');
    return `${method.toUpperCase()} ${url}${sortedHeaders ? `|${sortedHeaders}` : ''}`;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;

    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      this.expired++;
      this.misses++;
      return undefined;
    }

    // Refresh LRU position: delete + re-set moves it to the end.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;

    // Evict oldest (first inserted) entries until we are under the cap.
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }

    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop everything. Used by the manual invalidation tool. */
  clear(): number {
    const n = this.map.size;
    this.map.clear();
    return n;
  }

  /** Adjust the TTL at runtime (used by the cache tool). 0 disables. */
  setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
    if (ttlMs === 0) this.map.clear();
  }

  get ttl(): number {
    return this.ttlMs;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expired: this.expired,
      entries: this.map.size,
      enabled: this.enabled,
    };
  }
}

/**
 * Is this request safe to cache?
 *
 * Only GET, and only when the caller has not asked to bypass. Everything else
 * is rejected regardless of TTL, because a write response is not reproducible
 * from its URL.
 */
export function isCacheable(method: string, opts: { bypassCache?: boolean } = {}): boolean {
  if (opts.bypassCache) return false;
  return method.toUpperCase() === 'GET';
}

/** Status codes worth storing: success only. */
export function isCacheableStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
