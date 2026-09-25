#!/usr/bin/env node
/**
 * generate-catalog.mjs
 * ---------------------------------------------------------------------------
 * Converts the official Salesforce Postman collections for
 *   - Marketing Cloud Next APIs
 *   - Data 360 APIs
 *   - Data 360 Connect APIs
 * into a single compact, machine-readable endpoint catalog consumed by the
 * MCP server at runtime.
 *
 * Usage:
 *   node scripts/generate-catalog.mjs [inputDir] [outputPath]
 *
 * Defaults:
 *   inputDir = ../Marketing Cloud Next MCP Prep
 *   output   = ../catalog/endpoints.json
 * ---------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const INPUT_DIR = process.argv[2] ?? resolve(PROJECT_ROOT, '..', 'Marketing Cloud Next MCP Prep');
const OUTPUT = process.argv[3] ?? resolve(PROJECT_ROOT, 'catalog', 'endpoints.json');

/* -------------------------------------------------------------------------- */
/* Collection definitions                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Each source collection is mapped to a logical API family. `baseKey` names the
 * base URL the endpoints of that family are resolved against at runtime; the
 * server substitutes the matching environment variable (see src/config.ts).
 */
const COLLECTIONS = [
  {
    file: 'Salesforce Marketing Cloud Next APIs.postman_collection.json',
    family: 'mc-next',
    label: 'Marketing Cloud Next',
    baseKey: 'mcNext',
    // Postman host template -> base key. Longest match wins.
    hostMap: {
      '{{apiBaseUrl}}{{apiBasePath}}': 'mcNext',
      '{{apiBaseUrl}}': 'mcNext',
    },
    defaultBase: 'https://YOUR_INSTANCE.my.salesforce.com/services/data/v66.0',
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      scope: 'sfdc_cms_api',
      note:
        'The collection already uses the client-credentials grant, which is directly ' +
        'usable by a server. Requires a Connected App with the CMS/Content scope.',
    },
  },
  {
    file: 'Salesforce Data 360 APIs.postman_collection.json',
    family: 'data360',
    label: 'Data 360',
    baseKey: 'data360',
    hostMap: {
      '{{_dcTenantUrl}}': 'data360',
      '{{loginUrl}}': 'login',
    },
    defaultBase: 'https://YOUR_TENANT.c360a.salesforce.com',
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      scope: 'api cdp_query_api cdp_profile_api cdp_ingest_api',
      note:
        'The collection uses the OAuth 2.0 implicit grant (browser-only). This MCP ' +
        'server uses the client-credentials grant instead, which requires a Connected ' +
        'App with the Data 360 scopes enabled.',
    },
  },
  {
    file: 'Salesforce Data 360 Connect APIs.postman_collection.json',
    family: 'data360-connect',
    label: 'Data 360 Connect',
    baseKey: 'data360Connect',
    hostMap: {
      '{{baseUrl}}': 'data360Connect',
      '{{dne_cdpInstanceUrl}}': 'data360Connect',
      '{{loginUrl}}': 'login',
    },
    defaultBase: 'https://YOUR_TENANT.c360a.salesforce.com/services/data/v66.0',
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      scope: 'api cdp_query_api cdp_profile_api',
      note:
        'The collection uses the OAuth 2.0 implicit grant (browser-only). This MCP ' +
        'server uses the client-credentials grant instead.',
    },
  },
];

/** Named base URLs the runtime resolves from environment variables. */
const BASES = {
  mcNext: {
    envVar: 'MC_NEXT_API_BASE_URL',
    description:
      'Marketing Cloud Next API base, including the API path prefix. ' +
      'Example: https://my-org.my.salesforce.com/services/data/v66.0',
    default: 'https://YOUR_INSTANCE.my.salesforce.com/services/data/v66.0',
  },
  data360: {
    envVar: 'DATA360_TENANT_URL',
    description:
      'Data 360 tenant URL (the c360a host). Example: https://my-tenant.c360a.salesforce.com',
    default: 'https://YOUR_TENANT.c360a.salesforce.com',
  },
  data360Connect: {
    envVar: 'DATA360_CONNECT_BASE_URL',
    description:
      'Data 360 Connect API base, including /services/data/vXX. ' +
      'Example: https://my-tenant.c360a.salesforce.com/services/data/v66.0',
    default: 'https://YOUR_TENANT.c360a.salesforce.com/services/data/v66.0',
  },
  login: {
    envVar: 'SF_LOGIN_URL',
    description: 'Salesforce login host used for OAuth and identity endpoints.',
    default: 'https://login.salesforce.com',
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Recursively walk Postman items, yielding [pathSegments, requestItem]. */
function* walkItems(items, path = []) {
  for (const item of items ?? []) {
    if (Array.isArray(item.item)) {
      yield* walkItems(item.item, [...path, item.name]);
    } else if (item.request) {
      yield { path: [...path, item.name], item };
    }
  }
}

/** "Custom Field" -> "custom-field" */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "FilterByCreatedAt" -> "filter-by-created-at" */
function camelToSlug(text) {
  return slug(String(text).replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
}

/**
 * Infer a JSON Schema fragment from a sample value.
 *
 * NOTE: we deliberately do NOT emit a `required` array. The Postman collections
 * only provide *sample* bodies, so every property is present in the sample --
 * marking them all required would be wrong (especially for PATCH endpoints,
 * which are partial updates by definition). The schema is therefore advisory:
 * it describes shape and types, not obligations.
 */
function inferSchema(value, depth = 0) {
  if (depth > 8) return { type: 'object' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        type: 'array',
        description: 'Sample array was empty; item shape not inferable from the collection.',
      };
    }
    return { type: 'array', items: inferSchema(value[0], depth + 1) };
  }
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'string': {
      const schema = { type: 'string' };
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) schema.format = 'date-time';
      else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) schema.format = 'date';
      else if (/^https?:\/\//.test(value)) schema.format = 'uri';
      else if (/^\{\{.+\}\}$/.test(value)) schema.description = 'Postman variable placeholder';
      return schema;
    }
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(value)) {
        properties[k] = inferSchema(v, depth + 1);
      }
      return { type: 'object', properties };
    }
    default:
      return {};
  }
}

/** Parse a Postman raw body into JSON when possible. */
function parseRawBody(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Determine whether a query param is required from its description. */
function isRequiredParam(param) {
  const desc = String(param.description ?? '');
  return /\(required\)/i.test(desc) || /^\s*required\b/i.test(desc);
}

/** Classify an endpoint into a coarse "kind". */
function classify(method, path) {
  const p = path.toLowerCase();
  if (method === 'DELETE') return 'delete';
  if (method === 'PATCH' || method === 'PUT') return 'update';
  if (method === 'POST') {
    if (/\/(publish|unpublish|clone|activate|deactivate|run|execute|start|stop|refresh|validate|preview|search|query|resolve|merge|upsert|deploy|retrieve|submit|cancel|schedule|trigger|send|test|generate|calculate|materialize|sync|import|export)\b/.test(p)) {
      return 'action';
    }
    if (p.includes('/exports')) return 'export';
    if (p.includes('/imports')) return 'import';
    return 'create';
  }
  if (method === 'GET') {
    return /:[a-z0-9_]+$/.test(p) ? 'read' : 'query';
  }
  return 'other';
}

/** Endpoints that mutate or destroy data in a risky way. */
function isDestructive(method, path, actionName) {
  if (method === 'DELETE') return true;
  if (method === 'POST') {
    return /\b(delete|remove|purge|drop|truncate|undelete|cancel|deactivate|revoke|unpublish|disable)\b/i.test(
      `${actionName} ${path}`
    );
  }
  return false;
}

/**
 * Resolve the Postman host template to a base key.
 * Falls back to the collection default when nothing matches.
 */
function resolveBaseKey(hostTemplate, hostMap, fallback) {
  if (!hostTemplate) return fallback;
  const normalized = String(hostTemplate).trim();
  if (hostMap[normalized]) return hostMap[normalized];
  // Longest-prefix match, so `{{apiBaseUrl}}{{apiBasePath}}` beats `{{apiBaseUrl}}`.
  const keys = Object.keys(hostMap).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (normalized.startsWith(k)) return hostMap[k];
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Build catalog                                                              */
/* -------------------------------------------------------------------------- */

const endpoints = [];
const usedIds = new Map();
const familyStats = {};

for (const def of COLLECTIONS) {
  const inputPath = resolve(INPUT_DIR, def.file);
  if (!existsSync(inputPath)) {
    console.warn(`⚠ skipping missing collection: ${inputPath}`);
    continue;
  }

  const collection = JSON.parse(readFileSync(inputPath, 'utf8'));
  const collectionVars = Object.fromEntries(
    (collection.variable ?? []).map((v) => [v.key, v.value ?? ''])
  );

  let count = 0;

  for (const { path, item } of walkItems(collection.item)) {
    const req = item.request;
    const method = String(req.method ?? 'GET').toUpperCase();

    // Postman nests as: ["<Group>", "<SubGroup>", "<Action>", ...]
    const group = path[0] ?? 'General';
    const subGroup = path.length > 2 ? path.slice(1, -1).join(' / ') : null;
    const actionName = path[path.length - 1] ?? 'Request';

    // --- URL ---------------------------------------------------------------
    const url = req.url ?? {};
    const pathSegments = Array.isArray(url.path) ? url.path : [];
    const apiPath = '/' + pathSegments.join('/');

    const hostTemplate = Array.isArray(url.host) ? url.host.join('') : url.host ?? '';
    const baseKey = resolveBaseKey(hostTemplate, def.hostMap, def.baseKey);

    // Path params: segments beginning with ":" plus declared url.variable entries.
    const declaredVars = new Map(
      (url.variable ?? []).map((v) => [v.key, v.description ?? ''])
    );
    const pathParams = [];
    for (const seg of pathSegments) {
      if (seg.startsWith(':')) {
        const name = seg.slice(1);
        pathParams.push({
          name,
          required: true,
          type: 'string',
          description: declaredVars.get(name) ?? `Path parameter "${name}"`,
        });
      }
    }

    // --- Query params ------------------------------------------------------
    const queryParams = (url.query ?? []).map((q) => {
      const rawDefault = q.value ?? '';
      // Postman variable placeholders ({{nextPageToken}}) are not real defaults.
      const isPlaceholder = /^\{\{.*\}\}$/.test(rawDefault);
      return {
        name: q.key,
        required: isRequiredParam(q),
        type: /^(true|false)$/i.test(String(rawDefault))
          ? 'boolean'
          : /^\d+$/.test(String(rawDefault))
            ? 'integer'
            : 'string',
        description: String(q.description ?? '').trim(),
        default: isPlaceholder ? '' : rawDefault,
        disabledInPostman: Boolean(q.disabled),
      };
    });

    // --- Body --------------------------------------------------------------
    const body = req.body ?? {};
    let bodyMode = body.mode ?? null;
    let bodySchema = null;
    let bodySample = null;
    let formFields = null;
    let bodyContentType = null;

    if (bodyMode === 'raw') {
      const raw = typeof body.raw === 'string' ? body.raw : '';
      if (!raw.trim()) {
        // Postman declares `mode: raw` with an empty string on many GET/DELETE
        // requests. That means "no body", not "empty JSON body".
        bodyMode = null;
      } else {
        const parsed = parseRawBody(raw);
        if (parsed !== null) {
          bodySample = parsed;
          bodySchema = inferSchema(parsed);
          bodyContentType = 'application/json';
        } else {
          // Non-JSON payload (e.g. the Ingestion API's CSV bulk upload).
          const looksCsv = /^[^\n]*,[^\n]*\n/.test(raw);
          bodyContentType = looksCsv ? 'text/csv' : 'text/plain';
          bodySchema = {
            type: 'string',
            description: looksCsv
              ? 'Raw CSV payload (not JSON). Pass the CSV text directly in `body`.'
              : 'Raw text payload (not JSON). Pass the text directly in `body`.',
          };
          bodySample = raw;
        }
      }
    } else if (bodyMode === 'formdata') {
      formFields = (body.formdata ?? []).map((f) => ({
        name: f.key,
        type: f.type === 'file' ? 'file' : 'string',
        required: true,
        description: String(f.description ?? '').trim(),
      }));
      bodySchema = {
        type: 'object',
        properties: Object.fromEntries(
          formFields.map((f) => [
            f.name,
            f.type === 'file'
              ? { type: 'string', format: 'binary', description: 'Absolute file path' }
              : { type: 'string' },
          ])
        ),
        required: formFields.map((f) => f.name),
      };
      bodySample = Object.fromEntries(
        formFields.map((f) => [
          f.name,
          f.type === 'file' ? '/absolute/path/to/file.csv' : '<string value>',
        ])
      );
    }

    // --- Headers -----------------------------------------------------------
    const headers = (req.header ?? [])
      .filter((h) => !h.disabled)
      .map((h) => ({ name: h.key, value: h.value ?? '' }));

    // --- Identity ----------------------------------------------------------
    const kind = classify(method, apiPath);
    let id = `${slug(group)}.${camelToSlug(actionName)}`;
    if (usedIds.has(id)) {
      const n = usedIds.get(id) + 1;
      usedIds.set(id, n);
      id = `${id}-${n}`;
    } else {
      usedIds.set(id, 0);
    }

    const description =
      String(req.description ?? '').trim() ||
      `${method} ${apiPath} — ${group} / ${actionName}`;

    endpoints.push({
      id,
      name: subGroup ? `${group} / ${subGroup} / ${actionName}` : `${group} ${actionName}`,
      family: def.family,
      familyLabel: def.label,
      group,
      subGroup,
      action: actionName,
      kind,
      method,
      base: baseKey,
      path: apiPath,
      pathParams,
      queryParams,
      headers,
      bodyMode,
      bodyContentType,
      bodySchema,
      bodySample,
      formFields,
      destructive: isDestructive(method, apiPath, actionName),
      description,
    });

    count++;
  }

  familyStats[def.family] = {
    label: def.label,
    source: basename(inputPath),
    collectionName: collection.info?.name ?? 'Unknown',
    endpointCount: count,
  };
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                       */
/* -------------------------------------------------------------------------- */

const groups = [...new Set(endpoints.map((e) => e.group))].sort();
const families = [...new Set(endpoints.map((e) => e.family))];

const catalog = {
  $schema: './catalog.schema.json',
  generatedAt: new Date().toISOString(),
  api: {
    name: 'Salesforce Marketing Cloud Next + Data 360',
    families: families.map((f) => ({
      key: f,
      label: familyStats[f]?.label ?? f,
      endpointCount: familyStats[f]?.endpointCount ?? 0,
      source: familyStats[f]?.source ?? null,
      collectionName: familyStats[f]?.collectionName ?? null,
      auth: COLLECTIONS.find((c) => c.family === f)?.auth ?? null,
    })),
    bases: BASES,
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      tokenPath: '/services/oauth2/token',
      note:
        'All three source collections are unified behind a single OAuth 2.0 ' +
        'client-credentials token. The Data 360 collections originally used the ' +
        'implicit grant (browser-only), which a server cannot use.',
    },
  },
  stats: {
    endpointCount: endpoints.length,
    groupCount: groups.length,
    familyCount: families.length,
    byFamily: endpoints.reduce((acc, e) => {
      acc[e.family] = (acc[e.family] ?? 0) + 1;
      return acc;
    }, {}),
    byMethod: endpoints.reduce((acc, e) => {
      acc[e.method] = (acc[e.method] ?? 0) + 1;
      return acc;
    }, {}),
    byKind: endpoints.reduce((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {}),
  },
  groups,
  endpoints,
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`✔ Catalog written to ${OUTPUT}`);
console.log(`  endpoints : ${catalog.stats.endpointCount}`);
console.log(`  groups    : ${catalog.stats.groupCount}`);
console.log(`  families  : ${JSON.stringify(catalog.stats.byFamily)}`);
console.log(`  by method : ${JSON.stringify(catalog.stats.byMethod)}`);
console.log(`  by kind   : ${JSON.stringify(catalog.stats.byKind)}`);
