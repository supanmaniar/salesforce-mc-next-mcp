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
  debug: boolean;
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
  const instanceUrl = trimSlash(
    env('SF_INSTANCE_URL') ?? originOf(mcNext) ?? ''
  );

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
    debug: envBool('MC_NEXT_DEBUG', false),
  };
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
