# VS Code + GitHub Copilot Setup

How to run `mc-next-mcp-server` as an MCP server inside **VS Code** with **GitHub
Copilot Chat** (agent mode).

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 18 or newer** | `node --version` to check. The server declares `engines.node >= 18`. |
| **VS Code** | Recent stable build. |
| **GitHub Copilot** | An active Copilot subscription, with the **Copilot Chat** extension installed and signed in. |
| **Agent mode available** | MCP servers are used by Copilot's **agent mode** in Chat. |
| A Salesforce Connected App | See [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md). |

> **You can start without credentials.** The server starts and serves the
> catalog even when `SF_CLIENT_ID` / `SF_CLIENT_SECRET` are unset — it prints a
> warning to stderr and only fails when you actually make an API call. This makes
> it easy to verify the wiring first.

---

## Step 1 — Clone, install, build

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
npm run build
```

### Verify before touching VS Code

```bash
npm run smoke
```

This connects to the built server over stdio as a real MCP client and asserts the
tool surface, the two safety gates, and the validation paths. **It needs no
credentials.** If this passes, the server itself is healthy and any remaining
problem is configuration.

Confirm the entrypoint exists:

```bash
ls dist/index.js
```

---

## Step 2 — Collect your environment values

You need up to six values. The three required ones plus the login host come from
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#step-5--retrieve-the-client-id-and-secret).

| Variable | Required | Example |
| --- | --- | --- |
| `SF_CLIENT_ID` | ✅ | `3MVG9...` |
| `SF_CLIENT_SECRET` | ✅ | `A1B2C3...` |
| `MC_NEXT_API_BASE_URL` | ✅ | `https://my-org.my.salesforce.com/services/data/v66.0` |
| `DATA360_TENANT_URL` | ✅ | `https://my-tenant.c360a.salesforce.com` |
| `DATA360_CONNECT_BASE_URL` | ✅ | `https://my-tenant.c360a.salesforce.com/services/data/v66.0` |
| `SF_LOGIN_URL` | optional | `https://login.salesforce.com` (default) — use `https://test.salesforce.com` for sandboxes |

Leave `MC_NEXT_ALLOW_DESTRUCTIVE` and `MC_NEXT_ALLOW_METADATA_CHANGES` unset for
now. Both default to `false`, which is what you want while testing.

---

## Step 3 — Choose where to configure the server

VS Code supports two places to define MCP servers. **Pick one** — you do not need
both.

| Scope | File | Use when |
| --- | --- | --- |
| **Workspace** | `.vscode/mcp.json` in the project | You want the server configured for this repo, shared with the team via git |
| **User profile** | Your VS Code profile's `mcp.json` (via **MCP: Open User Configuration** in the Command Palette) | You want the server available in every workspace |

> **Watch out for secrets.** A workspace `.vscode/mcp.json` is committed and
> shared. Putting `SF_CLIENT_SECRET` in it leaks the secret to everyone with repo
> access. For a workspace file, use [input variables](#using-input-variables-for-secrets)
> so the secret is prompted for and stored in your OS keychain instead.

### Recommended for a first setup: user profile

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **MCP: Open User Configuration**.
3. VS Code opens (or creates) your profile's `mcp.json`.

---

## Step 4 — Write the configuration

VS Code uses the key **`servers`** (not `mcpServers`), and each entry needs a
**`type`** field. This is the most common copy-paste mistake when adapting
examples written for other clients.

Replace `/ABSOLUTE/PATH/TO/mc-next-mcp-server` with the real path from Step 1.

```json
{
  "servers": {
    "mc-next": {
      "type": "stdio",
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

### Notes on the config

- **`args` must be an absolute path.** A relative path resolves against whatever
  working directory VS Code happens to use and will fail. You can use
  `${workspaceFolder}` in a *workspace* `mcp.json` to avoid hardcoding.
- **Use forward slashes** even on Windows (`C:/Users/.../dist/index.js`), or
  escape backslashes (`C:\\Users\\...`).
- **The server does not auto-load `.env`.** Configuration comes from the `env`
  block above (or the process environment). Do not rely on a `.env` file being
  picked up automatically.
- If you set `cwd`, keep it at the project root so `catalog/endpoints.json`
  resolves — the server looks for it one level up from `dist/`.

### Using `envFile` instead

If you prefer keeping values in a `.env` file (which is gitignored), VS Code
supports `envFile`:

```json
{
  "servers": {
    "mc-next": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mc-next-mcp-server/dist/index.js"],
      "envFile": "/ABSOLUTE/PATH/TO/mc-next-mcp-server/.env"
    }
  }
}
```

This keeps the JSON free of secrets. Note the file must actually exist, or the
server starts with no configuration.

### Using input variables for secrets

For a **workspace** `mcp.json` that gets committed, use `inputs` so the secret is
prompted for once and stored in the OS keychain:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sf-client-secret",
      "description": "Salesforce Connected App consumer secret",
      "password": true
    }
  ],
  "servers": {
    "mc-next": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "SF_CLIENT_ID": "your_connected_app_consumer_key",
        "SF_CLIENT_SECRET": "${input:sf-client-secret}",
        "MC_NEXT_API_BASE_URL": "https://my-org.my.salesforce.com/services/data/v66.0",
        "DATA360_TENANT_URL": "https://my-tenant.c360a.salesforce.com",
        "DATA360_CONNECT_BASE_URL": "https://my-tenant.c360a.salesforce.com/services/data/v66.0"
      }
    }
  }
}
```

> `inputs` is a **VS Code** feature. Claude Desktop has no equivalent — see
> [CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md).

---

## Step 5 — Start the server and verify

1. Save `mcp.json`.
2. VS Code detects the change. Open the **Extensions** view, or run
   **MCP: List Servers** from the Command Palette.
3. Start the `mc-next` server. You can also start it from the inline
   **Start** action that appears above the server entry in `mcp.json`.
4. Open **Copilot Chat** and switch the mode selector to **Agent**.

### Confirm the tools are visible

In Copilot Chat, click the **tools** icon and confirm the 28 tools appear, or
just ask:

```
List the MCP tools available from the mc-next server.
```

You should see the `mcnext_*` and `sf_*` tools.

### Test prompts that need no credentials

These exercise catalog browsing only — they work even before your Connected App
is wired up:

```
How many endpoints does the mc-next server expose, and how are they split
across API families? Use the mcnext://overview resource.
```

```
Search the catalog for endpoints that publish an email. Then describe the one
you'd use, including its required parameters.
```

```
I want to create an email with raw HTML. Find the right endpoint and show me
the exact request body shape it expects.
```

### Test prompts that need credentials

```
Run a SOQL query for the 5 most recently created Accounts, and show me the Id
and Name for each.
```

```
Query the Data 360 catalog for endpoints related to segments, then describe
one of them.
```

```
Check my org's API limits and tell me how much of the daily allowance is used.
```

---

## Troubleshooting

### The server does not appear, or shows as failed

1. **Check the file location.** Workspace: `.vscode/mcp.json`. User:
   **MCP: Open User Configuration**. A file named `settings.json` will not work.
2. **Check the JSON is valid.** A trailing comma breaks the whole file silently.
3. **Check `type: "stdio"` is present.** Without it, VS Code may not know how to
   launch the server.
4. **Check the path is absolute and exists.** Run `ls /your/path/dist/index.js`.
5. **Run the server manually** to see the real error:

   ```bash
   node /ABSOLUTE/PATH/TO/mc-next-mcp-server/dist/index.js
   ```

   With no credentials it should print a warning to stderr and then wait. If it
   exits immediately, read the stack trace.

### `command not found: node`

VS Code's GUI process may not inherit your shell's `PATH` (common on macOS with
`nvm`, and on Linux with version managers). Fixes:

- Use an absolute path to the Node binary in `command`, e.g.
  `"/Users/you/.nvm/versions/node/v22.0.0/bin/node"`.
- Or find it with `which node` (macOS/Linux) / `where node` (Windows) and paste
  that value.

### "missing required environment variable(s): SF_CLIENT_ID, SF_CLIENT_SECRET"

The server started but has no credentials. Catalog browsing still works; API
calls will fail.

- Confirm the variables are inside the **`env`** block, not at the top level of
  the JSON.
- Confirm you edited the file VS Code is actually reading (workspace vs user).
- Restart the server after editing — env changes need a restart.

### "base URL(s) still at placeholder defaults"

You left a `YOUR_INSTANCE` / `YOUR_TENANT` placeholder in place. Set the real
URLs per [Step 2](#step-2--collect-your-environment-values).

### OAuth token request failed (HTTP 400): invalid_client

Wrong client ID or secret — see
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#invalid_client).

### OAuth token request failed: unsupported_grant_type

The Connected App does not have **Client Credentials Flow** enabled. This is the
most common auth failure — see
[SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md#unsupported_grant_type).

### Tools appear but every call fails

Usually one of:

- **Wrong host.** `DATA360_TENANT_URL` pointing at a `my.salesforce.com` host
  instead of `c360a.salesforce.com` (or vice versa). The two hosts are different
  systems.
- **Missing scope** for that API family.
- **Propagation delay** — a just-edited Connected App can take 2–10 minutes.

Turn on debug logging to see the exact request:

```json
"env": {
  "MC_NEXT_DEBUG": "true"
}
```

Then read the server's output in the **Output** panel (select the MCP server's
channel) or the MCP server log. `MC_NEXT_DEBUG` logs to **stderr**, never stdout,
so it cannot corrupt the protocol stream.

### Destructive calls are refused

Expected by default. The refusal message names the flag:

```
Refusing to call destructive endpoint "..." (DELETE ...). Set
MC_NEXT_ALLOW_DESTRUCTIVE=true to enable DELETE and destructive actions.
```

Only set `MC_NEXT_ALLOW_DESTRUCTIVE=true` (or `MC_NEXT_ALLOW_METADATA_CHANGES=true`)
if you genuinely intend to allow it, ideally against a sandbox first. The two
flags are independent — enabling one does not enable the other.

### CLI vs GUI setup

Both work; they differ in where configuration lives.

| | CLI (`claude`-style, or manual `node`) | VS Code GUI |
| --- | --- | --- |
| Where config lives | `mcp.json` on disk (workspace or user profile) | Same file, edited via the GUI or **MCP: Open User Configuration** |
| Secrets | `env` block, `envFile`, or `inputs` | Same |
| Restart needed after change | Yes | Usually automatic; restart the server explicitly if not |
| Seeing logs | stderr in your terminal | **Output** panel / MCP server log |
| Verifying without a client | `npm run smoke` | Same |

A useful pattern: configure and debug via the CLI first (`npm run smoke`, then
run `node dist/index.js` directly), and only then wire up the GUI. That isolates
server problems from client problems.

---

## Next steps

- [CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md)
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)
- [SALESFORCE-CONNECTED-APP-GUIDE.md](SALESFORCE-CONNECTED-APP-GUIDE.md)
