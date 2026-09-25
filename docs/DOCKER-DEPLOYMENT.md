# Docker Deployment

Running `mc-next-mcp-server` in a container.

> **Read this first:** this server uses **stdio**, not HTTP. It is not a
> long-running network service, so most Docker habits do not apply. In
> particular, `docker compose up -d` will appear to succeed and then the
> container will stop — that is expected. See
> [Why `up -d` does not work](#why-docker-compose-up--d-does-not-work).

For general deployment topics (multi-org, logging, monitoring), see
[DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md).

---

## Is Docker the right choice?

| Situation | Use Docker? |
| --- | --- |
| Normal local use (VS Code, Claude Desktop) | ❌ No — a local clone is simpler |
| You want a reproducible, hermetic runtime | ✅ Yes |
| You want to pin the Node version independent of your machine | ✅ Yes |
| You want to run it as a shared network service | ❌ **Not possible** — stdio only |
| You want to avoid installing Node at all | ✅ Yes |

The main benefit is **reproducibility**: the image pins the Node version and the
dependency tree, so it behaves the same everywhere.

---

## Quick start

```bash
# 1. Build
docker build -t mc-next-mcp-server:1.0.0 .

# 2. Verify the image is sane (no credentials needed)
docker run --rm mc-next-mcp-server:1.0.0 \
  node -e "console.log(require('/app/catalog/endpoints.json').endpoints.length)"
# -> 445

# 3. Run it with stdin attached
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0
```

Step 3 will print startup warnings to **stderr** and then wait silently. That
silence is correct — it is waiting for JSON-RPC on stdin, not hanging.

---

## The `-i` flag is mandatory

The server talks JSON-RPC over stdin/stdout. Without an attached stdin it reads
EOF immediately and exits.

```bash
# ✅ Correct — stdin attached
docker run --rm -i mc-next-mcp-server:1.0.0

# ❌ Wrong — exits immediately with no output
docker run --rm mc-next-mcp-server:1.0.0
```

**Do not add `-t`.** A TTY can corrupt the stdio framing. `-i` alone is correct.

---

## Configuration

Credentials are supplied at **run time**, never baked into the image.

### Using an env file (recommended)

```bash
cp .env.example .env
# edit .env with your Connected App credentials and base URLs
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0
```

`.env` is listed in `.dockerignore`, so it can never be copied into an image
layer.

### Using a mounted file

The server does **not** read `.env` itself — it reads the process environment.
`--env-file` is Docker populating that environment for you. If you prefer to keep
the file outside the build context entirely:

```bash
docker run --rm -i \
  --env-file /secure/path/mc-next.env \
  mc-next-mcp-server:1.0.0
```

### Using individual variables

Fine for a quick test, but avoid it for real secrets — command-line arguments are
visible in `docker inspect` and shell history:

```bash
docker run --rm -i \
  -e SF_CLIENT_ID=... \
  -e SF_CLIENT_SECRET=... \
  mc-next-mcp-server:1.0.0
```

### Variable reference

| Variable | Default in image | Notes |
| --- | --- | --- |
| `SF_CLIENT_ID` | *(unset)* | Required for API calls |
| `SF_CLIENT_SECRET` | *(unset)* | Required for API calls |
| `MC_NEXT_API_BASE_URL` | *(unset)* | Core org + `/services/data/vXX` |
| `DATA360_TENANT_URL` | *(unset)* | `c360a` host, no suffix |
| `DATA360_CONNECT_BASE_URL` | *(unset)* | `c360a` host + `/services/data/vXX` |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | `test.salesforce.com` for sandboxes |
| `SF_API_VERSION` | `66.0` | |
| `MC_NEXT_TIMEOUT_MS` | `60000` | |
| `MC_NEXT_MAX_RETRIES` | `3` | |
| `MC_NEXT_ALLOW_DESTRUCTIVE` | `false` | **Safety gate** |
| `MC_NEXT_ALLOW_METADATA_CHANGES` | `false` | **Safety gate** |
| `MC_NEXT_DEBUG` | `false` | Log HTTP to stderr |

The defaults are baked in as `ENV` so `docker inspect` shows the effective
configuration. Credentials are deliberately **not** among them.

> **The image never contains credentials.** `ENV` at build time would bake them
> into a layer, visible to anyone with the image. They are supplied at run time
> only.

---

## Client integration

An MCP client must launch the container. Since the transport is stdio, the client
runs `docker run -i` as its child process.

### VS Code (`.vscode/mcp.json` or user `mcp.json`)

```json
{
  "servers": {
    "mc-next": {
      "type": "stdio",
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

### Claude Desktop (`claude_desktop_config.json`)

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

Note the difference: VS Code needs `"type": "stdio"` and uses the `servers` key;
Claude Desktop uses `mcpServers` and no `type`. See
[VS-CODE-SETUP.md](VS-CODE-SETUP.md) and
[CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md).

### Using Compose instead

`docker compose run` attaches a TTY and stdin, so it works where `up -d` does not:

```bash
docker compose run --rm mc-next
```

This is mainly useful for interactive debugging, not for client integration.

---

## Why `docker compose up -d` does not work

This trips up almost everyone, so it is worth being explicit.

```
$ docker compose up -d
[+] Running 2/2
 ✔ Network ... Created
 ✔ Container mc-next-mcp-server  Started      <- looks fine

$ docker compose ps
NAME                 STATUS
mc-next-mcp-server   Exited (0)              <- it stopped
```

**This is not a bug.** The sequence is:

1. Compose starts the container with no attached stdin.
2. The server reads EOF from stdin immediately.
3. The MCP server loop ends, the process exits **cleanly** (status 0).
4. Compose reports the container as `Exited (0)`.

There is nothing to fix. The server has no client to talk to, so exiting is the
correct behaviour.

### What not to do about it

| Tempting fix | Why it is wrong |
| --- | --- |
| `restart: always` | Creates an endless loop of successful, pointless starts. The exit code is 0, so it is not even a crash loop you can detect. |
| `stdin_open: true` + `tty: true` | A TTY corrupts stdio framing. |
| `command: tail -f /dev/null` | Keeps the container alive but the server never runs. |
| Publishing a port | There is no listener. Nothing will connect. |

`docker-compose.yml` in this repo deliberately sets `stdin_open: true` and omits
`ports`, `volumes`, and `restart`, with comments explaining each omission.

---

## Volume mounting

**There is nothing to persist.** The server:

- reads only `catalog/endpoints.json`, which is baked into the image
- writes no files
- caches tokens in memory only
- has no state directory

So a volume is **not** required, and adding one is usually a mistake.

### The one legitimate case: a custom catalog

If you regenerate the catalog and want to test it without rebuilding the image,
mount it over the baked-in copy:

```bash
docker run --rm -i \
  --env-file .env \
  -v "$PWD/catalog/endpoints.json:/app/catalog/endpoints.json:ro" \
  mc-next-mcp-server:1.0.0
```

Mount it **read-only** (`:ro`). The server never writes to it.

### Mounting `.env` instead of using `--env-file`

Possible, but pointless — the server does not read `.env` files. Prefer
`--env-file`, which is Docker setting the process environment:

```bash
# ✅ Preferred
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0

# ⚠️ Works only because node --env-file is passed explicitly; the server itself
#    does not read .env
docker run --rm -i -v "$PWD/.env:/app/.env:ro" mc-next-mcp-server:1.0.0 \
  node --env-file=/app/.env dist/index.js
```

### What never to mount

Do not mount your project directory over `/app`:

```bash
# ❌ Overwrites node_modules and dist with host paths that may not exist
docker run --rm -i -v "$PWD:/app" mc-next-mcp-server:1.0.0
```

If you want to run against live source, use a local clone instead of Docker.

---

## Building

```bash
# Default (node:24-alpine)
docker build -t mc-next-mcp-server:1.0.0 .

# Pin a different Node major
docker build --build-arg NODE_VERSION=22-alpine -t mc-next-mcp-server:1.0.0 .
```

The build is multi-stage:

1. **build** — `npm ci` (lockfile-pinned), `tsc`, then `npm prune --omit=dev`
2. **runtime** — production deps + `dist/` + `catalog/`, running as the non-root
   `node` user

The final image contains no devDependencies, no TypeScript sources, and no
credentials.

### Layout constraint

`src/catalog.ts` resolves the catalog as `dist/../catalog/endpoints.json`. The
image therefore keeps them as **siblings**:

```
/app
├── dist/index.js          <- entrypoint
├── catalog/endpoints.json <- resolved as dist/../catalog
└── node_modules/
```

If you restructure the image, preserve that relationship or the server exits with
a catalog-not-found error.

### Why the image does not run `npm run generate`

The catalog is **committed**, so it is copied in as-is. Regeneration requires the
official Salesforce Postman collections, which are deliberately not in this
repository (licensing) — `npm run generate` would correctly refuse to run without
them. See [POSTMAN-COLLECTIONS.md](POSTMAN-COLLECTIONS.md).

---

## Verifying the image

```bash
# Catalog is present and parseable
docker run --rm mc-next-mcp-server:1.0.0 \
  node -e "console.log(require('/app/catalog/endpoints.json').endpoints.length)"
# -> 445

# Runs as non-root (uid 1000)
docker run --rm mc-next-mcp-server:1.0.0 node -e "console.log(process.getuid())"
# -> 1000

# Effective configuration
docker inspect mc-next-mcp-server:1.0.0 --format '{{json .Config.Env}}' | python3 -m json.tool

# No credentials baked in (should output nothing)
docker inspect mc-next-mcp-server:1.0.0 --format '{{json .Config.Env}}' \
  | grep -iE "client_secret|client_id" || echo "clean"

# The server starts and speaks the protocol
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | docker run --rm -i mc-next-mcp-server:1.0.0 2>/dev/null | head -c 200
```

### Health check

The image defines a `HEALTHCHECK` that confirms the catalog is readable. Because
there is no port, Docker's health status is not consumed by anything in the
normal stdio flow — it is useful only when an orchestrator reads container health.
It **cannot** validate Salesforce connectivity.

---

## Troubleshooting

### Container starts then immediately exits

Expected with no attached stdin. Add `-i`, or use `docker compose run` instead of
`docker compose up`. See [above](#why-docker-compose-up--d-does-not-work).

### `Cannot find module '/app/catalog/endpoints.json'`

The `dist/` and `catalog/` siblings relationship was broken. Check with:

```bash
docker run --rm mc-next-mcp-server:1.0.0 ls -la /app
```

### `command not found: docker` in the MCP client

The client does not inherit your shell's `PATH`. Use the absolute path to the
Docker binary in `command`:

```json
"command": "/usr/local/bin/docker"
```

Find it with `which docker`.

### Credentials not reaching the container

`--env-file` expects plain `KEY=value` lines. It does **not** understand shell
expressions like `SF_CLIENT_ID=$OTHER_VAR`. Simplify the file if you generated it
from a shell script.

Verify what the container actually sees:

```bash
docker run --rm -i --env-file .env mc-next-mcp-server:1.0.0 \
  node -e "console.log('client id set:', !!process.env.SF_CLIENT_ID)"
```

### Warnings about missing variables

Expected without credentials. The server starts anyway so you can browse the
catalog; API calls fail until credentials are set.

### OAuth errors

Not Docker-specific. See
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#troubleshooting).

### Enabling the safety gates in a container

Pass them at run time, and prefer a sandbox:

```bash
docker run --rm -i --env-file .env \
  -e MC_NEXT_ALLOW_DESTRUCTIVE=true \
  mc-next-mcp-server:1.0.0
```

`docker-compose.yml` pins both gates to `false` on purpose, because Compose files
get copied around and silently enabling destructive operations in a copied config
is the exact failure the gates exist to prevent.

### Debug logging

```bash
docker run --rm -i --env-file .env \
  -e MC_NEXT_DEBUG=true \
  mc-next-mcp-server:1.0.0
```

Logs go to stderr, which `docker run` passes through to your terminal.

---

## Image size

The image is small: Alpine base, production dependencies only, no devDependencies
or sources. The largest content is `catalog/endpoints.json` (~1 MB).

To inspect:

```bash
docker images mc-next-mcp-server:1.0.0
```

---

## See also

- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) — multi-org, logging, monitoring
- [VS-CODE-SETUP.md](VS-CODE-SETUP.md) — client configuration
- [CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md) — client configuration
- [SECURITY.md](../SECURITY.md) — secrets handling and the safety gates
