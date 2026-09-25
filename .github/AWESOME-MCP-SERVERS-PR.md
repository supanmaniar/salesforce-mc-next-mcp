# awesome-mcp-servers submission

Prepared entry for a PR to
[punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers).

This file is a **staging document**, not part of the published package. It exists
so the submission can be reviewed and applied without re-deriving the format.

---

## Status

| Step | State |
| --- | --- |
| Entry drafted | ✅ |
| Target section identified | ✅ `Customer Data Platforms` |
| Alphabetical position determined | ✅ |
| PR opened | ❌ **Not yet** — requires the repo owner's GitHub identity |
| Published to npm | ❌ Not yet (not a blocker, but strengthens the entry) |

---

## Target section

**`### 👤 Customer Data Platforms`**

> Provides access to customer profiles inside of customer data platforms

This is the correct section: Data 360 is Salesforce's customer data platform, and
the server exposes its profile, segment, and identity-resolution APIs. The section
already contains CDP-adjacent servers (`dchub-mcp-server`, `mcp-icp-fit-scorer`).

Alternative considered: **`### 📊 Data Platforms`**. Rejected — that section is
about warehouses and query engines (Tinybird, Snowflake-style), not customer
profiles.

---

## Emoji selection

From the list's [legend](https://github.com/punkpeye/awesome-mcp-servers#legend):

| Emoji | Meaning | Applies? | Why |
| --- | --- | --- | --- |
| 📇 | TypeScript / JavaScript codebase | ✅ | The server is TypeScript |
| ☁️ | Cloud Service | ✅ | It talks to remote Salesforce APIs |
| 🏠 | Local Service | ❌ | It is not controlling locally installed software |
| 🎖️ | Official implementation | ❌ | Community project, not built by Salesforce |

So: **📇 ☁️**

---

## Alphabetical position

The section is ordered alphabetically by `owner/repo`. The relevant neighbours:

```
mambalabsdev/mcp-icp-fit-scorer
                                <- mc-next-mcp-server goes here ("mc-" > "ma-")
OpenDataMCP/OpenDataMCP
```

Comparing case-insensitively: `mambalabsdev` < `mc-next-mcp-server` <
`opendatamcp`. So the entry is inserted **after `mambalabsdev/mcp-icp-fit-scorer`**
and **before `OpenDataMCP/OpenDataMCP`**.

---

## The entry

```markdown
- [supanmaniar/salesforce-mc-next-mcp](https://github.com/supanmaniar/salesforce-mc-next-mcp) 📇 ☁️ - Salesforce Marketing Cloud Next, Data 360 and Data 360 Connect APIs plus platform tools (SOQL, describe, record and metadata CRUD). 445 endpoints behind 28 catalog-driven tools, with destructive and schema-change operations gated behind separate opt-in flags. stdio transport, OAuth client-credentials, MIT.
```

### Why this wording

- **Leads with what it connects to**, not with the implementation, matching the
  surrounding entries.
- **Names the concrete count** (445 endpoints / 28 tools) — specific numbers are
  what make an entry skimmable in a long list.
- **Mentions the safety gates**, because "gated destructive operations" is a
  genuine differentiator for an agent-facing server.
- **States transport and license** in the tail, as several neighbours do.
- **Does not claim npm availability**, because it is not published yet. An
  inaccurate claim in an awesome list is a reason for rejection.

---

## PR details

**Branch:** `add-salesforce-mc-next-mcp`

**Title:**

```
Add Salesforce Marketing Cloud Next / Data 360 server
```

> The list's CONTRIBUTING notes that agent-authored PRs can be fast-tracked by
> appending `🤖🤖🤖` to the title. Only do this if the PR is genuinely
> agent-authored — do not append it otherwise.

**Body:**

```markdown
Adds [mc-next-mcp-server](https://github.com/supanmaniar/salesforce-mc-next-mcp)
to Customer Data Platforms.

It exposes Salesforce Marketing Cloud Next, Data 360, and Data 360 Connect behind
a single OAuth client-credentials token, plus Salesforce platform tools (SOQL,
describe, REST explorer, org limits, record and metadata CRUD).

- 445 API endpoints across 3 families and 44 resource groups, driven by a
  generated catalog
- 28 MCP tools — a small catalog-driven surface rather than one tool per endpoint,
  to keep the context footprint low and tool selection accurate
- Destructive operations and schema changes gated behind two independent,
  default-off flags
- stdio transport, MIT licensed
- CI runs lint, typecheck, build, an end-to-end smoke test, and a catalog audit on
  Node 22 and 24

Categorized under Customer Data Platforms, as Data 360 is Salesforce's CDP and
this server exposes its profile, segment, and identity-resolution APIs.

I believe this is the correct alphabetical position (after
`mambalabsdev/mcp-icp-fit-scorer`, before `OpenDataMCP/OpenDataMCP`) — please
correct me if not.
```

---

## How to apply

```bash
# 1. Fork via the GitHub UI, then:
gh repo clone <your-fork>/awesome-mcp-servers
cd awesome-mcp-servers
git checkout -b add-salesforce-mc-next-mcp

# 2. Edit README.md: insert the entry line at the position described above.
#    Verify the exact neighbours first, as the file changes often:
grep -n "mcp-icp-fit-scorer\|OpenDataMCP/OpenDataMCP" README.md

# 3. Commit and push
git add README.md
git commit -m "Add Salesforce Marketing Cloud Next / Data 360 server"
git push origin add-salesforce-mc-next-mcp

# 4. Open the PR
gh pr create --repo punkpeye/awesome-mcp-servers \
  --title "Add Salesforce Marketing Cloud Next / Data 360 server" \
  --body-file <path-to-body>
```

### Before submitting

- [ ] The target section still exists and is still named the same
- [ ] The neighbours are still `mambalabsdev/mcp-icp-fit-scorer` and `OpenDataMCP/OpenDataMCP`
- [ ] The repo is public and the README renders correctly
- [ ] Consider publishing to npm first, then updating the entry to mention it

> **Why this is not automated:** opening a PR to a third-party repository acts
> under the owner's GitHub identity and is publicly visible and attributable. That
> is the repository owner's decision to make, not an automated one.

---

## Other lists worth considering

| List | Fit | Notes |
| --- | --- | --- |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | ✅ Primary | Largest general list |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | ✅ Good | Also widely referenced; check its own format |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | ⚠️ Maybe | Mostly reference implementations; read the inclusion criteria first |
| [awesome-salesforce](https://github.com/mailtoharsh/awesome-salesforce) | ✅ Good | Domain-specific, smaller audience but highly targeted |
| [punkpeye/awesome-remote-mcp-servers](https://github.com/punkpeye/awesome-remote-mcp-servers) | ❌ No | Remote-only servers; this one is stdio/local |
