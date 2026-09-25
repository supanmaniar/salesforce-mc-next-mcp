#!/usr/bin/env node
/** audit-catalog.mjs — fidelity checks on the generated catalog. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = JSON.parse(readFileSync(resolve(__dirname, '..', 'catalog', 'endpoints.json'), 'utf8'));

const issues = [];
const note = (sev, msg) => issues.push({ sev, msg });

// 0. sanity: a degenerate catalog must fail loudly. Without this, an empty or
// truncated catalog reports "0 issues found" and exits 0 — which reads as a
// clean bill of health for a broken artifact.
const EXPECTED_MIN_ENDPOINTS = 400;
const EXPECTED_MIN_GROUPS = 40;
const EXPECTED_DESTRUCTIVE = 63;

if (c.endpoints.length < EXPECTED_MIN_ENDPOINTS) {
  console.error(
    `✘ catalog has only ${c.endpoints.length} endpoints (expected at least ${EXPECTED_MIN_ENDPOINTS}).`
  );
  console.error('  The catalog looks truncated or empty. Regenerate it, or restore with');
  console.error('  `git checkout -- catalog/endpoints.json`.');
  process.exit(1);
}

if (c.groups.length < EXPECTED_MIN_GROUPS) {
  console.error(
    `✘ catalog has only ${c.groups.length} groups (expected at least ${EXPECTED_MIN_GROUPS}).`
  );
  process.exit(1);
}

// 1. base distribution
const bases = {};
for (const e of c.endpoints) bases[e.base] = (bases[e.base] ?? 0) + 1;
console.log('bases:', JSON.stringify(bases));

// 2. unresolved placeholders
const badPath = c.endpoints.filter((e) => /\{\{/.test(e.path));
if (badPath.length) note('HIGH', `${badPath.length} paths contain {{placeholders}}`);

let phDefaults = 0;
for (const e of c.endpoints)
  for (const q of e.queryParams) if (/\{\{/.test(q.default ?? '')) phDefaults++;
if (phDefaults) note('MED', `${phDefaults} query defaults still contain {{placeholders}}`);

// 3. empty array schemas
let emptyArr = 0;
const walk = (s) => {
  if (!s || typeof s !== 'object') return;
  if (s.type === 'array' && !s.items) emptyArr++;
  if (s.properties) Object.values(s.properties).forEach(walk);
  if (s.items) walk(s.items);
};
c.endpoints.forEach((e) => walk(e.bodySchema));
if (emptyArr) note('LOW', `${emptyArr} array schemas have no item shape`);

// 4. raw bodies that failed to parse (should now only be intentional non-JSON)
const rawFail = c.endpoints.filter((e) => e.bodyMode === 'raw' && e.bodySample === null);
if (rawFail.length)
  note(
    'MED',
    `${rawFail.length} raw bodies failed to parse: ${rawFail
      .slice(0, 5)
      .map((e) => e.id)
      .join(', ')}`
  );

// 4b. non-JSON bodies should be explicitly typed
const nonJson = c.endpoints.filter(
  (e) => e.bodyContentType && e.bodyContentType !== 'application/json'
);
console.log(
  `non-JSON bodies: ${nonJson.length} (${nonJson.map((e) => `${e.id}:${e.bodyContentType}`).join(', ')})`
);

// 4c. empty raw bodies should have been normalized to bodyMode null
const emptyRaw = c.endpoints.filter((e) => e.bodyMode === 'raw' && e.bodySample === null);
if (emptyRaw.length) note('MED', `${emptyRaw.length} endpoints still have an empty raw body`);

// 5. duplicate ids
const ids = c.endpoints.map((e) => e.id);
const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
if (dup.length) note('HIGH', `${dup.length} duplicate ids: ${dup.slice(0, 5).join(', ')}`);

// 6. missing descriptions
const noDesc = c.endpoints.filter((e) => !e.description);
if (noDesc.length) note('LOW', `${noDesc.length} endpoints have no description`);

// 7. path params declared but not in path, and vice versa
let paramMismatch = 0;
for (const e of c.endpoints) {
  const inPath = [...e.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const declared = e.pathParams.map((p) => p.name);
  if (inPath.length !== declared.length || inPath.some((n) => !declared.includes(n)))
    paramMismatch++;
}
if (paramMismatch) note('HIGH', `${paramMismatch} endpoints have path-param mismatches`);

// 8. kind sanity: DELETE must be kind delete
const badKind = c.endpoints.filter((e) => e.method === 'DELETE' && e.kind !== 'delete');
if (badKind.length) note('HIGH', `${badKind.length} DELETE endpoints not classified as delete`);

// 9. destructive coverage
const destructive = c.endpoints.filter((e) => e.destructive).length;

// 10. every endpoint has a resolvable base
const knownBases = new Set(Object.keys(c.api.bases));
const badBase = c.endpoints.filter((e) => !knownBases.has(e.base));
if (badBase.length) note('HIGH', `${badBase.length} endpoints reference unknown base keys`);

console.log(
  `\nendpoints: ${c.stats.endpointCount}  groups: ${c.stats.groupCount}  destructive: ${destructive}`
);
console.log('byKind:', JSON.stringify(c.stats.byKind));
console.log('byFamily:', JSON.stringify(c.stats.byFamily));

if (!issues.length) {
  console.log('\n✔ 0 issues found');
} else {
  console.log(`\n${issues.length} issue(s):`);
  for (const i of issues) console.log(`  [${i.sev}] ${i.msg}`);
}

// A silent drop in destructive coverage is the most dangerous catalog
// regression: it would mean DELETE operations escaping the destructive gate.
if (destructive < EXPECTED_DESTRUCTIVE) {
  console.error(
    `\n✘ destructive endpoint count dropped to ${destructive} (expected ${EXPECTED_DESTRUCTIVE}).\n` +
      '  Fewer destructive endpoints than expected means DELETE operations may be\n' +
      '  escaping the MC_NEXT_ALLOW_DESTRUCTIVE gate. Investigate before committing.'
  );
  process.exit(1);
}

// HIGH issues indicate real fidelity problems and must fail CI. MED/LOW are
// tolerated so the known, expected LOWs do not block the build.
const high = issues.filter((i) => i.sev === 'HIGH');
if (high.length) {
  console.error(`\n✘ ${high.length} HIGH-severity catalog issue(s) — failing.`);
  process.exit(1);
}
