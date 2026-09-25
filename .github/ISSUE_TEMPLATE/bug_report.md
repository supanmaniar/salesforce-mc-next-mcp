---
name: Bug report
about: Report something that is broken or behaving unexpectedly
title: '[Bug] '
labels: ['bug']
assignees: ''
---

<!--
Thanks for the report. The environment details below matter a lot for this
project, because most problems turn out to be configuration rather than code.
Please fill them in — it usually saves a round trip.
-->

## What happened

<!-- A clear description of the bug. -->

## What you expected to happen

<!-- What did you expect instead? -->

## Steps to reproduce

1.
2.
3.

<!--
If the bug involves a specific MCP tool call, include the tool name and the exact
arguments. Please REDACT your credentials, org hostnames, and record ids.
-->

```json
{
  "name": "",
  "arguments": {}
}
```

## Actual output

<!--
Paste the exact error. If it is an MCP tool result, include the full text
including any `hint` field.
-->

```
```

## Environment

| | |
| --- | --- |
| **Server version** | <!-- e.g. 1.0.0, or the commit SHA --> |
| **Install method** | <!-- git clone / Docker / npm --> |
| **MCP client** | <!-- VS Code + Copilot / Claude Desktop / Claude Code / other --> |
| **Client version** | |
| **Node version** | <!-- output of `node --version` --> |
| **OS** | <!-- e.g. macOS 15.1, Ubuntu 24.04, Windows 11 --> |

## Salesforce configuration

<!-- Delete rows that do not apply, but please answer the ones that do. -->

| | |
| --- | --- |
| **Org type** | <!-- production / sandbox / developer / scratch --> |
| **API family involved** | <!-- mc-next / data360 / data360-connect / platform (sf_*) --> |
| **Scopes enabled on the Connected App** | <!-- e.g. sfdc_cms_api, api --> |

## Safety gate state

<!-- Tick whichever applies. -->

- [ ] Both gates are at their defaults (`false`)
- [ ] `MC_NEXT_ALLOW_DESTRUCTIVE=true`
- [ ] `MC_NEXT_ALLOW_METADATA_CHANGES=true`

> Please do not enable either gate in a production org just to reproduce a bug.

## Debug logs

<!--
Highly recommended. Set MC_NEXT_DEBUG=true and reproduce, then paste the stderr
output. It logs each HTTP request and the token acquisition.

REDACT BEFORE PASTING: bearer tokens, your consumer secret, and if sensitive,
org hostnames.

  VS Code        -> Output panel, MCP server channel
  Claude Desktop -> mcp-server-mc-next.log in the Claude logs directory
  Manual         -> the terminal's stderr
-->

```
```

## Checks

- [ ] I ran `npm run smoke` and it passed (this isolates server problems from config problems)
- [ ] I searched existing issues for a duplicate
- [ ] I have redacted credentials and sensitive org details from this report

## Anything else

<!-- Workarounds you found, when it started, related issues, etc. -->
