# Claude Desktop Setup

How to run `mc-next-mcp-server` inside **Claude Desktop**, so Claude can call the
Salesforce Marketing Cloud Next / Data 360 APIs and the platform tools directly.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 18 or newer** | `node --version`. |
| **Claude Desktop** | Installed and signed in. |
| A Salesforce Connected App | See [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md). |
| Built server | `npm install && npm run build` — see [Step 1](#step-1--clone-install-build). |

> **Platform support.** Claude Desktop is officially available for **macOS and
> Windows only**. On Linux, use the [VS Code guide](VS-CODE-SETUP.md) or
> [Claude Code](#appendix--claude-code-cli) instead.

---

## Where the config file lives

This is the part that trips people up. Claude Desktop's MCP config is **not**
`~/.claude/claude.json`. The real paths are:

| OS | Path |
| --- | --- |
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |

The file is named **`claude_desktop_config.json`** and lives in the Claude
application-support directory — not in `~/.claude/`.

### Easiest way to open it

1. Open **Claude Desktop**.
2. Open the **Claude** menu in the system menu bar (macOS) or the app menu
   (Windows) — **not** the settings inside the chat window.
3. Choose **Settings…**
4. Go to the **Developer** tab.
5. Click **Edit Config**.

This creates the file if it does not exist and opens it in your editor. Using the
button guarantees you are editing the file Claude actually reads.

> `~/.claude/claude.json` is a different file used by **Claude Code** (the CLI),
> and it does not configure Claude Desktop. If you are looking for the CLI, see
> the [appendix](#appendix--claude-code-cli).

---

## Step 1 — Clone, install, build

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
npm run build
```

Verify the server is healthy **before** involving Claude Desktop:

```bash
npm run smoke
```

The smoke test needs no credentials and asserts the tool surface, both safety
gates, and the validation paths. If it passes, the server works and any remaining
problem is configuration.

Note the absolute path to `dist/index.js` — you need it in the next step:

```bash
# macOS/Linux
pwd && ls dist/index.js

# Windows (PowerShell)
(Get-Location).Path
```

---

## Step 2 — Add the server to the config

Claude Desktop uses the key **`mcpServers`** and does **not** need a `type` field
(unlike VS Code, which uses `servers` and `type: "stdio"`). This difference is the
most common copy-paste error between the two guides.

Replace `/ABSOLUTE/PATH/TO/mc-next-mcp-server` with your real path.

### macOS / Linux

```json
{
  "mcpServers": {
    "mc-next": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mc-next-mcp-server/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "your_connected_app_consumer_key",
        "SF_CLIENT_SECRET": "your_connected_app_consumer_secret",
        "MC_NEXT_API_BASE_URL": "https://my-org.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://my-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://my-tenant.c360a.salesforce.com/services/data/v66.0",
        "SF_LOGIN_URL": "https://login.salesforce.com"
      }
    }
  }
}
```

### Windows

Use forward slashes, or escape backslashes. Both work:

```json
{
  "mcpServers": {
    "mc-next": {
      "command": "node",
      "args": ["C:/Users/you/mc-next-mcp-server/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "your_connected_app_consumer_key",
        "SF_CLIENT_SECRET": "your_connected_app_consumer_secret",
        "MC_NEXT_API_BASE_URL": "https://my-org.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://my-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://my-tenant.c360a.salesforce.com/services/data/v66.0",
        "SF_LOGIN_URL": "https://login.salesforce.com"
      }
    }
  }
}
```

### If you already have other servers configured

`mcpServers` is a map — **merge** your entry in rather than replacing the file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Desktop"]
    },
    "mc-next": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mc-next-mcp-server/dist/index.js"],
      "env": { }
    }
  }
}
```

### Config notes

- **Absolute path required.** A relative path fails, because Claude Desktop's
  working directory is not your project.
- **No `envFile` support.** Claude Desktop has no equivalent of VS Code's
  `envFile` or `inputs`. Secrets go directly in the `env` block, so **treat this
  file as a secret** — restrict its permissions and never commit it.
- **The server does not auto-load `.env`.** Configuration comes from `env`.
- **On Windows**, if you hit an `ENOENT` error mentioning `${APPDATA}` in a path,
  add the expanded value explicitly:

  ```json
  "env": {
    "APPDATA": "C:\\Users\\you\\AppData\\Roaming\\"
  }
  ```

---

## Step 3 — Restart Claude Desktop

Fully **quit** Claude Desktop and reopen it. Closing the window is not enough —
the config is read at startup.

- **macOS:** `Cmd+Q`, or **Claude → Quit Claude**.
- **Windows:** exit from the tray/menu, or use Task Manager to be certain.

---

## Step 4 — Verify the connection

After restart, look for the **connectors / tools** indicator in the message box
(the slider or plug icon). Click it, hover **Connectors**, and open
**Manage connectors**. You should see **`mc-next`** listed with its tools.

If it appears, try these prompts.

### Prompts that need no credentials

These exercise catalog browsing only:

```
How many endpoints does the mc-next server expose, and how are they split
across API families? Read the mcnext://overview resource.
```

```
Search the endpoint catalog for operations that publish an email, then describe
the best match including its required parameters and body schema.
```

### Prompts that need credentials

```
Run a SOQL query for the 5 most recently created Accounts and show me the Id and
Name of each.
```

```
Check my org's API limits and tell me how much of the daily allowance is used.
```

```
Find the Data 360 endpoints related to segments and describe one of them.
```

Claude will ask for approval before each tool call — that is expected.

---

## Troubleshooting

### `mc-next` does not appear in the connectors list

1. **Confirm the file location.** It must be `claude_desktop_config.json` in the
   application-support directory, and it must be the file **Edit Config** opens.
   A file at `~/.claude/claude.json` is ignored by Claude Desktop.
2. **Validate the JSON.** A single trailing comma invalidates the whole file and
   Claude Desktop silently ignores it. Paste it into a JSON validator.
3. **Check the key is `mcpServers`.** Using `servers` (the VS Code key) means
   Claude Desktop finds nothing.
4. **Check the path is absolute and the file exists.** Run
   `ls /your/path/dist/index.js`.
5. **Fully restart** Claude Desktop — not just the window.

### Check the logs

Claude Desktop writes MCP logs to:

| OS | Location |
| --- | --- |
| **macOS** | `~/Library/Logs/Claude/` |
| **Windows** | `%APPDATA%\Claude\logs\` |

- `mcp.log` — general MCP connection activity and failures.
- `mcp-server-mc-next.log` — the **stderr output** of this server, including the
  startup warnings and any `MC_NEXT_DEBUG` logging.

Follow them live (macOS/Linux):

```bash
tail -n 20 -f ~/Library/Logs/Claude/mcp*.log
```

This is the single most useful debugging step — the server's own diagnostics land
here.

### `command not found: node` / server exits immediately

Claude Desktop does not inherit your shell's `PATH`, so `node` may not resolve
even though it works in your terminal (very common with `nvm` on macOS).

Fix: put the **absolute path to the Node binary** in `command`:

```json
"command": "/Users/you/.nvm/versions/node/v22.0.0/bin/node"
```

Find it with `which node` (macOS/Linux) or `where node` (Windows).

### Warnings in the log but tools still work

Expected and harmless:

- `missing required environment variable(s): ...` — you can browse the catalog
  without credentials; API calls will fail.
- `base URL(s) still at placeholder defaults: ...` — you left a `YOUR_INSTANCE`
  / `YOUR_TENANT` placeholder. Set the real URLs.

### OAuth token request failed (HTTP 400): invalid_client

Wrong client ID or secret. See
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#invalid_client).

### OAuth token request failed: unsupported_grant_type

The Connected App does not have **Client Credentials Flow** enabled — the most
common auth failure. See
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#unsupported_grant_type).

### Tool calls fail with permission errors

The scope for that API family is not enabled on the Connected App, or you are
pointing at the wrong host. See the
[scope table](SALESFORCE-CONNECTED-APP-GUIDE.md#scope--capability-mapping).

### Destructive calls are refused

Expected — both safety gates default to `false`. The refusal message names the
flag to set. Only enable `MC_NEXT_ALLOW_DESTRUCTIVE` or
`MC_NEXT_ALLOW_METADATA_CHANGES` deliberately, and prefer a sandbox first. The two
flags are independent.

### Enable debug logging

Add `MC_NEXT_DEBUG` to the `env` block, restart, and read
`mcp-server-mc-next.log`:

```json
"env": {
  "MC_NEXT_DEBUG": "true"
}
```

This logs each HTTP request and the token acquisition to **stderr**, which is
exactly what Claude Desktop captures. It never writes to stdout, so it cannot
corrupt the MCP protocol stream.

---

## Remote / hosted deployments

Claude Desktop connects to **local stdio** servers via `command` + `args`. This
server is **stdio-only** — it has no HTTP/SSE transport, so it cannot be hosted
as a shared remote MCP endpoint that Claude Desktop connects to over the network.

You therefore have two realistic options:

### Option A — Run locally on each machine (recommended)

Install and build on each machine and configure `claude_desktop_config.json` as
above. Each instance talks to Salesforce directly.

| Pros | Cons |
| --- | --- |
| Simplest; no infrastructure | Credentials on every machine |
| Each user authenticates as the Connected App's Run As user | Must rebuild to update |

### Option B — Run in a container on the same machine

Package the server in Docker and point Claude Desktop at the container's Node
process. Since the transport is still stdio, Claude Desktop must **launch** the
container rather than connect to a port:

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

The `-i` flag is **required** — without an attached stdin there is no stdio
channel and the server cannot communicate.

See [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md#docker) for the Dockerfile and
build steps.

> **Not supported: connecting to a remote URL.** Because there is no HTTP/SSE
> transport, you cannot point Claude Desktop at `https://your-host/mcp`. Adding
> that would require a transport change to the server, and a shared remote
> deployment would also need a real answer for per-user identity — today all
> calls run as one Connected App integration user.

---

## Appendix — Claude Code (CLI)

If you meant the **Claude Code** CLI rather than Claude Desktop, configuration is
different. Claude Code uses its own config and a `claude mcp add` command:

```bash
claude mcp add mc-next \
  --env SF_CLIENT_ID=your_key \
  --env SF_CLIENT_SECRET=your_secret \
  --env MC_NEXT_API_BASE_URL=https://my-org.my.salesforce.com/services/data/v66.0 \
  --env DATA360_TENANT_URL=https://my-tenant.c360a.salesforce.com \
  --env DATA360_CONNECT_BASE_URL=https://my-tenant.c360a.salesforce.com/services/data/v66.0 \
  -- node /ABSOLUTE/PATH/TO/mc-next-mcp-server/dist/index.js
```

Then verify with:

```bash
claude mcp list
```

The `--` separates Claude Code's own flags from the command that launches the
server. Note that `~/.claude/claude.json` — the path often cited for this — is
**not** the Claude Desktop config, which is the confusion this appendix exists to
clear up.

---

## Next steps

- [VS-CODE-SETUP.md](VS-CODE-SETUP.md)
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)
- [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md)
