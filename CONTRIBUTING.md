# Contributing to mc-next-mcp-server

Thanks for your interest in improving `mc-next-mcp-server`. This document covers
how to report issues, propose changes, and get a pull request merged.

By participating you agree to keep discussion technical, respectful, and focused
on the project.

---

## Ways to contribute

| I want to… | Do this |
| --- | --- |
| Report a bug | Open an issue using the **Bug report** template |
| Request a feature or new endpoint coverage | Open an issue using the **Feature request** template |
| Fix a bug or add a feature | Open a pull request (see [Pull requests](#pull-requests)) |
| Improve the docs | Open a pull request touching `README.md` or `CHANGELOG.md` |
| Ask a usage question | Open an issue with the `question` label |

Before opening an issue, please search the existing issues to avoid duplicates.

---

## Development setup

### Requirements

- **Node.js >= 18** (see `engines` in `package.json`)
- npm
- No Salesforce org is required for most development — the catalog tools and the
  smoke test run without credentials.

### Get running

```bash
git clone https://github.com/supanmaniar/salesforce-mc-next-mcp.git
cd salesforce-mc-next-mcp
npm install
npm run build
npm run smoke
```

If `npm run smoke` passes, your environment is good. It asserts the tool
surface, the two safety gates, and the validation paths — **without any
credentials**.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run generate` | Regenerate `catalog/endpoints.json` from the Postman collections |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run dev` | `tsc --watch` |
| `npm run start` | Run the built server (`node dist/index.js`) |
| `npm run smoke` | End-to-end MCP client test over `stdio` |
| `npm run audit` | Fidelity checks on the generated catalog |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `node scripts/inspect-raw.mjs <dir>` | Diagnose raw request bodies in the source collections |

> **Never hand-edit `catalog/endpoints.json`.** It is generated. Edit the
> generator (`scripts/generate-catalog.mjs`) and regenerate instead.

---

## The catalog regeneration workflow

The endpoint catalog is **generated**, not authored. This is the single most
important workflow to understand before changing anything endpoint-related.

```
Postman collections  ──►  scripts/generate-catalog.mjs  ──►  catalog/endpoints.json
   (source of truth)              (transform)                    (committed artifact)
```

### Where the input comes from

The generator reads three Postman collections from a directory that is
**deliberately not part of this repository** (the collections are Salesforce's
and are excluded for licensing reasons):

```
Salesforce Marketing Cloud Next APIs.postman_collection.json
Salesforce Data 360 APIs.postman_collection.json
Salesforce Data 360 Connect APIs.postman_collection.json
```

By default the generator looks in `../Marketing Cloud Next MCP Prep` relative to
the project root. You can override both paths with positional arguments:

```bash
node scripts/generate-catalog.mjs <input-dir> <output-file>
```

### What this means for contributors

- **You do not need the collections for most work.** `catalog/endpoints.json`
  (445 endpoints, ~1 MB) **is committed**, so `npm run build` and `npm run smoke`
  work on a fresh clone without ever running the generator.
- **If you only need to change tool behaviour**, edit the TypeScript in `src/`.
- **If you need to change how endpoints are parsed or classified**, edit
  `scripts/generate-catalog.mjs` — but you will need the source collections
  locally to verify your change, since regenerating without them is not possible.
- If you cannot obtain the collections, say so in your PR. Maintainers can
  regenerate and commit the resulting catalog for you.

### Verifying a catalog change

Always run both, in this order:

```bash
npm run generate
npm run audit
npm run build && npm run smoke
```

The audit script checks catalog fidelity and will fail loudly on regressions
such as lost endpoints, malformed schemas, or miscounted groups. Never commit a
regenerated catalog that fails the audit.

### Generator invariants to preserve

These are load-bearing behaviours, and changes that break them will be rejected:

1. **No `required` arrays in body schemas.** The collections provide *sample*
   bodies only, so every property would appear required. Marking them required
   would be wrong, especially for `PATCH` endpoints.
2. **Empty raw bodies mean "no body"**, not an empty JSON body. Many `GET`/`DELETE`
   requests declare `mode: raw` with `raw: ""`; these normalize to
   `bodyMode: null`.
3. **Non-JSON bodies keep their real content type.** The Ingestion API bulk
   upload is CSV and is typed `text/csv`, then passed through verbatim.
4. **Host placeholders are resolved by longest-prefix match.** The collections use
   several variable styles (`{{apiBaseUrl}}{{apiBasePath}}`, `{{_dcTenantUrl}}`,
   `{{baseUrl}}`, `{{dne_cdpInstanceUrl}}`, `{{loginUrl}}`).
5. **Every endpoint resolves to a `base` key** that maps to a configured host.

---

## Code standards

### Language & style

- **TypeScript**, ESM (`"type": "module"`). Use `.js` extensions in relative
  imports — that is required for ESM output, not a typo.
- Match the style of the surrounding file. The codebase favours small,
  focused modules over large ones.
- Keep modules single-purpose. Existing layout:
  - `config.ts` — environment parsing and defaults
  - `auth.ts` — OAuth client-credentials token manager
  - `catalog.ts` — catalog loading and query helpers
  - `client.ts` — HTTP client (retry, re-auth, multi-base routing)
  - `sfrest.ts` — shared Salesforce REST client
  - `platform.ts`, `records.ts`, `metadata.ts` — tool groups
  - `tools.ts`, `index.ts` — registration and entrypoint
- **Never write logs to stdout.** stdout is the MCP protocol channel; use
  `stderr` (the `MC_NEXT_DEBUG` path already does this). A stray `console.log`
  will corrupt the protocol stream.

### Tool conventions

- `registerTool` takes the **tool name as the first argument**. Passing only an
  options object may compile under a cast but fails at runtime.
- Every tool needs a description precise enough for a model to select it
  correctly, and a Zod schema for its inputs.
- **Any new destructive or schema-changing tool must be gated** behind the
  appropriate flag (`MC_NEXT_ALLOW_DESTRUCTIVE` or
  `MC_NEXT_ALLOW_METADATA_CHANGES`) and must return a clear refusal message when
  the gate is closed.
- New tools must be reflected in `README.md`, `CHANGELOG.md`, and the smoke test.

### Safety rules (non-negotiable)

These are the project's core guarantees. A PR that weakens any of them will be
rejected:

1. Both safety gates default to **`false`**.
2. The two gates stay **independent** — neither may imply the other.
3. Destructive operations are blocked **before** any network call is made.
4. Credentials are never logged, and never written to stdout.

### Type checking, linting, and formatting

All three gates must pass before a PR is ready:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint (flat config, eslint.config.mjs)
npm run format:check   # Prettier
```

Use `npm run lint:fix` and `npm run format` to apply fixes automatically.

`tsconfig.json` has `strict: true`. ESLint additionally enforces `prefer-const`,
`no-var`, and `eqeqeq`. Prettier is the single source of truth for formatting —
do not hand-align code against it.

> **A pre-commit hook runs `lint-staged`** on staged files (ESLint `--fix` +
> Prettier). Husky installs it via the `prepare` script on `npm install`. To skip
> it in an emergency, use `git commit --no-verify` — but CI will still enforce the
> same checks, so skipping only defers the failure.

---

## Tests

The project ships one end-to-end test today: **the smoke test**.

```bash
npm run build && npm run smoke
```

It spins up the built server over `stdio` as a real MCP client and asserts:

- the server connects and exposes exactly the expected tool surface
- the safety gates refuse destructive and schema-changing operations by default
- input validation rejects malformed calls
- a second server instance, started with **both** gates enabled, exercises the
  gated paths (including field-type validation, which runs after the metadata
  guard)

### Expectations for contributors

- **Run `npm run smoke` before opening a PR.** A red smoke test means the PR is
  not ready.
- **Adding a tool?** Add assertions for it. The smoke test is the regression net
  for the tool surface; an unasserted tool can silently break.
- **Assert on specific endpoint ids**, not loose search terms. The catalog search
  matches id, name, path, *and* description, so a term like `publish` matches
  many endpoints incidentally. Loose assertions produce false confidence.
- **Test the refusal path** for anything gated — assert the gate blocks when
  closed, not just that it allows when open.

There is currently **no automated testing against a live Salesforce org**, and
no unit-test framework. Adding a lightweight unit-test harness for pure
functions (catalog parsing, config resolution) would be a welcome contribution —
please open an issue first so the approach can be agreed on.

---

## Pull requests

### Before you open one

1. `npm run typecheck`, `npm run lint`, and `npm run format:check` pass.
2. `npm run build` and `npm run smoke` pass.
3. `npm run audit` passes.
4. If you touched the generator, the regenerated `catalog/endpoints.json` is
   included in the commit.
5. Docs are updated (`README.md` and/or `CHANGELOG.md`).

All of these run in CI on Node 18, 20, and 22. Running them locally first saves a
round trip.

### Branch names

Use a short, prefixed branch name:

```
feat/add-<thing>
fix/<bug>
docs/<area>
chore/<task>
```

### Commit messages

This project uses **[Conventional Commits](https://www.conventionalcommits.org/)**.
The existing history follows this format closely, so keep it consistent:

```
<type>(<optional scope>): <imperative summary>

<optional body — what and why, not how>
```

Allowed types:

| Type | Use for |
| --- | --- |
| `feat` | A new tool, endpoint family, or capability |
| `fix` | A bug fix |
| `docs` | README, CHANGELOG, comments |
| `test` | Smoke test or audit script changes |
| `refactor` | Internal change with no behaviour change |
| `chore` | Build, deps, scaffolding |

Examples drawn from this project's history:

```
feat: add catalog-driven MCP tools
fix: gate destructive actions before the network call
docs: document CRUD tools and the two safety gates
refactor: extract shared Salesforce REST client from platform tools
chore: initialize project with TypeScript and MCP SDK
```

Guidelines:

- Write the summary in the **imperative mood** ("add", not "added").
- Keep the summary under ~72 characters.
- One logical change per commit. Prefer several focused commits over one large one.
- Reference issues in the body (`Closes #12`), not the summary.

### What reviewers look for

- **Correctness** — does it do what it claims, including on failure paths?
- **Safety** — are gates respected, is anything destructive left ungated?
- **Scope** — does the PR do one thing? Unrelated refactors belong in their own PR.
- **Surface consistency** — new tools are documented and asserted.
- **Generated artifacts** — `catalog/endpoints.json` changes come from the
  generator, never from a hand edit.

### Review expectations

- Maintainers aim to give a first response within about a week. This is a
  volunteer project; please be patient and feel free to ping a thread after a
  week of silence.
- Please **do not force-push** after review has started — it makes re-review
  hard. Add follow-up commits and let the maintainer squash on merge.
- Keep discussions on the PR, so the reasoning stays discoverable.

---

## Reporting security issues

Please **do not** open a public issue for a security vulnerability. Instead,
report it privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the repository's **Security** tab, or contact the maintainer directly.

Relevant classes of issue for this project include credential leakage,
safety-gate bypasses, and any path where a destructive operation could execute
with the gates closed.

---

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), the same terms that cover this project.
