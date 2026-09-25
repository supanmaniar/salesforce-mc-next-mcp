# HTTP Deployment

Running `mc-next-mcp-server` as a network service instead of a local stdio process.

> **Read the two warnings below before enabling this.** HTTP removes the single
> strongest security property of the default deployment, and it does **not** give
> you per-user identity.

---

## Two things to understand first

### 1. Anyone who can reach the port can call every tool

In stdio mode, the only thing that can talk to the server is the process that
launched it. Over HTTP, that is no longer true.

The tools remain subject to the two safety gates, so destructive operations and
schema changes are still blocked by default. But **everything else is reachable** —
including the 180 non-destructive write operations and `sf_rest_request`, which
permits arbitrary `POST`/`PATCH`/`PUT` on the core org. See
[SECURITY.md](../SECURITY.md#-what-the-gates-do-not-do--read-this).

This is why a bearer token is **mandatory** for any non-loopback bind. The server
refuses to start without one.

### 2. Every caller acts as the same Salesforce user

This is the most important limitation, and it is **not** a bug in the transport —
it is a consequence of the authentication model.

The server authenticates with OAuth **client-credentials**, which has no user
context. There is one integration user. So:

| What you might expect | What actually happens |
| --- | --- |
| Each caller has their own Salesforce identity | ❌ No — all calls use the integration user |
| Salesforce sees who really made the request | ❌ No — it sees the integration user |
| Sharing rules limit what each user can read | ❌ No — the *integration user's* access applies |
| You can audit who did what | ❌ No — no per-user attribution |

**Consequence:** if you share one HTTP server across a team, every member
effectively has the integration user's Salesforce permissions. Someone who cannot
see an object in the Salesforce UI may still be able to read it through this
server.

If you need per-user identity, this transport does not provide it. See
[Alternatives](#alternatives-to-a-shared-server).

---

## Enabling it

```bash
MC_NEXT_HTTP_ENABLED=true \
MC_NEXT_HTTP_PORT=3000 \
node dist/index.js
```

The server logs its endpoints on startup:

```
[mc-next-mcp-server] HTTP transport listening on 127.0.0.1:3000
  endpoint:   POST http://127.0.0.1:3000/mcp
  health:     GET  http://127.0.0.1:3000/healthz
  auth:       NONE (loopback only)
  sessions:   stateful, in-memory
  WARNING:    every caller runs as the same Salesforce integration user.
```

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_NEXT_HTTP_ENABLED` | `false` | Must be `true` to use HTTP |
| `MC_NEXT_HTTP_PORT` | `3000` | |
| `MC_NEXT_HTTP_HOST` | `127.0.0.1` | **Loopback only by default.** See below. |
| `MC_NEXT_HTTP_AUTH_TOKEN` | *(unset)* | **Required for any non-loopback host.** Minimum 16 characters. |
| `MC_NEXT_HTTP_ALLOWED_HOSTS` | *(unset)* | Comma-separated `Host` values allowed when bound beyond loopback |

### The startup guard

The server **refuses to start** — it does not merely warn — in these cases:

| Condition | Why |
| --- | --- |
| `MC_NEXT_HTTP_HOST` is not loopback **and** no `MC_NEXT_HTTP_AUTH_TOKEN` | Would expose every tool to the network with no authentication |
| `MC_NEXT_HTTP_AUTH_TOKEN` is shorter than 16 characters | Too weak to resist guessing |

```
[mc-next-mcp-server] FATAL: MC_NEXT_HTTP_HOST is "0.0.0.0" (not loopback) but
MC_NEXT_HTTP_AUTH_TOKEN is not set. Binding HTTP to a non-loopback host without
a bearer token would expose every tool to the network.
```

This is deliberately fatal rather than a warning: a warning would be ignored, and
the failure mode is an unauthenticated destructive API on a network.

---

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/mcp` | Bearer | MCP JSON-RPC. Initialize, then all tool calls. |
| `GET` | `/mcp` | Bearer | SSE stream for server-initiated messages |
| `DELETE` | `/mcp` | Bearer | Terminate a session |
| `GET` | `/healthz` | **None** | Liveness. Returns `{"status":"ok","transport":"http"}` |

`/healthz` is intentionally unauthenticated and deliberately reports nothing about
Salesforce connectivity — it answers "is the process up", not "is the org
reachable". It is the only route without auth, so it leaks no information beyond
the fact that a server is listening.

### Sessions

Sessions are **stateful and in-memory**:

- A session ID is issued on `initialize` and returned in the `mcp-session-id` header.
- Subsequent requests must include that header.
- An unknown or missing session ID on a non-initialize request returns `400`.
- **Sessions are lost on restart.** Clients must re-initialize.

This is fine for a single instance. It is **not** suitable for horizontal scaling:
a second replica will not recognize a session created by the first.

---

## Client configuration

### VS Code

```json
{
  "servers": {
    "mc-next": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${input:mc-next-token}"
      }
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "mc-next-token",
      "description": "mc-next-mcp-server bearer token",
      "password": true
    }
  ]
}
```

### Claude Desktop

Claude Desktop's config format is oriented around launching a local process. For a
remote HTTP server, prefer a client that supports remote MCP servers, or use the
[stdio configuration](../docs/CLAUDE-DESKTOP-SETUP.md) instead.

### Verifying manually

```bash
TOKEN=your-token-here

# Liveness (no auth)
curl -s http://127.0.0.1:3000/healthz

# Unauthenticated MCP call -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Initialize (note the session id in the response headers)
curl -si -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

---

## Deployment patterns

### Pattern A — loopback + reverse proxy (recommended)

Bind to `127.0.0.1` and let a reverse proxy handle TLS and authentication. The
server's own token becomes a second layer rather than the only one.

```
Internet ──TLS──► nginx/Caddy ──► 127.0.0.1:3000
                  (auth, TLS)      (this server)
```

Benefits: you get TLS (this server has **no TLS support** — see below), real
authentication options (mTLS, OIDC, SSO), and rate limiting.

### Pattern B — direct bind with a token

```bash
MC_NEXT_HTTP_ENABLED=true \
MC_NEXT_HTTP_HOST=0.0.0.0 \
MC_NEXT_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)" \
MC_NEXT_HTTP_ALLOWED_HOSTS="mcp.internal.example.com" \
node dist/index.js
```

Set `MC_NEXT_HTTP_ALLOWED_HOSTS` whenever you bind beyond loopback. Without it,
DNS-rebinding protection is not applied, and a malicious web page could resolve
its own hostname to your server's address and drive it from a victim's browser.

### Pattern C — container

```bash
docker run --rm -p 3000:3000 \
  -e MC_NEXT_HTTP_ENABLED=true \
  -e MC_NEXT_HTTP_HOST=0.0.0.0 \
  -e MC_NEXT_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --env-file .env \
  mc-next-mcp-server:1.0.0
```

Note this differs from the stdio container usage: no `-i` is needed, and the port
must be published.

---

## Security requirements

### TLS is not provided

**The server speaks plain HTTP.** It has no TLS support and no certificate
configuration. If traffic crosses any untrusted network, terminate TLS in front of
it — the Salesforce credentials and bearer token would otherwise be sent in
cleartext.

### Token handling

Generate a strong token and store it as a secret, not in a committed config:

```bash
openssl rand -hex 32
```

- Minimum 16 characters is enforced; 64 hex characters is a good target.
- Treat it like a password: anyone holding it has the integration user's access.
- Rotate by restarting with a new value. There is no hot reload.

### Keep the safety gates closed

The gates matter **much more** over HTTP than over stdio, because the set of
callers is no longer limited to one trusted process:

```bash
MC_NEXT_ALLOW_DESTRUCTIVE=false        # keep this
MC_NEXT_ALLOW_METADATA_CHANGES=false   # keep this
```

Only open them on a sandbox, and only deliberately.

### Consider disabling the cache

A shared server means shared cache state, so one caller's cached read is served to
another. The cache only stores successful GETs and never writes, so this is not a
data-leak across *users* in the normal sense — but it is shared state. Set
`MC_NEXT_CACHE_TTL_MS=0` if that matters to you. See
[PERFORMANCE.md](PERFORMANCE.md).

---

## Alternatives to a shared server

If what you actually need is per-user identity, HTTP alone does not solve it:

| Alternative | Gives you |
| --- | --- |
| **One stdio instance per user** | True per-user identity via separate Connected Apps or Run As users. The default and safest model. |
| **Reverse proxy with authentication** | Real authentication at the edge, but still one Salesforce identity behind it |
| **Separate server per team/org** | Bounded blast radius; still one identity per server |
| **Wait for browser-based auth** | The only way to get genuine per-user identity. Tracked in [ROADMAP.md](../ROADMAP.md#long-term). |

---

## Troubleshooting

### Server exits immediately with `FATAL: ... MC_NEXT_HTTP_AUTH_TOKEN is not set`

Working as intended. Set a token, or bind to `127.0.0.1`.

### `401 Missing or invalid bearer token`

- Confirm the `Authorization: Bearer <token>` header is present.
- Confirm the token matches exactly — comparison is constant-time but exact.
- `/healthz` is the only route that does not require it.

### `400 Bad Request: no valid session ID provided`

You sent a non-initialize request without an `mcp-session-id` header. Initialize
first, then reuse the returned session ID.

### `403 Host "..." is not in MC_NEXT_HTTP_ALLOWED_HOSTS`

You bound beyond loopback with an allow-list that does not include the `Host` your
client sends. Add it, or remove the allow-list (not recommended).

### `500 Internal server error`

Check stderr. Set `MC_NEXT_DEBUG=true` for request-level logging.

### Clients cannot connect after a restart

Sessions are in-memory. Restarting invalidates every session; clients must
re-initialize.

### Health check passes but tool calls fail

`/healthz` says nothing about Salesforce connectivity. Check credentials and base
URLs — see
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#troubleshooting).

---

## See also

- [SECURITY.md](../SECURITY.md) — threat model, including what HTTP changes
- [DOCKER-DEPLOYMENT.md](DOCKER-DEPLOYMENT.md) — container specifics
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) — multi-org, logging, monitoring
- [PERFORMANCE.md](PERFORMANCE.md) — caching, which matters more when shared
