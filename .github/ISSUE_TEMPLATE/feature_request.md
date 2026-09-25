---
name: Feature request
about: Suggest a new capability, tool, or endpoint
title: '[Feature] '
labels: ['enhancement']
assignees: ''
---

## What problem are you trying to solve?

<!--
Describe the problem, not the solution. "I cannot do X" is more useful than
"add a tool called Y", because there may be a better way to solve it.
-->

## What I would like to happen

<!-- Your proposed solution, if you have one. -->

## Is this about endpoint coverage or tool behaviour?

This distinction matters, because the two are fixed in different places.

- [ ] **Endpoint coverage** — an API endpoint is missing or wrong.
      See [docs/POSTMAN-COLLECTIONS.md](https://github.com/supanmaniar/salesforce-mc-next-mcp/blob/main/docs/POSTMAN-COLLECTIONS.md).
      Note that the catalog is generated from Salesforce's Postman collections,
      which are not in this repo.
- [ ] **Tool behaviour** — an existing tool should behave differently.
- [ ] **New platform tool** — something like `sf_*` that is not catalog-driven.
- [ ] **Documentation**
- [ ] **Not sure**

## If this is about endpoint coverage

<!-- Fill in whichever you know. -->

| | |
| --- | --- |
| **API family** | <!-- mc-next / data360 / data360-connect / platform --> |
| **Endpoint id** (if it exists but is wrong) | |
| **HTTP method and path** | <!-- e.g. POST /connect/cms/contents --> |
| **Salesforce documentation link** | |

- [ ] I checked whether this exists in a **newer version** of the official Postman collection
- [ ] I checked the [known gaps](https://github.com/supanmaniar/salesforce-mc-next-mcp/blob/main/docs/POSTMAN-COLLECTIONS.md#known-gaps-in-the-collections) list

## Alternatives considered

<!-- Workarounds you tried. For a core-org endpoint, `sf_rest_request` often works today. -->

## Is this destructive or schema-changing?

<!-- Relevant because such tools must be gated. -->

- [ ] Yes — this operation destroys data
- [ ] Yes — this operation changes org schema
- [ ] No

## Additional context

<!-- Mockups, example payloads, related issues, links. -->
