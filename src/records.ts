/**
 * records.ts — sObject record CRUD tools.
 *
 * Ported from Salesforce Inspector Reloaded's Inspect page (single-record
 * create/update/delete) and its batch patterns (Composite API for bulk
 * create/update, composite/sobjects for bulk delete).
 *
 *   create  POST   /sobjects/{SObject}
 *   read    GET    /sobjects/{SObject}/{id}
 *   update  PATCH  /sobjects/{SObject}/{id}
 *   delete  DELETE /sobjects/{SObject}/{id}
 *   bulk    POST   /composite/sobjects            (up to 200 records)
 *   bulkDel DELETE /composite/sobjects?ids=...    (up to 200 ids)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McNextConfig } from './config.js';
import type { TokenManager } from './auth.js';
import { SfRestClient, formatRest, type RestResult } from './sfrest.js';

type ToolResponse = CallToolResult;

/** Salesforce caps composite/sobjects at 200 records per call. */
const COMPOSITE_LIMIT = 200;

function ok(payload: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function fail(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function respond(res: RestResult): ToolResponse {
  const { payload, isError } = formatRest(res);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Salesforce ids are 15 or 18 alphanumeric characters. */
const idPattern = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const sobjectName = z
  .string()
  .describe('API name of the sObject, e.g. "Account", "Contact", or "My_Object__c".');

const recordId = z.string().describe('The 15- or 18-character Salesforce record Id.');

const recordFields = z
  .record(z.unknown())
  .describe(
    'Field name -> value map, e.g. { "Name": "Acme", "Industry": "Technology" }. ' +
      'Use sf_describe_object to discover field names and types.'
  );

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerRecordTools(
  server: McpServer,
  cfg: McNextConfig,
  tokens: TokenManager,
  client: SfRestClient
): void {
  /* ---------------------------------------------------------------------- */
  /* 1. sf_create_record                                                    */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_create_record',
    {
      title: 'Create a Salesforce record',
      description:
        'Create a single sObject record (POST /sobjects/{SObject}). Returns the new record Id. ' +
        'Use sf_describe_object first to check which fields are createable and required.',
      inputSchema: {
        sobject: sobjectName,
        fields: recordFields,
        tooling: z
          .boolean()
          .optional()
          .describe('Create via the Tooling API instead (for metadata records). Default false.'),
      },
    },
    async ({ sobject, fields, tooling }) => {
      const prefix = tooling ? '/tooling/sobjects/' : '/sobjects/';
      try {
        const res = await client.rest('POST', `${prefix}${encodeURIComponent(sobject)}`, {
          body: fields,
        });
        if (!res.ok) return respond(res);
        const data = res.data as { id?: string; success?: boolean; errors?: unknown } | null;
        return ok({
          created: true,
          sobject,
          id: data?.id ?? null,
          success: data?.success ?? null,
          errors: data?.errors ?? null,
          status: res.status,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. sf_get_record                                                       */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_get_record',
    {
      title: 'Get a Salesforce record',
      description:
        'Fetch a single record by Id (GET /sobjects/{SObject}/{id}). Optionally restrict the ' +
        'returned fields with `fields` to keep the response small.',
      inputSchema: {
        sobject: sobjectName,
        id: recordId,
        fields: z
          .array(z.string())
          .optional()
          .describe('Only return these field names, e.g. ["Id", "Name"]. Omit for all fields.'),
        tooling: z
          .boolean()
          .optional()
          .describe('Read via the Tooling API instead. Default false.'),
      },
    },
    async ({ sobject, id, fields, tooling }) => {
      const prefix = tooling ? '/tooling/sobjects/' : '/sobjects/';
      const query = fields?.length ? `?fields=${fields.map(encodeURIComponent).join(',')}` : '';
      try {
        const res = await client.rest(
          'GET',
          `${prefix}${encodeURIComponent(sobject)}/${encodeURIComponent(id)}${query}`
        );
        return respond(res);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 3. sf_update_record                                                    */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_update_record',
    {
      title: 'Update a Salesforce record',
      description:
        'Update a single record (PATCH /sobjects/{SObject}/{id}). Pass only the fields you want ' +
        'to change. Returns 204 No Content on success.',
      inputSchema: {
        sobject: sobjectName,
        id: recordId,
        fields: recordFields,
        tooling: z
          .boolean()
          .optional()
          .describe('Update via the Tooling API instead. Default false.'),
      },
    },
    async ({ sobject, id, fields, tooling }) => {
      const prefix = tooling ? '/tooling/sobjects/' : '/sobjects/';
      try {
        const res = await client.rest(
          'PATCH',
          `${prefix}${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`,
          { body: fields }
        );
        if (!res.ok) return respond(res);
        return ok({
          updated: true,
          sobject,
          id,
          fieldsUpdated: Object.keys(fields),
          status: res.status,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 4. sf_delete_record                                                    */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_delete_record',
    {
      title: 'Delete a Salesforce record',
      description:
        'Delete a single record (DELETE /sobjects/{SObject}/{id}). This is destructive and is ' +
        'blocked unless MC_NEXT_ALLOW_DESTRUCTIVE=true.',
      inputSchema: {
        sobject: sobjectName,
        id: recordId,
        tooling: z
          .boolean()
          .optional()
          .describe('Delete via the Tooling API instead. Default false.'),
      },
    },
    async ({ sobject, id, tooling }) => {
      if (!cfg.allowDestructive) {
        return fail(
          `Refusing to delete ${sobject}/${id}. Set MC_NEXT_ALLOW_DESTRUCTIVE=true to enable ` +
            'record deletion.'
        );
      }
      const prefix = tooling ? '/tooling/sobjects/' : '/sobjects/';
      try {
        const res = await client.rest(
          'DELETE',
          `${prefix}${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`
        );
        if (!res.ok) return respond(res);
        return ok({ deleted: true, sobject, id, status: res.status });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 5. sf_bulk_create_records                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_bulk_create_records',
    {
      title: 'Bulk create Salesforce records',
      description:
        `Create up to ${COMPOSITE_LIMIT} records in one call (POST /composite/sobjects). ` +
        'Each record is a field map. Set `allOrNone` to true to roll back the whole batch if any ' +
        'record fails. Larger inputs are split into multiple calls automatically.',
      inputSchema: {
        sobject: sobjectName,
        records: z
          .array(z.record(z.unknown()))
          .min(1)
          .describe('Array of field maps, e.g. [{ "Name": "A" }, { "Name": "B" }].'),
        allOrNone: z
          .boolean()
          .optional()
          .describe('Roll back the entire batch if any record fails. Default false.'),
      },
    },
    async ({ sobject, records, allOrNone }) => {
      const batches = chunk(records, COMPOSITE_LIMIT);
      const results: unknown[] = [];
      try {
        for (const batch of batches) {
          const res = await client.rest('POST', '/composite/sobjects', {
            body: {
              allOrNone: allOrNone ?? false,
              records: batch.map((r) => ({ attributes: { type: sobject }, ...r })),
            },
          });
          if (!res.ok) return respond(res);
          results.push(res.data);
        }
        const flat = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
        const succeeded = flat.filter((r) => (r as { success?: boolean })?.success === true).length;
        return ok({
          sobject,
          requested: records.length,
          batches: batches.length,
          succeeded,
          failed: flat.length - succeeded,
          results: flat,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 6. sf_bulk_update_records                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_bulk_update_records',
    {
      title: 'Bulk update Salesforce records',
      description:
        `Update up to ${COMPOSITE_LIMIT} records in one call (PATCH /composite/sobjects). ` +
        'Each record must include its `Id` plus the fields to change. Larger inputs are split ' +
        'into multiple calls automatically.',
      inputSchema: {
        sobject: sobjectName,
        records: z
          .array(z.record(z.unknown()))
          .min(1)
          .describe(
            'Array of field maps, each including "Id", e.g. [{ "Id": "001...", "Name": "A" }].'
          ),
        allOrNone: z
          .boolean()
          .optional()
          .describe('Roll back the entire batch if any record fails. Default false.'),
      },
    },
    async ({ sobject, records, allOrNone }) => {
      const missingId = records.filter((r) => !r.Id);
      if (missingId.length) {
        return fail(
          `${missingId.length} record(s) are missing an "Id" field. Every record in a bulk update ` +
            'must include its Id.'
        );
      }
      const batches = chunk(records, COMPOSITE_LIMIT);
      const results: unknown[] = [];
      try {
        for (const batch of batches) {
          const res = await client.rest('PATCH', '/composite/sobjects', {
            body: {
              allOrNone: allOrNone ?? false,
              records: batch.map((r) => ({ attributes: { type: sobject }, ...r })),
            },
          });
          if (!res.ok) return respond(res);
          results.push(res.data);
        }
        const flat = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
        const succeeded = flat.filter((r) => (r as { success?: boolean })?.success === true).length;
        return ok({
          sobject,
          requested: records.length,
          batches: batches.length,
          succeeded,
          failed: flat.length - succeeded,
          results: flat,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 7. sf_bulk_delete_records                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_bulk_delete_records',
    {
      title: 'Bulk delete Salesforce records',
      description:
        `Delete up to ${COMPOSITE_LIMIT} records per call (DELETE /composite/sobjects?ids=...). ` +
        'This is destructive and is blocked unless MC_NEXT_ALLOW_DESTRUCTIVE=true. Larger inputs ' +
        'are split into multiple calls automatically.',
      inputSchema: {
        sobject: sobjectName,
        ids: z.array(z.string()).min(1).describe('Array of record Ids to delete.'),
        allOrNone: z
          .boolean()
          .optional()
          .describe('Roll back the entire batch if any delete fails. Default false.'),
      },
    },
    async ({ sobject, ids, allOrNone }) => {
      if (!cfg.allowDestructive) {
        return fail(
          `Refusing to delete ${ids.length} ${sobject} record(s). Set ` +
            'MC_NEXT_ALLOW_DESTRUCTIVE=true to enable record deletion.'
        );
      }
      const invalid = ids.filter((id) => !idPattern.test(id));
      if (invalid.length) {
        return fail(
          `${invalid.length} value(s) are not valid Salesforce Ids: ${invalid.slice(0, 5).join(', ')}`
        );
      }
      const batches = chunk(ids, COMPOSITE_LIMIT);
      const results: unknown[] = [];
      try {
        for (const batch of batches) {
          const res = await client.rest(
            'DELETE',
            `/composite/sobjects?ids=${batch.join(',')}&allOrNone=${allOrNone ?? false}`
          );
          if (!res.ok) return respond(res);
          results.push(res.data);
        }
        const flat = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
        const succeeded = flat.filter((r) => (r as { success?: boolean })?.success === true).length;
        return ok({
          sobject,
          requested: ids.length,
          batches: batches.length,
          succeeded,
          failed: flat.length - succeeded,
          results: flat,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 8. sf_composite — batched mixed requests                               */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_composite',
    {
      title: 'Run a Salesforce Composite request',
      description:
        "Execute up to 25 subrequests in one API call (POST /composite), like Inspector's " +
        'Composite usage. Subrequests can reference earlier results with "@{referenceId.field}". ' +
        'Useful for multi-step operations that must stay within one API call.',
      inputSchema: {
        compositeRequest: z
          .array(
            z.object({
              method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
              url: z.string().describe('Path relative to /services/data/vXX.'),
              referenceId: z
                .string()
                .describe("Unique id used to reference this subrequest's result."),
              body: z.unknown().optional(),
            })
          )
          .min(1)
          .max(25)
          .describe('Subrequests, max 25.'),
        allOrNone: z
          .boolean()
          .optional()
          .describe('Roll back all subrequests if any fails. Default false.'),
      },
    },
    async ({ compositeRequest, allOrNone }) => {
      if (!cfg.allowDestructive && compositeRequest.some((r) => r.method === 'DELETE')) {
        return fail(
          'Refusing to run a composite request containing DELETE. Set ' +
            'MC_NEXT_ALLOW_DESTRUCTIVE=true to enable destructive composite calls.'
        );
      }
      try {
        const res = await client.rest('POST', '/composite', {
          body: { allOrNone: allOrNone ?? false, compositeRequest },
        });
        if (!res.ok) return respond(res);
        const data = res.data as { compositeResponse?: Array<Record<string, unknown>> } | null;
        const responses = data?.compositeResponse ?? [];
        const failed = responses.filter((r) => {
          const code = r.httpStatusCode as number | undefined;
          return code != null && code >= 400;
        });
        return ok({
          total: responses.length,
          succeeded: responses.length - failed.length,
          failed: failed.length,
          compositeResponse: responses,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
