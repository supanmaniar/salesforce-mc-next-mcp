/**
 * catalog.ts — loads and queries the generated endpoint catalog.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type EndpointKind =
  'query' | 'read' | 'create' | 'update' | 'delete' | 'action' | 'export' | 'import' | 'other';

export type BaseKey = 'mcNext' | 'data360' | 'data360Connect' | 'login';

export interface ParamSpec {
  name: string;
  required: boolean;
  type: string;
  description: string;
  default?: string;
  disabledInPostman?: boolean;
}

export interface FormFieldSpec {
  name: string;
  type: 'string' | 'file';
  required: boolean;
  description: string;
}

export interface Endpoint {
  id: string;
  name: string;
  family: string;
  familyLabel: string;
  group: string;
  subGroup: string | null;
  action: string;
  kind: EndpointKind;
  method: string;
  base: BaseKey;
  path: string;
  pathParams: ParamSpec[];
  queryParams: ParamSpec[];
  headers: { name: string; value: string }[];
  bodyMode: 'raw' | 'formdata' | 'urlencoded' | null;
  bodyContentType: string | null;
  bodySchema: Record<string, unknown> | null;
  bodySample: unknown;
  formFields: FormFieldSpec[] | null;
  destructive: boolean;
  description: string;
}

export interface BaseSpec {
  envVar: string;
  description: string;
  default: string;
}

export interface FamilySpec {
  key: string;
  label: string;
  endpointCount: number;
  source: string | null;
  collectionName: string | null;
  auth: {
    type: string;
    grantType: string;
    scope: string;
    note: string;
  } | null;
}

export interface Catalog {
  generatedAt: string;
  api: {
    name: string;
    families: FamilySpec[];
    bases: Record<string, BaseSpec>;
    auth: {
      type: string;
      grantType: string;
      tokenPath: string;
      note: string;
    };
  };
  stats: {
    endpointCount: number;
    groupCount: number;
    familyCount: number;
    byFamily: Record<string, number>;
    byMethod: Record<string, number>;
    byKind: Record<string, number>;
  };
  groups: string[];
  endpoints: Endpoint[];
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const catalogPath = resolve(__dirname, '..', 'catalog', 'endpoints.json');
  cached = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
  return cached;
}

export function getEndpoint(id: string): Endpoint | undefined {
  return loadCatalog().endpoints.find((e) => e.id === id);
}

/** Case-insensitive, order-independent fuzzy match used for helpful errors. */
export function suggestEndpoints(id: string, limit = 5): string[] {
  const needle = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const scored = loadCatalog().endpoints.map((e) => {
    const hay = e.id.toLowerCase().replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (hay.includes(needle) || needle.includes(hay)) score += 10;
    // shared prefix length
    let i = 0;
    while (i < hay.length && i < needle.length && hay[i] === needle[i]) i++;
    score += i;
    return { id: e.id, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

export interface ListFilter {
  family?: string;
  group?: string;
  kind?: string;
  method?: string;
  search?: string;
  includeDestructive?: boolean;
  limit?: number;
}

export function listEndpoints(filter: ListFilter = {}): Endpoint[] {
  const { family, group, kind, method, search, includeDestructive = true, limit } = filter;
  const needle = search?.toLowerCase();

  let results = loadCatalog().endpoints.filter((e) => {
    if (family && e.family.toLowerCase() !== family.toLowerCase()) return false;
    if (group && e.group.toLowerCase() !== group.toLowerCase()) return false;
    if (kind && e.kind !== kind) return false;
    if (method && e.method !== method.toUpperCase()) return false;
    if (!includeDestructive && e.destructive) return false;
    if (needle) {
      const hay = `${e.id} ${e.name} ${e.path} ${e.description}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (limit && limit > 0) results = results.slice(0, limit);
  return results;
}

/** Compact projection used when listing endpoints to the model. */
export function summarize(e: Endpoint) {
  return {
    id: e.id,
    family: e.family,
    method: e.method,
    path: e.path,
    name: e.name,
    kind: e.kind,
    destructive: e.destructive,
  };
}

/** Groups available within a family (or across all families when omitted). */
export function groupsFor(family?: string): string[] {
  const catalog = loadCatalog();
  if (!family) return catalog.groups;
  return [
    ...new Set(catalog.endpoints.filter((e) => e.family === family).map((e) => e.group)),
  ].sort();
}
