/**
 * metadata.ts — custom object and custom field CRUD via the Tooling API.
 *
 * Ported from Salesforce Inspector Reloaded's Field Creator, which creates
 * custom fields with:
 *
 *   POST /tooling/sobjects/CustomField
 *   { FullName: "<Object>.<Field>__c", Metadata: { label, type, ... } }
 *
 * and grants field-level security with:
 *
 *   POST /sobjects/FieldPermissions/
 *   { ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit }
 *
 * Custom object creation uses the standard Tooling API CustomObject endpoint.
 *
 * All of these change org schema, so they are gated behind
 * MC_NEXT_ALLOW_METADATA_CHANGES (default false).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McNextConfig } from './config.js';
import type { TokenManager } from './auth.js';
import { SfRestClient, formatRest, type RestResult } from './sfrest.js';

type ToolResponse = CallToolResult;

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

/** Field types supported by the Tooling API CustomField metadata. */
const FIELD_TYPES = [
  'Text',
  'TextArea',
  'LongTextArea',
  'Html',
  'Number',
  'Currency',
  'Percent',
  'Date',
  'DateTime',
  'Checkbox',
  'Email',
  'Phone',
  'Url',
  'Picklist',
  'MultiselectPicklist',
  'Location',
] as const;

/** Types that require a `length` property. */
const LENGTH_TYPES = new Set(['Text', 'LongTextArea', 'Html']);
/** Types that require precision/scale. */
const NUMERIC_TYPES = new Set(['Number', 'Currency', 'Percent']);
/** Types that require a valueSet. */
const PICKLIST_TYPES = new Set(['Picklist', 'MultiselectPicklist']);

/** Strip a trailing "__c" so we can build FullName consistently. */
function baseName(name: string): string {
  return name.replace(/__c$/i, '');
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerMetadataTools(
  server: McpServer,
  cfg: McNextConfig,
  tokens: TokenManager,
  client: SfRestClient
): void {
  /** Guard for every schema-changing tool. */
  function metadataGuard(action: string): ToolResponse | null {
    if (!cfg.allowMetadataChanges) {
      return fail(
        `Refusing to ${action}. Schema changes are gated behind ` +
          'MC_NEXT_ALLOW_METADATA_CHANGES=true (default false).'
      );
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. sf_create_custom_object                                             */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_create_custom_object',
    {
      title: 'Create a custom object',
      description:
        'Create a custom object via the Tooling API (POST /tooling/sobjects/CustomObject). ' +
        'The API name is derived from `label` (or `name`) with a "__c" suffix. A Name field is ' +
        'created automatically unless you pass `nameFieldType: "AutoNumber"`. ' +
        'Gated behind MC_NEXT_ALLOW_METADATA_CHANGES=true.',
      inputSchema: {
        label: z.string().describe('Singular label, e.g. "Invoice".'),
        pluralLabel: z
          .string()
          .optional()
          .describe('Plural label, e.g. "Invoices". Defaults to label + "s".'),
        name: z
          .string()
          .optional()
          .describe(
            'API name without the __c suffix, e.g. "Invoice". Defaults to a slug of the label.'
          ),
        description: z.string().optional(),
        nameFieldLabel: z.string().optional().describe('Label for the auto-created Name field.'),
        nameFieldType: z
          .enum(['Text', 'AutoNumber'])
          .optional()
          .describe('Type of the auto-created Name field. Default "Text".'),
        nameFieldFormat: z
          .string()
          .optional()
          .describe('Display format when nameFieldType is "AutoNumber", e.g. "INV-{0000}".'),
        deploymentStatus: z
          .enum(['Deployed', 'InDevelopment'])
          .optional()
          .describe('Deployment status. Default "Deployed".'),
        sharingModel: z
          .enum(['ReadWrite', 'Read', 'Private', 'ControlledByParent'])
          .optional()
          .describe('Org-wide default sharing. Default "ReadWrite".'),
      },
    },
    async ({
      label,
      pluralLabel,
      name,
      description,
      nameFieldLabel,
      nameFieldType,
      nameFieldFormat,
      deploymentStatus,
      sharingModel,
    }) => {
      const guard = metadataGuard('create a custom object');
      if (guard) return guard;

      const apiName = baseName(name ?? label.replace(/[^A-Za-z0-9]+/g, '_'));
      const fullName = `${apiName}__c`;

      const metadata: Record<string, unknown> = {
        label,
        pluralLabel: pluralLabel ?? `${label}s`,
        deploymentStatus: deploymentStatus ?? 'Deployed',
        sharingModel: sharingModel ?? 'ReadWrite',
        nameField: {
          label: nameFieldLabel ?? `${label} Name`,
          type: nameFieldType ?? 'Text',
          ...(nameFieldType === 'AutoNumber' && nameFieldFormat
            ? { displayFormat: nameFieldFormat }
            : {}),
        },
      };
      if (description) metadata.description = description;

      try {
        const res = await client.rest('POST', '/tooling/sobjects/CustomObject', {
          body: { FullName: fullName, Metadata: metadata },
        });
        if (!res.ok) return respond(res);
        const data = res.data as { id?: string; success?: boolean; errors?: unknown } | null;
        return ok({
          created: true,
          fullName,
          id: data?.id ?? null,
          success: data?.success ?? null,
          errors: data?.errors ?? null,
          note:
            'Custom object creation is asynchronous. If the object is not immediately visible, ' +
            're-check with sf_list_objects in a few seconds.',
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. sf_create_custom_field                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_create_custom_field',
    {
      title: 'Create a custom field',
      description:
        'Create a custom field on an object via the Tooling API ' +
        "(POST /tooling/sobjects/CustomField), mirroring Inspector's Field Creator. " +
        'Optionally grants field-level security to profiles/permission sets. ' +
        'Gated behind MC_NEXT_ALLOW_METADATA_CHANGES=true.',
      inputSchema: {
        sobject: z.string().describe('Object API name, e.g. "Account" or "Invoice__c".'),
        name: z.string().describe('Field API name without the __c suffix, e.g. "Due_Date".'),
        label: z.string().describe('Field label, e.g. "Due Date".'),
        type: z.enum(FIELD_TYPES).describe('Field type.'),
        description: z.string().optional(),
        inlineHelpText: z.string().optional(),
        required: z.boolean().optional().describe('Mark the field required. Default false.'),
        unique: z.boolean().optional().describe('Mark the field unique. Default false.'),
        externalId: z
          .boolean()
          .optional()
          .describe('Mark the field as an external id. Default false.'),
        length: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Length for Text/LongTextArea/Html.'),
        precision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Total digits for numeric types.'),
        scale: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Decimal places for numeric types.'),
        visibleLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Visible lines for long text areas.'),
        defaultValue: z.unknown().optional().describe('Default value (e.g. true for a Checkbox).'),
        picklistValues: z
          .array(z.string())
          .optional()
          .describe('Picklist values, required for Picklist/MultiselectPicklist.'),
        sorted: z
          .boolean()
          .optional()
          .describe('Sort picklist values alphabetically. Default false.'),
        firstValueDefault: z
          .boolean()
          .optional()
          .describe('Make the first picklist value the default. Default false.'),
        grantTo: z
          .array(
            z.object({
              parentId: z
                .string()
                .describe('Profile or Permission Set Id (or a name resolvable by the caller).'),
              read: z.boolean().optional().describe('Grant read. Default true.'),
              edit: z.boolean().optional().describe('Grant edit. Default false.'),
            })
          )
          .optional()
          .describe('Field-level security grants, applied after the field is created.'),
      },
    },
    async (args) => {
      const guard = metadataGuard('create a custom field');
      if (guard) return guard;

      const {
        sobject,
        name,
        label,
        type,
        description,
        inlineHelpText,
        required,
        unique,
        externalId,
        length,
        precision,
        scale,
        visibleLines,
        defaultValue,
        picklistValues,
        sorted,
        firstValueDefault,
        grantTo,
      } = args;

      // --- validate type-specific requirements -----------------------------
      if (LENGTH_TYPES.has(type) && length === undefined) {
        return fail(`Field type "${type}" requires a \`length\` (e.g. 255 for Text).`);
      }
      if (NUMERIC_TYPES.has(type) && (precision === undefined || scale === undefined)) {
        return fail(`Field type "${type}" requires both \`precision\` and \`scale\`.`);
      }
      if (PICKLIST_TYPES.has(type) && (!picklistValues || picklistValues.length === 0)) {
        return fail(`Field type "${type}" requires a non-empty \`picklistValues\` array.`);
      }
      if (scale !== undefined && precision !== undefined && scale > precision) {
        return fail(`\`scale\` (${scale}) cannot exceed \`precision\` (${precision}).`);
      }

      const fieldApiName = `${baseName(name)}__c`;
      const fullName = `${sobject}.${fieldApiName}`;

      const metadata: Record<string, unknown> = {
        label,
        type,
        required: required ?? false,
        trackFeedHistory: false,
        trackHistory: false,
        trackTrending: false,
      };
      if (description) metadata.description = description;
      if (inlineHelpText) metadata.inlineHelpText = inlineHelpText;
      if (unique !== undefined) metadata.unique = unique;
      if (externalId !== undefined) metadata.externalId = externalId;
      if (defaultValue !== undefined) metadata.defaultValue = defaultValue;

      if (LENGTH_TYPES.has(type)) metadata.length = length;
      if (NUMERIC_TYPES.has(type)) {
        metadata.precision = precision;
        metadata.scale = scale;
      }
      if (visibleLines !== undefined) metadata.visibleLines = visibleLines;
      if (PICKLIST_TYPES.has(type)) {
        metadata.valueSet = {
          valueSetDefinition: {
            sorted: sorted ?? false,
            value: picklistValues!.map((value, index) => ({
              fullName: value,
              default: (firstValueDefault ?? false) && index === 0,
            })),
          },
        };
      }

      try {
        const res = await client.rest('POST', '/tooling/sobjects/CustomField', {
          body: { FullName: fullName, Metadata: metadata },
        });
        if (!res.ok) return respond(res);

        const data = res.data as { id?: string; success?: boolean; errors?: unknown } | null;
        const fieldId = data?.id ?? null;

        // --- field-level security ------------------------------------------
        const flsResults: unknown[] = [];
        if (grantTo?.length && fieldId) {
          for (const grant of grantTo) {
            const flsRes = await client.rest('POST', '/sobjects/FieldPermissions/', {
              body: {
                ParentId: grant.parentId,
                SobjectType: sobject,
                Field: fullName,
                PermissionsRead: grant.read ?? true,
                PermissionsEdit: grant.edit ?? false,
              },
            });
            flsResults.push({
              parentId: grant.parentId,
              ok: flsRes.ok,
              status: flsRes.status,
              ...(flsRes.ok ? {} : { error: flsRes.data ?? flsRes.text }),
            });
          }
        }

        return ok({
          created: true,
          fullName,
          fieldId,
          success: data?.success ?? null,
          errors: data?.errors ?? null,
          ...(flsResults.length ? { fieldLevelSecurity: flsResults } : {}),
          note:
            'Field creation is asynchronous. If the field is not immediately visible, re-check ' +
            'with sf_describe_object in a few seconds.',
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 3. sf_delete_custom_field                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_delete_custom_field',
    {
      title: 'Delete a custom field',
      description:
        'Delete a custom field via the Tooling API (DELETE /tooling/sobjects/CustomField/{id}). ' +
        "Requires the field's Tooling API Id — find it with sf_list_custom_fields. " +
        'Gated behind MC_NEXT_ALLOW_METADATA_CHANGES=true.',
      inputSchema: {
        fieldId: z
          .string()
          .describe('The Tooling API Id of the CustomField record (starts with 00N).'),
      },
    },
    async ({ fieldId }) => {
      const guard = metadataGuard('delete a custom field');
      if (guard) return guard;
      try {
        const res = await client.rest(
          'DELETE',
          `/tooling/sobjects/CustomField/${encodeURIComponent(fieldId)}`
        );
        if (!res.ok) return respond(res);
        return ok({ deleted: true, fieldId, status: res.status });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 4. sf_delete_custom_object                                             */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_delete_custom_object',
    {
      title: 'Delete a custom object',
      description:
        'Delete a custom object via the Tooling API (DELETE /tooling/sobjects/CustomObject/{id}). ' +
        "Requires the object's Tooling API Id — find it with sf_list_custom_objects. " +
        'This removes the object and its data. Gated behind MC_NEXT_ALLOW_METADATA_CHANGES=true.',
      inputSchema: {
        objectId: z
          .string()
          .describe('The Tooling API Id of the CustomObject record (starts with 01I).'),
      },
    },
    async ({ objectId }) => {
      const guard = metadataGuard('delete a custom object');
      if (guard) return guard;
      try {
        const res = await client.rest(
          'DELETE',
          `/tooling/sobjects/CustomObject/${encodeURIComponent(objectId)}`
        );
        if (!res.ok) return respond(res);
        return ok({ deleted: true, objectId, status: res.status });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 5. sf_list_custom_objects                                              */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_list_custom_objects',
    {
      title: 'List custom objects',
      description:
        'List custom objects in the org with their Tooling API Ids (via a Tooling API SOQL query ' +
        'on CustomObject). Use the returned Id with sf_delete_custom_object.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Filter by DeveloperName (case-insensitive substring).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max results. Default 200.'),
      },
    },
    async ({ search, limit }) => {
      const soql =
        'SELECT Id, DeveloperName, NamespacePrefix, Label FROM CustomObject ' +
        'ORDER BY DeveloperName';
      try {
        const res = await client.rest('GET', `/tooling/query/?q=${encodeURIComponent(soql)}`);
        if (!res.ok || !res.data) return respond(res);
        const records = (res.data as { records?: Array<Record<string, unknown>> }).records ?? [];
        const needle = search?.toLowerCase();
        const filtered = needle
          ? records.filter((r) =>
              String(r.DeveloperName ?? '')
                .toLowerCase()
                .includes(needle)
            )
          : records;
        const capped = filtered.slice(0, limit ?? 200);
        return ok({
          total: filtered.length,
          returned: capped.length,
          objects: capped.map((r) => ({
            id: r.Id,
            developerName: r.DeveloperName,
            label: r.Label ?? null,
            namespace: r.NamespacePrefix ?? null,
          })),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 6. sf_list_custom_fields                                               */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'sf_list_custom_fields',
    {
      title: 'List custom fields',
      description:
        'List custom fields with their Tooling API Ids (via a Tooling API SOQL query on ' +
        'CustomField). Use the returned Id with sf_delete_custom_field.',
      inputSchema: {
        sobject: z
          .string()
          .optional()
          .describe('Only fields on this object, e.g. "Account". Omit for all objects.'),
        search: z
          .string()
          .optional()
          .describe('Filter by DeveloperName (case-insensitive substring).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe('Max results. Default 200.'),
      },
    },
    async ({ sobject, search, limit }) => {
      const where = sobject ? ` WHERE TableEnumOrId = '${sobject.replace(/'/g, "\\'")}'` : '';
      const soql =
        `SELECT Id, DeveloperName, TableEnumOrId, DataType FROM CustomField${where} ` +
        'ORDER BY TableEnumOrId, DeveloperName';
      try {
        const res = await client.rest('GET', `/tooling/query/?q=${encodeURIComponent(soql)}`);
        if (!res.ok || !res.data) return respond(res);
        const records = (res.data as { records?: Array<Record<string, unknown>> }).records ?? [];
        const needle = search?.toLowerCase();
        const filtered = needle
          ? records.filter((r) =>
              String(r.DeveloperName ?? '')
                .toLowerCase()
                .includes(needle)
            )
          : records;
        const capped = filtered.slice(0, limit ?? 200);
        return ok({
          total: filtered.length,
          returned: capped.length,
          fields: capped.map((r) => ({
            id: r.Id,
            developerName: r.DeveloperName,
            object: r.TableEnumOrId,
            dataType: r.DataType ?? null,
          })),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
