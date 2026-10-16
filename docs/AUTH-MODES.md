# Authentication Modes

`mc-next-mcp-server` can obtain its Salesforce access token two ways. The choice
is a security decision, not a convenience one, so it is explicit and defaults to
the safer option.

| | `oauth_client_credentials` (default) | `cli_session` |
| --- | --- | --- |
| **Setup** | Connected App / External Client App, scopes, secret | None — reuse `sf org login` |
| **Server acts as** | The app's integration user | **You**, the CLI user |
| **Blast radius** | Bounded by that user's profile, permission sets, and granted scopes | Everything you can do |
| **Audit trail** | Distinct app and user in Setup | Indistinguishable from your own activity |
| **Least privilege** | Yes — grant only what the tools need | No — inherits your full access |
| **Works headless / CI / Docker** | Yes | No |
| **Shared between people** | Yes | No — one session per machine |
| **HTTP transport** | Allowed | **Refused at startup** |

Set it with a single variable:

```bash
SF_AUTH_MODE=oauth_client_credentials   # default; omit entirely for this
SF_AUTH_MODE=cli_session                # local development only
```

Unrecognised values are a **fatal startup error**, not a silent fallback. A typo
must never decide which identity the server runs as.

---

## Which should I use?

**Use `oauth_client_credentials` when the server is:**

- Shared with a team, or run anywhere other than your machine
- Running in CI, Docker, a container, or on a schedule
- Exposed over the HTTP transport
- Touching production data
- Doing anything you would want a separate audit trail for

**Use `cli_session` when the server is:**

- Local, single developer, interactive exploration
- stdio only
- Not being shipped or shared

If you are unsure, use `oauth_client_credentials`. It is the default for a
reason.

---

## `oauth_client_credentials` (default)

The server performs an OAuth 2.0 client-credentials grant and runs as the
Connected App's integration user. Salesforce sharing rules and field-level
security apply to that user, so what the server can reach is exactly what you
grant it.

### Required

```bash
SF_CLIENT_ID=your_consumer_key
SF_CLIENT_SECRET=your_consumer_secret
```

Follow [SALESFORCE-CONNECTED-APP-GUIDE.md](./SALESFORCE-CONNECTED-APP-GUIDE.md)
to create the app. Enable only the scopes you need:

| Scope | Unlocks |
| --- | --- |
| `sfdc_cms_api` | Marketing Cloud Next (Content / CMS) |
| `cdp_query_api` | Data 360 query |
| `cdp_profile_api` | Data 360 profile |
| `cdp_ingest_api` | Data 360 ingestion |

### Why it is the default

A dedicated integration user is a **separate identity**. When something goes
wrong, Setup shows you the app's activity rather than a person's; and if the
credentials leak, the damage is bounded by a permission set you chose.

---

## `cli_session`

Reuses the access token the Salesforce CLI already holds. The server shells out to
`sf org display --json` and uses whatever token that returns.

```bash
SF_AUTH_MODE=cli_session
SF_CLI_ORG=me@example.com          # optional; username or alias
```

`SF_CLIENT_ID` and `SF_CLIENT_SECRET` are **not required** in this mode, and are
ignored if present.

If `SF_CLI_ORG` is omitted, the CLI's default org is used. With more than one org
authenticated, set it explicitly — the server cannot guess which you meant.

### Why it is convenient

No Connected App, no scopes, no secret to store. `sf org login web` and you are
done.

### Why it is not a deployment mode

The server runs **as you**. Every tool call carries your full privileges. In the
session shown below, the server had admin rights over the whole org:

```
[mc-next-mcp-server] NOTICE: SF_AUTH_MODE=cli_session — this server is running as
the Salesforce CLI user for "me@example.com", with that user's full privileges.
Its API activity is not separately attributable in Setup. Intended for local
development on stdio; use SF_AUTH_MODE=oauth_client_credentials for anything shared.
```

That notice is printed on **every startup** in this mode, deliberately. It is easy
to enable this once for a quick test and forget it.

### The one hard rule

```
SF_AUTH_MODE=cli_session  +  MC_NEXT_HTTP_ENABLED=true  ->  refuses to start
```

```
FATAL: SF_AUTH_MODE=cli_session cannot be combined with MC_NEXT_HTTP_ENABLED=true.
CLI session mode runs as the user who ran `sf org login`, with that user's full
privileges and no separate audit identity. Over HTTP that would let every network
caller act as them.
```

Every caller of an HTTP-bound MCP server shares one identity — there is no
per-request user. With a Connected App, that identity is a scoped integration
user. With a CLI session, it would be **you**, so anyone able to reach the port
could act with your admin rights. This combination is refused rather than warned
about.

### Token lifetime

The CLI does not report an expiry for its stored token, so the server re-reads it
every 10 minutes rather than assuming a lifetime. If Salesforce returns `401`, the
server refreshes and retries once — in this mode that refresh re-invokes the CLI,
so a token the CLI has since renewed is picked up automatically.

---

## Security comparison in one place

| Risk | `oauth_client_credentials` | `cli_session` |
| --- | --- | --- |
| Credential leak — scope | Bounded by granted scopes | Full user access |
| Incident attribution | Separate app + user | Looks like your activity |
| Over-privileged by default | No | Yes |
| Survives laptop loss | Yes (secret is stored deliberately) | Token sits in your CLI keychain |
| Safe to expose over HTTP | Yes, with a bearer token | **No — refused** |
| Safe to share | Yes | No |

Full threat model: [SECURITY.md](../SECURITY.md).

---

## Adding a third mode

`TokenManager` (in `src/auth.ts`) has one `getToken()` entry point and switches on
`cfg.authMode` inside `fetchToken()`. Supporting JWT bearer flow or a refresh-token
flow means adding one branch and one `AuthMode` member; `fatalConfigErrors()` in
`src/config.ts` is the place to add any combination that must be refused.

Any new mode should answer one question explicitly: **whose privileges does the
server run with, and can a caller escalate?** If the answer is not obviously
"bounded", it belongs in the HTTP refusal list alongside `cli_session`.
