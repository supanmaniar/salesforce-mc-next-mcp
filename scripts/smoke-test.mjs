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
    'sf_create_record',
    'sf_get_record',
    'sf_update_record',
    'sf_delete_record',
    'sf_bulk_create_records',
    'sf_bulk_update_records',
    'sf_bulk_delete_records',
    'sf_composite',
    'sf_create_custom_object',
    'sf_create_custom_field',
    'sf_delete_custom_field',
    'sf_delete_custom_object',
    'sf_list_custom_objects',
    'sf_list_custom_fields',
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

  // --- record CRUD guards -------------------------------------------------
  const delRecord = await client.callTool({
    name: 'sf_delete_record',
    arguments: { sobject: 'Account', id: '001000000000001AAA' },
  });
  check('sf_delete_record blocked by default', delRecord.isError === true);
  check(
    'sf_delete_record names the flag',
    (delRecord.content?.[0]?.text ?? '').includes('MC_NEXT_ALLOW_DESTRUCTIVE')
  );

  const bulkDel = await client.callTool({
    name: 'sf_bulk_delete_records',
    arguments: { sobject: 'Account', ids: ['001000000000001AAA'] },
  });
  check('sf_bulk_delete_records blocked by default', bulkDel.isError === true);

  const compositeDel = await client.callTool({
    name: 'sf_composite',
    arguments: {
      compositeRequest: [{ method: 'DELETE', url: '/sobjects/Account/001', referenceId: 'd1' }],
    },
  });
  check('sf_composite with DELETE blocked by default', compositeDel.isError === true);

  // --- bulk update validation (no credentials needed) ---------------------
  const bulkUpdNoId = await client.callTool({
    name: 'sf_bulk_update_records',
    arguments: { sobject: 'Account', records: [{ Name: 'No Id Here' }] },
  });
  check('sf_bulk_update_records requires Id', bulkUpdNoId.isError === true);
  check(
    'bulk update error mentions Id',
    (bulkUpdNoId.content?.[0]?.text ?? '').includes('missing an "Id"')
  );

  // --- metadata guards ----------------------------------------------------
  const createObj = await client.callTool({
    name: 'sf_create_custom_object',
    arguments: { label: 'Invoice' },
  });
  check('sf_create_custom_object blocked by default', createObj.isError === true);
  check(
    'metadata guard names the flag',
    (createObj.content?.[0]?.text ?? '').includes('MC_NEXT_ALLOW_METADATA_CHANGES')
  );

  const createField = await client.callTool({
    name: 'sf_create_custom_field',
    arguments: { sobject: 'Account', name: 'Foo', label: 'Foo', type: 'Text' },
  });
  check('sf_create_custom_field blocked by default', createField.isError === true);

  const delField = await client.callTool({
    name: 'sf_delete_custom_field',
    arguments: { fieldId: '00N000000000001AAA' },
  });
  check('sf_delete_custom_field blocked by default', delField.isError === true);

  const delObj = await client.callTool({
    name: 'sf_delete_custom_object',
    arguments: { objectId: '01I000000000001AAA' },
  });
  check('sf_delete_custom_object blocked by default', delObj.isError === true);

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

  // ------------------------------------------------------------------------
  // Phase 2: with the safety flags ENABLED, verify validation logic that sits
  // behind the guards. These still fail (no credentials), but they must fail
  // with a *validation* error rather than a guard refusal.
  // ------------------------------------------------------------------------
  console.log('\n--- phase 2: flags enabled (validation paths) ---');

  const transport2 = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      MC_NEXT_DEBUG: 'false',
      MC_NEXT_ALLOW_DESTRUCTIVE: 'true',
      MC_NEXT_ALLOW_METADATA_CHANGES: 'true',
    },
    stderr: 'pipe',
  });
  const client2 = new Client({ name: 'smoke-test-2', version: '1.0.0' });
  await client2.connect(transport2);

  const textOf = (r) => r.content?.find((c) => c.type === 'text')?.text ?? '';

  const textNoLength = await client2.callTool({
    name: 'sf_create_custom_field',
    arguments: { sobject: 'Account', name: 'Foo', label: 'Foo', type: 'Text' },
  });
  check(
    'Text field without length is rejected',
    textOf(textNoLength).includes('requires a `length`')
  );

  const numericNoScale = await client2.callTool({
    name: 'sf_create_custom_field',
    arguments: { sobject: 'Account', name: 'Amt', label: 'Amt', type: 'Currency', precision: 18 },
  });
  check(
    'Currency field without scale is rejected',
    textOf(numericNoScale).includes('requires both `precision` and `scale`')
  );

  const picklistEmpty = await client2.callTool({
    name: 'sf_create_custom_field',
    arguments: { sobject: 'Account', name: 'Stage', label: 'Stage', type: 'Picklist' },
  });
  check(
    'Picklist without values is rejected',
    textOf(picklistEmpty).includes('requires a non-empty `picklistValues`')
  );

  const scaleTooBig = await client2.callTool({
    name: 'sf_create_custom_field',
    arguments: {
      sobject: 'Account',
      name: 'Amt',
      label: 'Amt',
      type: 'Number',
      precision: 4,
      scale: 9,
    },
  });
  check(
    'scale > precision is rejected',
    textOf(scaleTooBig).includes('cannot exceed')
  );

  const badIds = await client2.callTool({
    name: 'sf_bulk_delete_records',
    arguments: { sobject: 'Account', ids: ['not-an-id'] },
  });
  check(
    'invalid Salesforce Ids are rejected',
    textOf(badIds).includes('not valid Salesforce Ids')
  );

  const guardNowOpen = await client2.callTool({
    name: 'sf_delete_record',
    arguments: { sobject: 'Account', id: '001000000000001AAA' },
  });
  check(
    'with flag enabled, delete passes the guard and reaches the API',
    !textOf(guardNowOpen).includes('MC_NEXT_ALLOW_DESTRUCTIVE')
  );

  await client2.close();

  console.log(`\n${failures === 0 ? '✔ smoke test complete — all assertions passed' : `✘ ${failures} assertion(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('✘ smoke test failed:', err);
  process.exit(1);
}
