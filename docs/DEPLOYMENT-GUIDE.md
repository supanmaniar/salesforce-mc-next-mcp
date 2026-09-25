# Deployment Guide

How to run, containerize, configure, and monitor `mc-next-mcp-server`.

---

## Transport model (read this first)

The server uses **stdio transport only**. It speaks JSON-RPC over **stdin/stdout**
and opens **no network port**. This shapes every deployment decision below:

- It cannot be hosted as a shared remote endpoint that clients connect to over
  HTTP. There is no HTTP/SSE transport.
- Whatever launches it must **attach stdin**. In Docker, that means `docker run -i`.
- Each client (VS Code, Claude Desktop, a CLI) launches **its own instance**.
- Because the token is cached **in memory only**, each instance holds its own
  token and re-authenticates on restart.

> **Consequence:** "deploying" this server means putting the code somewhere a
> client can launch it — a local clone, a container image, or a machine the client
> has shell access to. It does not mean running a service on a port.

### The cardinal rule: never write to stdout

stdout **is** the MCP protocol channel. A stray `console.log` corrupts the
stream and the client drops the connection with a confusing parse error.

- All diagnostics go to **stderr**.
- `MC_NEXT_DEBUG` logging goes to stderr.
- Startup warnings go to stderr.
- If you add code, use `console.error`, never `console.log`.

This is why the server never prints a banner or a "ready" line to stdout.

---

## Local development

### Setup

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
npm run build
```

### Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | `tsc --watch` — recompile on change |
| `npm run start` | Run the built server (`node dist/index.js`) |
| `npm run smoke` | End-to-end MCP client test, **no credentials needed** |
| `npm run generate` | Regenerate `catalog/endpoints.json` from Postman collections |
| `npm run audit` | Fidelity checks on the catalog |

### Running it by hand

```bash
node dist/index.js
```

With no credentials it prints a warning to **stderr** and then waits silently on
stdin — that silence is correct. It is waiting for JSON-RPC, not hanging.

A quick manual smoke of the protocol:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js 2>/dev/null | head -c 800
```

### The `dev` loop

```bash
npm run dev          # terminal 1: watch + recompile
npm run smoke        # terminal 2: verify after each change
```

Restart your MCP client after a rebuild — it holds the old process.

### Why the catalog is not regenerated in dev

`catalog/endpoints.json` **is committed**, so a fresh clone builds and runs
without ever running `npm run generate`. The generator reads the official
Salesforce Postman collections from `../Marketing Cloud Next MCP Prep`, which is
**not in the repository** (excluded for licensing). Regeneration is therefore only
possible where those collections exist — see
[CONTRIBUTING.md](../CONTRIBUTING.md#the-catalog-regeneration-workflow).

---

## Docker

A `Dockerfile` is provided at the repository root. Docker is **not required** for
local use — it is for reproducibility and for machines where you want a
hermetic build.

> **Full Docker documentation lives in [DOCKER-DEPLOYMENT.md](DOCKER-DEPLOYMENT.md)** —
> including client integration, `docker-compose.yml` usage, volume mounting, and
> an explanation of why `docker compose up -d` cannot work for a stdio server.
> The summary below is a quick reference.

### Build

```bash
docker build -t mc-next-mcp-server:1.0.0 .
```

The image is a multi-stage build:

1. **build stage** — `npm ci` (lockfile-pinned), `tsc`, then `npm prune --omit=dev`
2. **runtime stage** — production deps + `dist/` + `catalog/`, running as the
   non-root `node` user

The final image contains no devDependencies, no TypeScript sources, and no
credentials.

### Layout constraint

`src/catalog.ts` resolves the catalog as `dist/../catalog/endpoints.json`. The
image therefore keeps `dist/` and `catalog/` as **siblings** at `/app`:

```
/app
├── dist/index.js          <- entrypoint
├── catalog/endpoints.json <- resolved as dist/../catalog
└── node_modules/
```

If you restructure the image, preserve that relationship or the server exits with
a catalog-not-found error.

### Run

The container is stdio-only, so `-i` is **mandatory** — without an attached stdin
there is no channel and the server cannot respond:

```bash
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0
```

Point a client at it:

```json
{
  "mcpServers": {
    "mc-next": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/mc-next-mcp-server/.env",
        "mc-next-mcp-server:1.0.0"
      ]
    }
  }
}
```

### Verifying the image

```bash
# Catalog is present and parseable
docker run --rm mc-next-mcp-server:1.0.0 \
  node -e "const c=require('/app/catalog/endpoints.json');console.log(c.endpoints.length)"
# -> 445

# Runs as non-root
docker run --rm mc-next-mcp-server:1.0.0 node -e "console.log(process.getuid())"
# -> 1000
```

### Docker notes and gotchas

- **`-i` is not optional.** Omitting it produces a server that starts and
  immediately exits with no output.
- **Do not pass `-t`.** A TTY can corrupt the stdio framing. Use `-i` alone.
- **`--env-file` expects `KEY=value` lines** — it does not understand shell
  expansions like `$OTHER_VAR`. A `.env` produced for a shell may need
  simplifying.
- **`HEALTHCHECK` is informational here.** Because there is no port, Docker's
  health status is not consumed by anything; the check confirms the catalog is
  readable. It is useful when running under an orchestrator that reads container
  health, but it cannot validate Salesforce connectivity.
- **No `EXPOSE`, no port.** There is nothing to publish.
- **Secrets:** prefer `--env-file` over `-e` on the command line. Command-line
  args are visible in `docker inspect` and shell history.

---

## Environment variable management

The server reads configuration from the **process environment**. It does **not**
auto-load `.env` files — the file is a convenience for how you *supply* the
environment, not something the server parses.

### Full variable reference

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SF_CLIENT_ID` | ✅ | — | Connected App consumer key |
| `SF_CLIENT_SECRET` | ✅ | — | Connected App consumer secret |
| `MC_NEXT_API_BASE_URL` | ✅ | placeholder | Core org + `/services/data/vXX` |
| `DATA360_TENANT_URL` | ✅ | placeholder | `c360a` host, **no** path suffix |
| `DATA360_CONNECT_BASE_URL` | ✅ | placeholder | `c360a` host **with** `/services/data/vXX` |
| `SF_LOGIN_URL` | | `https://login.salesforce.com` | Use `test.salesforce.com` for sandboxes |
| `SF_INSTANCE_URL` | | origin of `MC_NEXT_API_BASE_URL` | Platform-tool target |
| `SF_API_VERSION` | | `66.0` | Platform-tool API version |
| `MC_NEXT_TIMEOUT_MS` | | `60000` | Per-request timeout |
| `MC_NEXT_MAX_RETRIES` | | `3` | Retries for 429/5xx |
| `MC_NEXT_ALLOW_DESTRUCTIVE` | | `false` | **Safety gate** |
| `MC_NEXT_ALLOW_METADATA_CHANGES` | | `false` | **Safety gate** |
| `MC_NEXT_DEBUG` | | `false` | Log HTTP to stderr |

Boolean parsing accepts `true`, `1`, or `yes` (case-insensitive). Anything else is
`false`.

### Missing vs. placeholder configuration

The server distinguishes two failure modes and warns about both at startup — on
**stderr**, without refusing to start:

| Condition | Behaviour |
| --- | --- |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` missing | Warns; **catalog browsing still works**; API calls fail |
| A base URL still contains `YOUR_INSTANCE` / `YOUR_TENANT` | Warns; calls to that family fail |

This is deliberate: you can verify the wiring and explore the 445-endpoint
catalog before you have credentials.

### Supply methods

**1. MCP client `env` block** — simplest, and what most users should use.

```json
{ "env": { "SF_CLIENT_ID": "...", "SF_CLIENT_SECRET": "..." } }
```

**2. `node --env-file`** — for local runs.

```bash
node --env-file=.env dist/index.js
```

Note this requires Node 20.6+. On Node 18, use `dotenv` or your shell:

```bash
set -a; source .env; set +a; node dist/index.js
```

**3. VS Code `envFile`** — see
[VS-CODE-SETUP.md](VS-CODE-SETUP.md#using-envfile-instead).

**4. Docker `--env-file`** — see [above](#run).

### Secrets hygiene

`.env` is already in `.gitignore`. Beyond that:

- **Never commit real credentials.** Not in `mcp.json`, not in a Dockerfile
  `ENV`, not in a Compose file.
- **Workspace-level MCP configs are shared via git.** Use VS Code's `inputs`
  mechanism (which stores the value in the OS keychain) or `envFile` instead of
  inlining a secret.
- **Prefer short-lived or rotatable credentials.** Salesforce
  client-credentials secrets do not expire on their own, so a leaked secret stays
  valid until regenerated. Rotate on a schedule — see
  [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#rotation).

### GitHub Actions

Store credentials as **repository or environment secrets**, never in the
workflow file. Map them into the environment at the step that needs them:

```yaml
name: smoke
on: [push, pull_request]

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run build

      # No credentials needed: asserts the tool surface and both safety gates.
      - run: npm run smoke

      # Optional: a live check against a sandbox org.
      - name: Live auth check
        if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
        env:
          SF_CLIENT_ID: ${{ secrets.SF_CLIENT_ID }}
          SF_CLIENT_SECRET: ${{ secrets.SF_CLIENT_SECRET }}
          MC_NEXT_API_BASE_URL: ${{ secrets.MC_NEXT_API_BASE_URL }}
          DATA360_TENANT_URL: ${{ secrets.DATA360_TENANT_URL }}
          DATA360_CONNECT_BASE_URL: ${{ secrets.DATA360_CONNECT_BASE_URL }}
          SF_LOGIN_URL: https://test.salesforce.com
        run: node scripts/smoke-test.mjs
```

Guidance:

- **Gate live tests to a branch and use a sandbox org.** Never point CI at
  production credentials.
- **Use GitHub *environment* secrets with required reviewers** if a workflow can
  touch production data.
- **Do not enable the safety gates in CI** unless the job is specifically testing
  them. The smoke test already exercises the gated paths in-process by spawning a
  second server with the flags set — it does not need them in the ambient
  environment.
- **Never echo a secret.** Avoid `set -x` in steps that handle credentials.

### Other platforms

| Platform | Approach |
| --- | --- |
| AWS Secrets Manager / SSM | Fetch at launch into the process environment |
| Azure Key Vault | Same, via managed identity |
| HashiCorp Vault | `vault kv get -format=json` piped into the launcher |
| Kubernetes | `Secret` → `envFrom` (note: stdio means this needs a client-side launcher, not a Service) |

---

## Multi-org scenarios

The server is designed around **one org (and one Data 360 tenant) per instance**.
Base URLs are fixed at startup from the environment, so there is no runtime
switching.

### Run one instance per org

Define multiple servers, each with its own name and `env`:

```json
{
  "servers": {
    "mc-next-prod": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "prod_key",
        "SF_CLIENT_SECRET": "prod_secret",
        "MC_NEXT_API_BASE_URL": "https://prod.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://prod-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://prod-tenant.c360a.salesforce.com/services/data/v66.0"
      }
    },
    "mc-next-sandbox": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "sandbox_key",
        "SF_CLIENT_SECRET": "sandbox_secret",
        "MC_NEXT_API_BASE_URL": "https://sandbox.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://sandbox-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://sandbox-tenant.c360a.salesforce.com/services/data/v66.0",
        "SF_LOGIN_URL": "https://test.salesforce.com"
      }
    }
  }
}
```

Each instance has an independent token cache and its own safety-gate settings —
which is a genuine advantage. A common pattern is to keep `mc-next-prod` fully
locked down and enable `MC_NEXT_ALLOW_DESTRUCTIVE` only on the sandbox instance.

### Reduce risk by naming clearly

Use names that make the target obvious (`-prod`, `-uat`, `-sandbox`). When a model
picks a tool, the server name is the only signal about which org it will touch.

### Things to be careful about

- **Sandboxes need `SF_LOGIN_URL=https://test.salesforce.com`.** Omitting this is
  the most common multi-org mistake — authentication fails or, worse, silently
  targets the wrong host.
- **Separate Connected Apps per org.** Do not reuse one app's credentials across
  orgs; they are org-scoped and will not work anyway.
- **The token cache is per-instance.** Two instances means two tokens, which is
  correct but doubles the token requests.
- **No cross-org queries.** There is no way to join data across two instances in
  a single tool call; the model would have to call both and combine the results
  itself.

---

## Logging

Logging is deliberately minimal and goes entirely to **stderr**.

### Enabling debug logging

```bash
MC_NEXT_DEBUG=true node dist/index.js
```

Or via the client's `env` block:

```json
"env": { "MC_NEXT_DEBUG": "true" }
```

### What gets logged

Every line is prefixed `[mc-next-mcp]`:

| Event | Example |
| --- | --- |
| Token acquisition | `POST https://login.salesforce.com/services/oauth2/token (grant_type=client_credentials)` |
| Token result | `OAuth token acquired (expires_in=7200s, instance=https://...)` |
| Each request | `GET https://my-org.my.salesforce.com/services/data/v66.0/...` |
| Re-auth on 401 | `401 received — refreshing access token and retrying` |
| Retry with backoff | `HTTP 429 — retrying in 4000ms (attempt 2)` |
| Startup | `mc-next-mcp-server v1.0.0 running on stdio` |
| Catalog stats | `catalog: 445 endpoints / 44 groups / 3 families` |

### What is never logged

- **Credentials.** Neither the client secret nor the bearer token is ever written.
- **Anything on stdout.** Ever.

> Note that the request log includes full URLs, which may contain record IDs or
> query strings. Treat debug logs as potentially sensitive and do not attach them
> to public issues without reviewing them.

### Capturing stderr

**VS Code** — the **Output** panel, selecting the MCP server's channel.

**Claude Desktop** — `mcp-server-mc-next.log` in the logs directory
(`~/Library/Logs/Claude/` on macOS, `%APPDATA%\Claude\logs\` on Windows).

**Manual / systemd** — redirect stderr to a file:

```bash
node dist/index.js 2>>/var/log/mc-next-mcp.log
```

**systemd** — capture stderr via the journal:

```ini
[Service]
ExecStart=/usr/bin/node /opt/mc-next-mcp-server/dist/index.js
StandardError=journal
StandardOutput=journal
EnvironmentFile=/etc/mc-next-mcp-server.env
Restart=on-failure
User=mcnext
```

Then `journalctl -u mc-next-mcp -f`. The `Restart=on-failure` line is useful
because a stdio server with no attached client exits — that is expected, not a
crash loop to fix.

### Redacting before sharing

If you need to share logs, scrub first:

- bearer tokens (`Authorization: Bearer ...`)
- the consumer secret
- org-specific hostnames, if they are sensitive
- record IDs in URLs

---

## Monitoring

### What can and cannot be monitored

Because there is no port, **there is no endpoint to poll**. Standard
port-and-HTTP health checks do not apply. Monitoring is therefore
**client-side** — the client that launches the server is the only observer.

### Health signals available

| Signal | How | Meaning |
| --- | --- | --- |
| Startup success | `mc-next-mcp-server v1.0.0 running on stdio` on stderr | Server booted, catalog loaded |
| Catalog loaded | `catalog: 445 endpoints / 44 groups / 3 families` | Catalog parsed correctly |
| Missing credentials | `WARNING: missing required environment variable(s)` | Auth will fail |
| Placeholder bases | `WARNING: base URL(s) still at placeholder defaults` | Wrong URLs |
| Catalog parse failure | Fatal error + exit code 1 | `catalog/endpoints.json` missing/corrupt |
| Process exit | Client reports the server stopped | Client will restart it |

### Catalog integrity check

The Dockerfile's `HEALTHCHECK` verifies the catalog is readable. The same check
works anywhere:

```bash
node -e "const c=require('./catalog/endpoints.json');console.log(c.endpoints.length)"
# -> 445
```

A count other than **445** means the catalog was regenerated from different
source collections. Not necessarily wrong, but worth confirming.

### Token refresh behaviour

Understanding this prevents false alarms:

- Tokens are cached **in memory** and refreshed **60 seconds before expiry** to
  avoid edge-of-expiry 401s.
- Salesforce client-credentials tokens typically live **~2 hours**.
- A `401` triggers **one** transparent refresh-and-retry. If that also fails, the
  error surfaces to the caller.
- The token is **not persisted**. Every restart re-authenticates.
- Concurrent refreshes are **de-duplicated** — a burst of tool calls at startup
  produces one token request, not many.

**What this means operationally:** there is nothing to monitor for token health
long-term. A restart is always a cold start. If you see repeated
`401 — refreshing` lines, suspect a revoked or rotated secret.

### Rate limits

The server **does not track or budget** the org's API allowance. It retries
`429` and `5xx` with exponential backoff (honouring `Retry-After` when present,
capped at 15s), but it will happily issue calls until Salesforce refuses them.

Practical guidance:

- Call **`sf_org_limits`** before bulk work — it reports current API usage.
- Keep `MC_NEXT_MAX_RETRIES` at its default of `3`. Raising it delays failures
  without preventing them.
- For large record operations, remember the Composite cap of **200 records per
  call** (`sf_bulk_*`) and **25 subrequests** (`sf_composite`). Batching at those
  limits is far cheaper than many small calls.
- If you need sustained throughput, add a queue with its own rate limiting in
  front of the server rather than relying on retries.

### Response caching

There is **no response caching**. Every tool call hits Salesforce, so repeated
`sf_describe_object` or `sf_list_objects` calls each cost an API request. If you
find the model re-describing the same object, that is the cause — and it is a
candidate for a contribution.

### Suggested monitoring checklist

| Check | Frequency | Action if it fails |
| --- | --- | --- |
| `npm run smoke` in CI | Every push | Investigate the failing assertion |
| Catalog count is 445 | Per build | Confirm the catalog was not regenerated unexpectedly |
| Startup log line present | Per client launch | Check stderr for the fatal error |
| No credential warnings | Per client launch | Fix `env` configuration |
| `sf_org_limits` usage | Before bulk work | Throttle or wait for the daily reset |
| Secret rotation | On a schedule | Regenerate; update all deployments |

---

## Deployment checklist

Before pointing anything at a **production** org:

- [ ] `npm run build` and `npm run smoke` both pass
- [ ] Credentials are stored outside version control
- [ ] The Connected App uses a dedicated least-privilege integration user
- [ ] Only the scopes you need are enabled
- [ ] `MC_NEXT_ALLOW_DESTRUCTIVE` is **unset or `false`**
- [ ] `MC_NEXT_ALLOW_METADATA_CHANGES` is **unset or `false`**
- [ ] `SF_LOGIN_URL` matches the org type (production vs. sandbox)
- [ ] All three base URLs are real — no `YOUR_INSTANCE` / `YOUR_TENANT` left
- [ ] The Data 360 host is `c360a`, not `my.salesforce.com`
- [ ] `MC_NEXT_DEBUG` is `false`
- [ ] You have verified against a sandbox first
- [ ] You know the secret rotation procedure

---

## Next steps

- [VS-CODE-SETUP.md](VS-CODE-SETUP.md)
- [CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md)
- [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md)
