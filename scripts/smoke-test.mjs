#!/usr/bin/env node
/**
 * smoke-test.mjs — connects to the built MCP server over stdio and exercises
 * the catalog tools (no credentials required for these).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, MC_NEXT_DEBUG: 'false' },
  stderr: 'pipe',
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });

function show(label, res) {
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  console.log(`\n=== ${label} ===`);
  console.log(text.length > 1400 ? text.slice(0, 1400) + '\n…(truncated)' : text);
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    console.log(`  ✘ ${label}`);
    failures++;
  }
}

try {
  await client.connect(transport);
  console.log('✔ connected');

  const tools = await client.listTools();
  console.log(`✔ tools (${tools.tools.length}):`);
  for (const t of tools.tools) console.log(`   - ${t.name}`);

  const resources = await client.listResources();
  console.log(`✔ resources: ${resources.resources.map((r) => r.uri).join(', ')}`);

  const prompts = await client.listPrompts();
  console.log(`✔ prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);

  console.log('\n--- assertions ---');
  const names = tools.tools.map((t) => t.name);
  for (const expected of [
    'mcnext_list_endpoints',
    'mcnext_describe_endpoint',
    'mcnext_query',
    'mcnext_read',
    'mcnext_create',
    'mcnext_update',
    'mcnext_delete',
    'mcnext_action',
    'sf_soql_query',
    'sf_soql_query_more',
    'sf_list_objects',
    'sf_describe_object',
    'sf_rest_request',
    'sf_org_limits',
  ]) {
    check(`tool registered: ${expected}`, names.includes(expected));
  }

  // --- catalog browsing ---------------------------------------------------
  const byFamily = await client.callTool({
    name: 'mcnext_list_endpoints',
    arguments: { family: 'mc-next' },
  });
  const byFamilyText = byFamily.content?.[0]?.text ?? '';
  check('family filter returns mc-next endpoints', byFamilyText.includes('"family": "mc-next"'));
  check('family filter returns 27 endpoints', byFamilyText.includes('"total": 27'));

  const search = await client.callTool({
    name: 'mcnext_list_endpoints',
    arguments: { search: 'unpublish-an-email', limit: 5 },
  });
  const searchText = search.content?.[0]?.text ?? '';
  check('search finds the unpublish endpoint', searchText.includes('content.unpublish-an-email'));

  const searchByPath = await client.callTool({
    name: 'mcnext_list_endpoints',
    arguments: { search: 'calculated-insights', family: 'data360', limit: 10 },
  });
  check(
    'search matches on path/id within a family',
    (searchByPath.content?.[0]?.text ?? '').includes('calculated-insights')
  );

  const groups = await client.callTool({
    name: 'mcnext_list_endpoints',
    arguments: { family: 'data360-connect', limit: 1 },
  });
  check(
    'unfiltered-by-group call returns groupsInFamily',
    (groups.content?.[0]?.text ?? '').includes('groupsInFamily')
  );

  // --- describe -----------------------------------------------------------
  const describe = await client.callTool({
    name: 'mcnext_describe_endpoint',
    arguments: { endpointId: 'content.create-an-email-with-html' },
  });
  const describeText = describe.content?.[0]?.text ?? '';
  check('describe returns baseUrl', describeText.includes('baseUrl'));
  check('describe returns bodySchema', describeText.includes('bodySchema'));

  const bogus = await client.callTool({
    name: 'mcnext_describe_endpoint',
    arguments: { endpointId: 'content.create-an-email-with-htm' },
  });
  check('bogus id yields suggestions', (bogus.content?.[0]?.text ?? '').includes('Did you mean'));

  // --- safety guards ------------------------------------------------------
  const del = await client.callTool({
    name: 'mcnext_delete',
    arguments: { endpointId: 'content.delete-an-email', pathParams: { variantId: 'x' } },
  });
  check('destructive delete blocked by default', del.isError === true);

  const wrongVerb = await client.callTool({
    name: 'mcnext_query',
    arguments: { endpointId: 'content.create-an-email-with-html' },
  });
  check('wrong verb rejected', wrongVerb.isError === true);

  const missingParam = await client.callTool({
    name: 'mcnext_read',
    arguments: { endpointId: 'content.retrieve-an-email-by-id-or-key' },
  });
  check('missing path param reported', missingParam.isError === true);

  const restDelete = await client.callTool({
    name: 'sf_rest_request',
    arguments: { method: 'DELETE', path: '/sobjects/Account/001' },
  });
  check('sf_rest_request DELETE blocked by default', restDelete.isError === true);

  // --- non-JSON body handling --------------------------------------------
  const csv = await client.callTool({
    name: 'mcnext_describe_endpoint',
    arguments: { endpointId: 'ingestion-api.upload-job' },
  });
  check('CSV endpoint typed as text/csv', (csv.content?.[0]?.text ?? '').includes('text/csv'));

  // --- sample output ------------------------------------------------------
  show('list_endpoints(family=mc-next, limit=3)', await client.callTool({
    name: 'mcnext_list_endpoints',
    arguments: { family: 'mc-next', limit: 3 },
  }));

  show('describe_endpoint(content.create-an-email-with-html)', describe);

  show('describe_endpoint(bogus id) -> suggestions', bogus);

  show('delete blocked by safety guard', del);

  await client.close();

  console.log(`\n${failures === 0 ? '✔ smoke test complete — all assertions passed' : `✘ ${failures} assertion(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('✘ smoke test failed:', err);
  process.exit(1);
}
