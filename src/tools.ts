/**
 * tools.ts — the catalog-driven MCP tool surface.
 *
 * Rather than exposing 445 individual tools (which would bloat the model's
 * context and hurt tool-selection accuracy), we expose a small set of generic,
 * catalog-driven tools. The model discovers endpoints with
 * `mcnext_list_endpoints` / `mcnext_describe_endpoint`, then invokes them
 * through the verb-specific tools below.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McNextConfig } from './config.js';
import type { McNextClient, CallResult } from './client.js';
import {
  loadCatalog,
  getEndpoint,
  listEndpoints,
  suggestEndpoints,
  summarize,
  groupsFor,
  type Endpoint,
} from './catalog.js';

/* -------------------------------------------------------------------------- */
/* Result formatting                                                          */
/* -------------------------------------------------------------------------- */

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

/** Turn an HTTP result into a compact, model-friendly payload. */
function formatResult(endpoint: Endpoint, res: CallResult): ToolResponse {
  const payload: Record<string, unknown> = {
    endpoint: endpoint.id,
    family: endpoint.family,
    request: `${res.method} ${res.url}`,
    status: res.status,
    ok: res.ok,
    durationMs: res.durationMs,
  };

  if (res.data !== null) {
    payload.data = res.data;
  } else if (res.text) {
    payload.body = res.text;
  }
  if (res.truncated) {
    payload.note = 'Response body was truncated for display.';
  }

  if (!res.ok) {
    payload.hint = hintForStatus(res.status);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }

  return ok(payload);
}

function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request — check required query params and body field names/types. Use mcnext_describe_endpoint for the expected schema.';
    case 401:
      return 'Unauthorized — verify SF_CLIENT_ID / SF_CLIENT_SECRET and that the Connected App permits the client-credentials flow.';
    case 403:
      return 'Forbidden — the Connected App or user may lack the required scope for this API family (e.g. sfdc_cms_api, cdp_query_api).';
    case 404:
      return 'Not found — verify the record id/key and that the resource exists in this org/tenant.';
    case 405:
      return 'Method not allowed for this path.';
    case 429:
      return 'Rate limited — Salesforce enforces API request limits. Retry later or reduce call volume.';
    default:
      return status >= 500
        ? 'Server error from Salesforce — safe to retry.'
        : 'Unexpected response.';
  }
}

/* -------------------------------------------------------------------------- */
/* Shared schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Some collections embed enormous comma-separated defaults. Echoing those on
 * every describe call wastes context, so we replace long defaults with a summary.
 */
function compactParam(p: {
  name: string;
  required: boolean;
  type: string;
  description: string;
  default?: string;
  disabledInPostman?: boolean;
}) {
  const out: Record<string, unknown> = {
    name: p.name,
    required: p.required,
    type: p.type,
    description: p.description,
  };
  const def = p.default ?? '';
  if (def && !/^\{\{.*\}\}$/.test(def)) {
    if (def.length > 80) {
      const count = def.split(',').length;
      out.defaultSummary = `${count} values, e.g. ${def.split(',').slice(0, 5).join(',')},…`;
    } else {
      out.default = def;
    }
  }
  return out;
}

const endpointId = z
  .string()
  .describe(
    'Endpoint id from the catalog, e.g. "content.create-an-email-with-html", ' +
      '"activations.query-activations". Use mcnext_list_endpoints to discover ids.'
  );

const pathParams = z
  .record(z.union([z.string(), z.number()]))
  .optional()
  .describe('Path parameter values, e.g. { "contentKey": "my-email" }.');

const queryParams = z
  .record(z.unknown())
  .optional()
  .describe('Query string parameters, e.g. { "pageSize": 50, "orderBy": "name" }.');

const extraHeaders = z
  .record(z.string())
  .optional()
  .describe('Additional request headers.');

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerTools(
  server: McpServer,
  cfg: McNextConfig,
  client: McNextClient
): void {
  const catalog = loadCatalog();
  const familyKeys = catalog.api.families.map((f) => f.key);

  /* ---------------------------------------------------------------------- */
  /* 1. mcnext_list_endpoints                                               */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_list_endpoints',
    {
      title: 'List Marketing Cloud Next / Data 360 API endpoints',
      description:
        `Browse the ${catalog.stats.endpointCount} endpoints across ${catalog.stats.familyCount} API ` +
        `families (${catalog.api.families.map((f) => `${f.key}: ${f.endpointCount}`).join(', ')}) ` +
        `and ${catalog.stats.groupCount} resource groups. Use this first to discover the endpoint id ` +
        'you need. Filter by family, group, kind, method, or a free-text search.',
      inputSchema: {
        family: z
          .enum(familyKeys as [string, ...string[]])
          .optional()
          .describe(
            'API family. "mc-next" = Marketing Cloud Next content/CMS, ' +
              '"data360" = Data 360 core, "data360-connect" = Data 360 Connect.'
          ),
        group: z
          .string()
          .optional()
          .describe('Resource group, e.g. "Content", "Activations", "Segments", "Query API V2".'),
        kind: z
          .enum(['query', 'read', 'create', 'update', 'delete', 'action', 'export', 'import', 'other'])
          .optional()
          .describe('Endpoint kind. "query" = list, "read" = get one, "action" = non-CRUD operation.'),
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
        search: z.string().optional().describe('Free-text search over id, name, path and description.'),
        includeDestructive: z
          .boolean()
          .optional()
          .describe('Include destructive endpoints (DELETE, delete/remove/cancel actions). Default true.'),
        limit: z.number().int().positive().max(500).optional().describe('Max results (default 50).'),
      },
    },
    async ({ family, group, kind, method, search, includeDestructive, limit }) => {
      const results = listEndpoints({
        family,
        group,
        kind,
        method,
        search,
        includeDestructive: includeDestructive ?? true,
        limit: limit ?? 50,
      });
      const filtered = Boolean(family || group || kind || method || search);
      return ok({
        total: results.length,
        // Only echo the group list when browsing without a filter, to avoid
        // repeating 44 group names on every call.
        ...(filtered ? {} : { groups: catalog.groups }),
        ...(family && !group ? { groupsInFamily: groupsFor(family) } : {}),
        endpoints: results.map(summarize),
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. mcnext_describe_endpoint                                            */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_describe_endpoint',
    {
      title: 'Describe a Marketing Cloud Next / Data 360 endpoint',
      description:
        'Get the full contract for one endpoint: HTTP method, base URL family, path, path params, ' +
        'query params, request body JSON schema, and a sample body. Call this before invoking an endpoint.',
      inputSchema: { endpointId },
    },
    async ({ endpointId: id }) => {
      const endpoint = getEndpoint(id);
      if (!endpoint) {
        return fail(
          `Unknown endpoint id "${id}". Did you mean: ${suggestEndpoints(id).join(', ') || 'none'}? ` +
            'Use mcnext_list_endpoints to browse.'
        );
      }
      return ok({
        id: endpoint.id,
        name: endpoint.name,
        family: endpoint.family,
        familyLabel: endpoint.familyLabel,
        group: endpoint.group,
        subGroup: endpoint.subGroup,
        kind: endpoint.kind,
        method: endpoint.method,
        base: endpoint.base,
        baseUrl: client.baseUrlFor(endpoint),
        path: endpoint.path,
        destructive: endpoint.destructive,
        description: endpoint.description,
        pathParams: endpoint.pathParams,
        queryParams: endpoint.queryParams.map(compactParam),
        bodyMode: endpoint.bodyMode,
        bodyContentType: endpoint.bodyContentType,
        bodySchema: endpoint.bodySchema,
        bodySample: endpoint.bodySample,
        formFields: endpoint.formFields,
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* Generic invoker shared by the verb tools                               */
  /* ---------------------------------------------------------------------- */
  async function invoke(
    id: string,
    expectedKinds: Endpoint['kind'][],
    opts: {
      pathParams?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      formData?: Record<string, string>;
      headers?: Record<string, string>;
    }
  ): Promise<ToolResponse> {
    const endpoint = getEndpoint(id);
    if (!endpoint) {
      return fail(
        `Unknown endpoint id "${id}". Did you mean: ${suggestEndpoints(id).join(', ') || 'none'}?`
      );
    }

    if (!expectedKinds.includes(endpoint.kind)) {
      return fail(
        `Endpoint "${id}" is of kind "${endpoint.kind}" (${endpoint.method} ${endpoint.path}), ` +
          `which is not valid for this tool. Expected one of: ${expectedKinds.join(', ')}. ` +
          'Use mcnext_describe_endpoint to inspect it.'
      );
    }

    if (endpoint.destructive && !cfg.allowDestructive) {
      return fail(
        `Refusing to call destructive endpoint "${id}" (${endpoint.method} ${endpoint.path}). ` +
          'Set MC_NEXT_ALLOW_DESTRUCTIVE=true to enable DELETE and destructive actions.'
      );
    }

    try {
      const res = await client.call(endpoint, opts);
      return formatResult(endpoint, res);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. mcnext_query — GET a collection                                     */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_query',
    {
      title: 'Query Marketing Cloud Next / Data 360 records',
      description:
        'List/filter records from a collection endpoint (GET, kind "query"). Supports pagination ' +
        'and filters such as pageSize, offset, orderBy, and family-specific filters.',
      inputSchema: { endpointId, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, query, headers }) =>
      invoke(id, ['query'], { query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 4. mcnext_read — GET a single record                                   */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_read',
    {
      title: 'Read a Marketing Cloud Next / Data 360 record',
      description: 'Fetch a single record by id or key (GET, kind "read"). Requires the path parameter.',
      inputSchema: { endpointId, pathParams, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, pathParams: pp, query, headers }) =>
      invoke(id, ['read'], { pathParams: pp, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 5. mcnext_create — POST a new record                                   */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_create',
    {
      title: 'Create a Marketing Cloud Next / Data 360 record',
      description:
        'Create a record (POST, kind "create"). Pass the JSON payload in `body`. ' +
        'Use mcnext_describe_endpoint to see the expected body schema and sample.',
      inputSchema: {
        endpointId,
        body: z.unknown().describe('JSON request body.'),
        query: queryParams,
        headers: extraHeaders,
      },
    },
    async ({ endpointId: id, body, query, headers }) =>
      invoke(id, ['create'], { body, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 6. mcnext_update — PATCH/PUT an existing record                        */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_update',
    {
      title: 'Update a Marketing Cloud Next / Data 360 record',
      description:
        'Update a record (PATCH or PUT, kind "update"). Requires the path parameter and a JSON ' +
        '`body`. For PATCH, include only the fields to change.',
      inputSchema: {
        endpointId,
        pathParams,
        body: z.unknown().describe('JSON request body.'),
        query: queryParams,
        headers: extraHeaders,
      },
    },
    async ({ endpointId: id, pathParams: pp, body, query, headers }) =>
      invoke(id, ['update'], { pathParams: pp, body, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 7. mcnext_delete — DELETE a record                                     */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_delete',
    {
      title: 'Delete a Marketing Cloud Next / Data 360 record',
      description:
        'Delete a record (DELETE, kind "delete"). Requires the path parameter. ' +
        'This is destructive and is blocked unless MC_NEXT_ALLOW_DESTRUCTIVE=true.',
      inputSchema: { endpointId, pathParams, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, pathParams: pp, query, headers }) =>
      invoke(id, ['delete'], { pathParams: pp, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 8. mcnext_action — non-CRUD operations                                 */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'mcnext_action',
    {
      title: 'Run a Marketing Cloud Next / Data 360 action',
      description:
        'Invoke a non-CRUD operation (kind "action"): publish, unpublish, clone, activate, ' +
        'deactivate, run, execute, refresh, validate, search, query, resolve, merge, and similar. ' +
        'Some actions are destructive (delete/remove/cancel/deactivate) and are blocked unless ' +
        'MC_NEXT_ALLOW_DESTRUCTIVE=true. For file-upload endpoints, pass `formData` with an ' +
        'absolute file path for the "file" field.',
      inputSchema: {
        endpointId,
        pathParams,
        body: z.unknown().optional().describe('JSON request body, when the endpoint expects one.'),
        formData: z
          .record(z.string())
          .optional()
          .describe('Form-data fields for multipart endpoints; file fields take an absolute path.'),
        query: queryParams,
        headers: extraHeaders,
      },
    },
    async ({ endpointId: id, pathParams: pp, body, formData, query, headers }) =>
      invoke(id, ['action', 'export', 'import'], {
        pathParams: pp,
        body,
        formData,
        query,
        headers,
      })
  );
}
