/**
 * config.ts — environment-driven configuration.
 *
 * The server talks to three API families, each with its own base URL, plus the
 * Salesforce login host used for OAuth and the platform (SOQL/REST) tools.
 */

export interface McNextConfig {
  /** OAuth 2.0 client credentials (Connected App). */
  clientId: string;
  clientSecret: string;

  /** Salesforce login host — used for the OAuth token endpoint. */
  loginUrl: string;

  /** Base URLs, keyed to match `endpoint.base` in the catalog. */
  bases: {
    mcNext: string;
    data360: string;
    data360Connect: string;
    login: string;
  };

  /**
   * Salesforce instance URL used by the platform tools (SOQL, describe, REST
   * explorer, limits). Defaults to the MC Next base's origin when unset.
   */
  instanceUrl: string;

  /** Salesforce API version used by the platform tools. */
  apiVersion: string;

  timeoutMs: number;
  maxRetries: number;
  allowDestructive: boolean;
  /**
   * Gates schema-changing operations (creating/deleting custom objects and
   * custom fields). Separate from `allowDestructive` because metadata changes
   * are materially riskier than deleting a data row.
   */
  allowMetadataChanges: boolean;
  debug: boolean;

  /**
   * Response cache TTL in milliseconds for idempotent GET requests.
   * 0 disables caching entirely. Default 30000 (30s).
   */
  cacheTtlMs: number;
  /** Maximum number of cached responses held in memory. */
  cacheMaxEntries: number;

  /**
   * HTTP transport. Disabled by default: the server is stdio-only unless this
   * is explicitly turned on, because exposing it on a network changes the
   * threat model substantially. See docs/HTTP-DEPLOYMENT.md.
   */
  http: {
    enabled: boolean;
    /** Port to listen on. Default 3000. */
    port: number;
    /**
     * Host to bind. Defaults to 127.0.0.1 (loopback only). Binding 0.0.0.0
     * exposes the server to the network and requires a bearer token.
     */
    host: string;
    /**
     * Optional bearer token. REQUIRED when binding to a non-loopback host.
     * The server refuses to start in that case without one.
     */
    authToken: string;
    /**
     * Extra allowed Host header values, for DNS-rebinding protection when
     * binding beyond loopback. Comma-separated in the environment.
     */
    allowedHosts: string[];
  };

  /**
   * Async job polling defaults. The poll tool accepts per-call overrides.
   */
  poll: {
    intervalMs: number;
    timeoutMs: number;
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Strip a trailing slash so we can safely join paths. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Extract the origin (scheme://host) from a URL, or '' when unparseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function loadConfig(): McNextConfig {
  const loginUrl = trimSlash(env('SF_LOGIN_URL') ?? 'https://login.salesforce.com');

  const mcNext = trimSlash(
    env('MC_NEXT_API_BASE_URL') ?? 'https://YOUR_INSTANCE.my.salesforce.com/services/data/v66.0'
  );
  const data360 = trimSlash(
    env('DATA360_TENANT_URL') ?? 'https://YOUR_TENANT.c360a.salesforce.com'
  );
  const data360Connect = trimSlash(
    env('DATA360_CONNECT_BASE_URL') ??
      'https://YOUR_TENANT.c360a.salesforce.com/services/data/v66.0'
  );

  // The platform tools need a plain instance URL (no /services/data/vXX suffix).
  const instanceUrl = trimSlash(env('SF_INSTANCE_URL') ?? originOf(mcNext) ?? '');

  const httpHost = env('MC_NEXT_HTTP_HOST') ?? '127.0.0.1';

  return {
    clientId: env('SF_CLIENT_ID') ?? '',
    clientSecret: env('SF_CLIENT_SECRET') ?? '',
    loginUrl,
    bases: {
      mcNext,
      data360,
      data360Connect,
      login: loginUrl,
    },
    instanceUrl,
    apiVersion: env('SF_API_VERSION') ?? '66.0',
    timeoutMs: envInt('MC_NEXT_TIMEOUT_MS', 60_000),
    maxRetries: envInt('MC_NEXT_MAX_RETRIES', 3),
    allowDestructive: envBool('MC_NEXT_ALLOW_DESTRUCTIVE', false),
    allowMetadataChanges: envBool('MC_NEXT_ALLOW_METADATA_CHANGES', false),
    debug: envBool('MC_NEXT_DEBUG', false),
    // 0 explicitly disables caching; envInt treats 0 as "unset" so parse it here.
    cacheTtlMs: env('MC_NEXT_CACHE_TTL_MS') === '0' ? 0 : envInt('MC_NEXT_CACHE_TTL_MS', 30_000),
    cacheMaxEntries: envInt('MC_NEXT_CACHE_MAX_ENTRIES', 500),
    http: {
      enabled: envBool('MC_NEXT_HTTP_ENABLED', false),
      port: envInt('MC_NEXT_HTTP_PORT', 3000),
      host: httpHost,
      authToken: env('MC_NEXT_HTTP_AUTH_TOKEN') ?? '',
      allowedHosts: (env('MC_NEXT_HTTP_ALLOWED_HOSTS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    poll: {
      intervalMs: envInt('MC_NEXT_POLL_INTERVAL_MS', 2_000),
      timeoutMs: envInt('MC_NEXT_POLL_TIMEOUT_MS', 120_000),
    },
  };
}

/** True when the configured bind host is loopback-only. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Configuration problems that must prevent startup rather than merely warn.
 *
 * Currently one case: HTTP transport bound to a non-loopback host without a
 * bearer token. That combination would expose every tool — including the
 * destructive ones — to anyone who can reach the port, running as the
 * Connected App's integration user. Refusing to start is the only safe default.
 */
export function fatalConfigErrors(cfg: McNextConfig): string[] {
  const errors: string[] = [];
  if (cfg.http.enabled && !isLoopbackHost(cfg.http.host) && !cfg.http.authToken) {
    errors.push(
      `MC_NEXT_HTTP_HOST is "${cfg.http.host}" (not loopback) but MC_NEXT_HTTP_AUTH_TOKEN is not set. ` +
        'Binding HTTP to a non-loopback host without a bearer token would expose every tool to the ' +
        'network. Set MC_NEXT_HTTP_AUTH_TOKEN, or bind to 127.0.0.1 and use an authenticating reverse proxy. ' +
        'See docs/HTTP-DEPLOYMENT.md.'
    );
  }
  if (cfg.http.enabled && cfg.http.authToken && cfg.http.authToken.length < 16) {
    errors.push(
      `MC_NEXT_HTTP_AUTH_TOKEN is only ${cfg.http.authToken.length} characters. Use at least 16 ` +
        '(e.g. `openssl rand -hex 32`).'
    );
  }
  return errors;
}

/** Names of required env vars that are missing (empty array == fully configured). */
export function missingCredentials(cfg: McNextConfig): string[] {
  const missing: string[] = [];
  if (!cfg.clientId) missing.push('SF_CLIENT_ID');
  if (!cfg.clientSecret) missing.push('SF_CLIENT_SECRET');
  return missing;
}

/**
 * Base URLs that are still set to their placeholder defaults. Calls against
 * these will fail, so we surface them as a startup warning.
 */
export function unconfiguredBases(cfg: McNextConfig): string[] {
  const out: string[] = [];
  if (cfg.bases.mcNext.includes('YOUR_INSTANCE')) out.push('MC_NEXT_API_BASE_URL');
  if (cfg.bases.data360.includes('YOUR_TENANT')) out.push('DATA360_TENANT_URL');
  if (cfg.bases.data360Connect.includes('YOUR_TENANT')) out.push('DATA360_CONNECT_BASE_URL');
  return out;
}

export function log(cfg: McNextConfig, ...args: unknown[]): void {
  if (cfg.debug) console.error('[mc-next-mcp]', ...args);
}
