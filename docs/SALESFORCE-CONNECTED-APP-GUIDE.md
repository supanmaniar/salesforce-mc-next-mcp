# Salesforce Connected App Guide

This guide walks through creating the Salesforce **Connected App** that
`mc-next-mcp-server` authenticates with, and explains exactly which scope unlocks
which tools.

The server uses the OAuth 2.0 **client-credentials** flow exclusively. There is
no browser login, no username/password flow, and no JWT bearer flow.

---

## Before you start

You need:

- A Salesforce org where you can create Connected Apps (System Administrator, or
  "Manage Connected Apps" / "Customize Application" permissions).
- The **org type** you are targeting — production/dev vs. sandbox. This changes
  the login host you configure later.
- A decision about **which API families** you need. You only need to enable the
  scopes for the families you actually plan to call (see
  [Scope → capability mapping](#scope--capability-mapping)).

> **Important:** Because the flow is client-credentials, every API call runs as
> the Connected App's **integration user**, not as you. Salesforce sharing rules
> and field-level security apply to that user. Grant the integration user the
> minimum access the server needs.

---

## Step 1 — Open App Manager

1. Log in to your Salesforce org.
2. Click the **gear icon** (⚙) in the top-right corner and choose **Setup**.
3. In the **Quick Find** box, type `App Manager`.
4. Under **Apps**, select **App Manager**.
5. Click **New Connected App** (top-right of the list).

> **Path, for reference:** `Setup → Apps → App Manager → New Connected App`

---

## Step 2 — Basic information

On the **New Connected App** form, fill in the **Basic Information** section:

| Field | What to enter |
| --- | --- |
| **Connected App Name** | e.g. `MC Next MCP Server` |
| **API Name** | auto-fills, e.g. `MC_Next_MCP_Server` |
| **Contact Email** | your email — Salesforce sends policy notices here |
| **Logo Image URL** | leave blank |
| **Icon URL** | leave blank |
| **Info URL** | leave blank, or your repo URL |
| **Description** | e.g. `Client-credentials Connected App for mc-next-mcp-server` |

---

## Step 3 — Enable OAuth settings

Tick **Enable OAuth Settings**.

You will see a **Callback URL** field and a **Selected OAuth Scopes** list.

### Callback URL

Client-credentials flow does **not** use a callback URL — there is no browser
redirect and no authorization-code exchange. Salesforce requires the field to be
non-empty when OAuth is enabled, so enter a placeholder:

```
https://localhost/callback
```

This value is never used by this server. If Salesforce rejects it, use any
well-formed `https://` URL.

> **Note on callback URLs generally:** they matter for authorization-code and
> implicit flows, where Salesforce redirects the browser back after login. This
> server uses neither, so the value is inert. If you later add a different
> integration that *does* use a redirect flow, give that integration its own
> Connected App rather than reusing this one.

### Selected OAuth Scopes

Move the scopes you need from **Available** to **Selected**. See the mapping
table below for what each one unlocks.

### Client Credentials Flow

In the **Client Credentials Flow** section (below the scopes), tick
**Enable Client Credentials Flow**.

Salesforce will require a **Run As** user. Set it to the integration user the
server should execute as. If you leave it blank or point it at a deactivated
user, token requests fail with `invalid_grant`.

> **This is the step people miss.** Enabling OAuth but not the Client Credentials
> Flow produces a Connected App that looks correct in the UI but returns
> `unsupported_grant_type` or `invalid_client` at token time.

---

## Scope → capability mapping

Enable only what you need. Each scope is independent.

| Scope | Enables | Tools that depend on it |
| --- | --- | --- |
| `sfdc_cms_api` | **Marketing Cloud Next** — Content / CMS (27 endpoints) | `mcnext_*` catalog tools when calling `mc-next` endpoints |
| `cdp_query_api` | **Data 360** query — Query API V1/V2, Calculated Insights, Unified Record ID | `mcnext_*` tools calling `data360` query endpoints |
| `cdp_profile_api` | **Data 360** profile — Profile API, identity resolution lookups | `mcnext_*` tools calling `data360` / `data360-connect` profile endpoints |
| `cdp_ingest_api` | **Data 360** ingestion — Ingestion API, including the CSV bulk upload | `mcnext_*` tools calling ingestion endpoints |
| `api` | Salesforce **platform** REST API — SOQL, describe, record CRUD | `sf_soql_query`, `sf_list_objects`, `sf_describe_object`, `sf_rest_request`, `sf_org_limits`, `sf_create_record`, `sf_get_record`, `sf_update_record`, `sf_delete_record`, `sf_bulk_*`, `sf_composite` |

### Two important caveats

**1. The Data 360 collections use the implicit grant.** The official Data 360
Postman collections are written for the OAuth 2.0 **implicit** grant, which is
browser-only and cannot be used by a server. This server converts them to
client-credentials. That conversion is why the `cdp_*` scopes must be explicitly
enabled on the Connected App — the collection's own auth settings do not carry
over.

**2. `mcnext_*` tools are gated by scope, not by tool.** There are only 8
catalog-driven tools, and they cover all 445 endpoints. Which calls succeed
depends on which scopes are enabled. Calling an endpoint whose family you did not
enable fails at the API with a permission error, not at the MCP layer.

### Least-privilege recipes

| If you only want to… | Enable |
| --- | --- |
| Browse CMS content read-only | `sfdc_cms_api` |
| Query Data 360 read-only | `cdp_query_api`, `cdp_profile_api` |
| Run SOQL against your org | `api` |
| Everything, in a sandbox | all five |

Start with the narrowest set that works. Adding a scope later requires editing
the Connected App and waiting for propagation (see
[Propagation delay](#propagation-delay)).

---

## Step 4 — Save and wait

1. Click **Save**.
2. Salesforce warns that it may take **2–10 minutes** for the Connected App to
   become available. This is normal.
3. Click **Continue**.

---

## Step 5 — Retrieve the client ID and secret

1. On the Connected App detail page, click **Manage Consumer Details**.
   (In some orgs this is labelled **Manage** → **Consumer Details**.)
2. Salesforce will send a verification code to the contact email on the app.
   Enter it when prompted.
3. You now see two values:

| Value | Goes into | Notes |
| --- | --- | --- |
| **Consumer Key** | `SF_CLIENT_ID` | Public identifier |
| **Consumer Secret** | `SF_CLIENT_SECRET` | Treat as a password |

> **The secret is shown in plain text here.** Copy both values into your secrets
> store now. If you lose the secret you can regenerate it, but regenerating
> invalidates the old one and breaks every deployment using it.

---

## Step 6 — Find your base URLs

The server needs three URLs plus a login host. These are **not** in the Connected
App — you collect them from your org.

### `MC_NEXT_API_BASE_URL` — Marketing Cloud Next

This is your **core org** instance URL plus `/services/data/vXX`.

```
https://my-org.my.salesforce.com/services/data/v66.0
```

Find the instance URL in **Setup → Company Information → Instance URL**, or read
it from the browser address bar of a Salesforce setup page. It is the origin
(e.g. `https://my-org.my.salesforce.com`) — **not** a `lightning.force.com` URL.

Append `/services/data/v66.0`. Use your org's API version; `66.0` is the server
default.

### `DATA360_TENANT_URL` — Data 360 tenant

This is the **c360a** host for your Data 360 tenant, with **no path suffix**:

```
https://my-tenant.c360a.salesforce.com
```

Find it in **Setup → Data Cloud / Data 360 → ... → Tenant URL**, or from the URL
bar while working inside Data 360. It is a *different host* from your core org —
this is the single most common configuration mistake.

### `DATA360_CONNECT_BASE_URL` — Data 360 Connect

The same tenant host, but **with** the `/services/data/vXX` suffix:

```
https://my-tenant.c360a.salesforce.com/services/data/v66.0
```

### `SF_LOGIN_URL` — OAuth token host

| Org type | Value |
| --- | --- |
| Production / Developer | `https://login.salesforce.com` (default) |
| Sandbox | `https://test.salesforce.com` |

### `SF_INSTANCE_URL` — platform tools

Optional. Defaults to the origin of `MC_NEXT_API_BASE_URL`. Set it only if your
platform tools should target a different org.

### Quick self-check

| Variable | Shape | Common mistake |
| --- | --- | --- |
| `MC_NEXT_API_BASE_URL` | `https://X.my.salesforce.com/services/data/v66.0` | Using a `lightning.force.com` URL |
| `DATA360_TENANT_URL` | `https://X.c360a.salesforce.com` | Adding `/services/data/vXX` (wrong — no suffix here) |
| `DATA360_CONNECT_BASE_URL` | `https://X.c360a.salesforce.com/services/data/v66.0` | Omitting `/services/data/vXX` |
| `SF_LOGIN_URL` | `https://login.salesforce.com` | Using `login` for a sandbox org |

---

## Security best practices

### Least privilege

- Enable **only** the scopes you need. Each `cdp_*` scope grants real data access.
- Set the **Run As** user to a dedicated integration user, not an admin.
- Give that integration user a permission set scoped to the objects and fields
  the server actually touches.
- **Never** enable destructive operations (`MC_NEXT_ALLOW_DESTRUCTIVE`) or schema
  changes (`MC_NEXT_ALLOW_METADATA_CHANGES`) in a production org until you have a
  specific, reviewed need. Both default to `false` for this reason.

### Secret handling

- Treat `SF_CLIENT_SECRET` as a password. It grants full access to whatever the
  Run As user can reach.
- **Never commit it.** `.env` is already in `.gitignore`.
- Store it in your MCP client's `env` block, or a secrets manager. Do not paste
  it into a shared `mcp.json` that is committed to a repo.
- If it leaks, use **Manage Consumer Details → Regenerate** immediately, then
  update every deployment.

### Rotation

Salesforce does not expire client-credentials secrets automatically, which means
**a leaked secret stays valid indefinitely**. Rotate on a schedule:

1. Generate a new secret via **Manage Consumer Details**.
2. Update every deployment (MCP clients, CI, containers).
3. Confirm calls still succeed.
4. Retire the old secret.

Because regeneration invalidates the previous secret immediately, rotate during a
maintenance window and update all consumers together.

### Separate apps per environment

Create a **separate Connected App** for each org (dev, sandbox, production).
This keeps credentials isolated, makes revocation surgical, and prevents a
sandbox misconfiguration from reaching production data.

### Monitoring and revocation

- **Setup → Connected Apps → OAuth Usage** shows token requests and can be used
  to spot unexpected activity.
- **Setup → Connected Apps → Manage** lets you revoke access, which invalidates
  outstanding tokens.
- Enable **session policies** and an IP range if your org requires it — though be
  aware the integration user's session behavior is governed by these settings.

---

## Troubleshooting

### `invalid_client`

The `SF_CLIENT_ID` or `SF_CLIENT_SECRET` is wrong.

- Re-copy both from **Manage Consumer Details** — trailing whitespace is a
  common culprit.
- Confirm you did not mix credentials from two different Connected Apps.
- Confirm the app is in the org matching your `SF_LOGIN_URL`.

### `unsupported_grant_type`

The **Client Credentials Flow** checkbox is not enabled on the Connected App.

- Go to **App Manager → your app → Manage → Edit Policies**, tick
  **Enable Client Credentials Flow**, and set a **Run As** user.

### `invalid_grant`

Usually the **Run As** user is missing, deactivated, or locked.

- Set a valid, active Run As user in the app's policies.
- Confirm that user can log in (not frozen, password not expired).

### `inactive_user` / `inactive_org`

The Run As user is deactivated, or the org is inactive/trial-expired.

### Permission errors on specific calls

The scope for that API family is not enabled.

- Cross-reference the failing endpoint's family against the
  [scope table](#scope--capability-mapping).
- Enable the missing scope, save, and wait for propagation.

### Propagation delay

Newly created or edited Connected Apps can take **2–10 minutes** to take effect.
If a call fails immediately after a change, wait and retry before debugging
further.

### `invalid_scope`

A scope you requested is not available in this org, or is misspelled. Note that
some scopes are only available with specific Salesforce editions or add-on
licenses (Data 360 in particular).

### Everything looks right but calls still fail

Run with `MC_NEXT_DEBUG=true` and read the stderr output — it logs each HTTP
request and the token acquisition. See
[DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md#logging).

---

## Next steps

- [VS-CODE-SETUP.md](VS-CODE-SETUP.md) — use the server with VS Code + Copilot
- [CLAUDE-DESKTOP-SETUP.md](CLAUDE-DESKTOP-SETUP.md) — use it with Claude Desktop
- [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) — Docker, multi-org, monitoring
