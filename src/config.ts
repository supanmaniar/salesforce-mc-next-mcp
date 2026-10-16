/**
 * config.ts — environment-driven configuration.
 *
 * The server talks to three API families, each with its own base URL, plus the
 * Salesforce login host used for OAuth and the platform (SOQL/REST) tools.
 */

/**
 * How the server obtains its Salesforce access token.
 *
 * - `oauth_client_credentials` (default) — a Connected App / External Client
 *   App, using the OAuth 2.0 client-credentials grant. The server acts as that
 *   app's integration user, so its blast radius is bounded by that user's
 *   profile, permission sets, and the scopes granted to the app.
 * - `cli_session` — reuses the access token already stored by the Salesforce
 *   CLI (`sf org login web`). Zero setup, but the server then acts as **you**,
 *   with your full privileges, and its activity is not separately attributable
 *   in Setup. Intended for local, single-developer use only.
 *
 * The distinction is about privilege, not convenience. See docs/AUTH-MODES.md.
 */
export type AuthMode = 'oauth_client_credentials' | 'cli_session';

export interface McNextConfig {
  /** Which credential source to use. See {@link AuthMode}. */
  authMode: AuthMode;

  /**
   * Required in `oauth_client_credentials` mode; ignored in `cli_session` mode.
   */
  clientId: string;
  clientSecret: string;

  /**
   * Salesforce CLI target-org (username or alias) whose stored session is
   * reused in `cli_session` mode. Ignored otherwise.
   */
  sfCliOrg: string;

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

/**
 * Parse `SF_AUTH_MODE`. Accepts the canonical names plus a few forgiving
 * aliases, and returns `undefined` for anything unrecognised so the caller can
 * fail loudly rather than silently falling back to the wrong privilege level.
 */
export function parseAuthMode(raw: string | undefined): AuthMode | undefined {
  if (!raw) return 'oauth_client_credentials';
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (['oauth_client_credentials', 'oauth', 'client_credentials', 'connected_app'].includes(v)) {
    return 'oauth_client_credentials';
  }
  if (['cli_session', 'cli', 'sf_cli', 'sfdx', 'session'].includes(v)) {
    return 'cli_session';
  }
  return undefined;
}

export function loadConfig(): McNextConfig {
  const loginUrl = trimSlash(env('SF_LOGIN_URL') ?? 'https://login.salesforce.com');
  const authModeRaw = env('SF_AUTH_MODE');
  const authMode = parseAuthMode(authModeRaw) ?? 'oauth_client_credentials';

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
    authMode,
    clientId: env('SF_CLIENT_ID') ?? '',
    clientSecret: env('SF_CLIENT_SECRET') ?? '',
    sfCliOrg: env('SF_CLI_ORG') ?? env('SF_TARGET_ORG') ?? '',
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
 * Three cases, all of which would either expose the org broadly or silently run
 * at the wrong privilege level:
 *
 * 1. HTTP bound to a non-loopback host without a bearer token — would expose
 *    every tool to anyone who can reach the port.
 * 2. A bearer token shorter than 16 characters — trivially brute-forced.
 * 3. **`cli_session` mode combined with the HTTP transport.** In CLI mode the
 *    server acts as whoever ran `sf org login`, inheriting their full
 *    privileges with no scoping and no separate audit identity. Over HTTP,
 *    every network caller would therefore operate as that person. This is the
 *    single most dangerous combination the server can be put into, so it is
 *    refused outright rather than warned about.
 */
export function fatalConfigErrors(cfg: McNextConfig): string[] {
  const errors: string[] = [];

  // Reject an unparseable SF_AUTH_MODE rather than defaulting silently: a typo
  // must not decide which identity the server runs as.
  const rawMode = env('SF_AUTH_MODE');
  if (rawMode && !parseAuthMode(rawMode)) {
    errors.push(
      `SF_AUTH_MODE is "${rawMode}", which is not a recognised value. ` +
        'Use "oauth_client_credentials" (default) or "cli_session". ' +
        'See docs/AUTH-MODES.md.'
    );
  }

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
  if (cfg.http.enabled && cfg.authMode === 'cli_session') {
    errors.push(
      'SF_AUTH_MODE=cli_session cannot be combined with MC_NEXT_HTTP_ENABLED=true. ' +
        "CLI session mode runs as the user who ran `sf org login`, with that user's full privileges " +
        'and no separate audit identity. Over HTTP that would let every network caller act as them. ' +
        'Use SF_AUTH_MODE=oauth_client_credentials for the HTTP transport, or keep cli_session ' +
        'on stdio. See docs/AUTH-MODES.md.'
    );
  }

  return errors;
}

/** Names of required env vars that are missing (empty array == fully configured). */
export function missingCredentials(cfg: McNextConfig): string[] {
  const missing: string[] = [];
  // In CLI mode the credentials come from the CLI's stored session, so the
  // Connected App variables are neither required nor meaningful.
  if (cfg.authMode === 'cli_session') return missing;
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
