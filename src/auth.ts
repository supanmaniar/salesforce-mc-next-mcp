/**
 * auth.ts — Salesforce access-token acquisition.
 *
 * Two interchangeable sources, selected by `SF_AUTH_MODE`:
 *
 * - `oauth_client_credentials` (default) — the OAuth 2.0 client-credentials
 *   grant against a Connected App / External Client App. Scoped, auditable, and
 *   the only mode suitable for shared, headless, or HTTP deployment.
 * - `cli_session` — reuses the token the Salesforce CLI already holds for a
 *   target org. Convenient for local development, but the server then runs as
 *   that user with their full privileges.
 *
 * All three API families (Marketing Cloud Next, Data 360, Data 360 Connect) are
 * reached with the same access token, so a single token manager serves the
 * whole server. See docs/AUTH-MODES.md for how to choose.
 */

import { execFile } from 'node:child_process';
import type { McNextConfig } from './config.js';
import { log } from './config.js';

interface TokenResponse {
  access_token: string;
  instance_url?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  instanceUrl?: string;
  username?: string;
}

/** Refresh this many ms before the real expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SKEW_MS = 60_000;

/** How long a `sf org display` result is trusted before being re-read. */
const CLI_CACHE_MS = 10 * 60 * 1000;

export class TokenManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  /**
   * In CLI mode the CLI's own token is authoritative, so `invalidate()` cannot
   * simply drop it — doing so and re-reading would return the same expired
   * token, and the documented 401-retry would loop. Instead we remember that a
   * refresh is required so the *next* read bypasses the CLI cache.
   */
  private forceCliRefresh = false;

  constructor(private readonly cfg: McNextConfig) {}

  /** Returns a valid access token, fetching one if necessary. */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.accessToken;
    }
    // De-duplicate concurrent refreshes.
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken()
      .then((token) => {
        this.inflight = null;
        return token;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });

    return this.inflight;
  }

  /**
   * The instance URL reported alongside the token, when available. Useful
   * for the platform tools when SF_INSTANCE_URL was not set explicitly.
   */
  get instanceUrl(): string | undefined {
    return this.cached?.instanceUrl;
  }

  /**
   * Whether the cached token came from a CLI session. Exposed so the overview
   * resource can report the effective privilege level, not just the configured
   * mode.
   */
  get viaCliSession(): boolean {
    return this.cfg.authMode === 'cli_session';
  }

  /** The Salesforce username the current token belongs to, when known. */
  get username(): string | undefined {
    return this.cached?.username;
  }

  /** Drops the cached token so the next call re-authenticates. */
  invalidate(): void {
    if (this.cfg.authMode === 'cli_session') {
      // Force a fresh `sf org display` on the next read: the CLI may have
      // refreshed the session since we last looked.
      this.forceCliRefresh = true;
      this.cached = null;
      return;
    }
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    return this.cfg.authMode === 'cli_session' ? this.fetchFromCli() : this.fetchFromOAuth();
  }

  // --- Connected App / External Client App ----------------------------------

  private async fetchFromOAuth(): Promise<string> {
    const url = `${this.cfg.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });

    log(this.cfg, `POST ${url} (grant_type=client_credentials)`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`OAuth token request failed (network): ${reason}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    let json: TokenResponse;
    try {
      json = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error(
        `OAuth token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`
      );
    }

    if (!res.ok || json.error || !json.access_token) {
      const detail = json.error_description ?? json.error ?? text.slice(0, 300);
      throw new Error(
        `OAuth token request failed (HTTP ${res.status}): ${detail}. ` +
          'Verify SF_CLIENT_ID / SF_CLIENT_SECRET and that the Connected App has the ' +
          'required scopes enabled (e.g. sfdc_cms_api, cdpr_query_api, cdp_profile_api, ' +
          'cdp_ingest_api) and that client-credentials flow is permitted.'
      );
    }

    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.cached = {
      accessToken: json.access_token,
      expiresAt: Date.now() + Math.max(ttlMs - EXPIRY_SKEW_MS, 30_000),
      instanceUrl: json.instance_url,
    };

    log(
      this.cfg,
      `OAuth token acquired (expires_in=${json.expires_in ?? 'unknown'}s, instance=${json.instance_url ?? 'n/a'})`
    );
    return json.access_token;
  }

  // --- Salesforce CLI session ----------------------------------------------

  /**
   * Read the access token the Salesforce CLI already holds.
   *
   * `sf org display --json` prints an update-availability warning before the
   * JSON payload on some versions, so we slice from the first brace rather than
   * parsing stdout directly.
   *
   * The CLI reports no `expires_in`, and its stored token may already be stale.
   * Rather than guess a lifetime, we cache for a short window and rely on the
   * caller's existing 401 handling to re-read; `invalidate()` bypasses the
   * cache so that retry actually makes progress.
   */
  private async fetchFromCli(): Promise<string> {
    const bypassCache = this.forceCliRefresh;
    this.forceCliRefresh = false;

    if (!bypassCache && this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.accessToken;
    }

    const args = ['org', 'display', '--json'];
    if (this.cfg.sfCliOrg) args.push('--target-org', this.cfg.sfCliOrg);

    log(this.cfg, `exec: sf ${args.filter((a) => a !== '--json').join(' ')} (cli_session mode)`);

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'sf',
        args,
        { maxBuffer: 10 * 1024 * 1024, timeout: this.cfg.timeoutMs },
        (err, out) => {
          if (err) {
            const hint = this.cfg.sfCliOrg
              ? `Is the alias "${this.cfg.sfCliOrg}" authenticated? Run \`sf org list\`.`
              : 'Set SF_CLI_ORG (username or alias) if more than one org is authenticated.';
            reject(
              new Error(
                `Salesforce CLI session could not be read (cli_session mode): ${err.message}. ${hint} ` +
                  'Alternatively set SF_AUTH_MODE=oauth_client_credentials and provide SF_CLIENT_ID / SF_CLIENT_SECRET.'
              )
            );
            return;
          }
          resolve(out);
        }
      );
    });

    const start = stdout.indexOf('{');
    if (start < 0) {
      throw new Error(
        'Salesforce CLI returned no JSON. Check that `sf` is on PATH and the org is authenticated.'
      );
    }

    let result: {
      accessToken?: string;
      instanceUrl?: string;
      username?: string;
      connectedStatus?: string;
    };
    try {
      result = JSON.parse(stdout.slice(start))['result'] ?? {};
    } catch {
      throw new Error('Salesforce CLI returned unparseable JSON.');
    }

    if (!result.accessToken || !result.instanceUrl) {
      throw new Error(
        `Salesforce CLI reported no usable session for "${result.username ?? this.cfg.sfCliOrg ?? 'default org'}" ` +
          `(connectedStatus=${result.connectedStatus ?? 'unknown'}). Re-authenticate with \`sf org login web\`.`
      );
    }

    // The CLI does not tell us when its token expires, so we re-read it
    // periodically rather than trusting it for the full session.
    this.cached = {
      accessToken: result.accessToken,
      expiresAt: Date.now() + CLI_CACHE_MS,
      instanceUrl: result.instanceUrl.replace(/\/+$/, ''),
      username: result.username,
    };

    log(
      this.cfg,
      `CLI session token acquired (org=${result.username ?? 'unknown'}, instance=${result.instanceUrl})`
    );
    return result.accessToken;
  }
}
