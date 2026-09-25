#!/usr/bin/env node
/** Inspect raw bodies that failed to parse in the generator. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.argv[2] ?? '.');
const files = [
  'Salesforce Marketing Cloud Next APIs.postman_collection.json',
  'Salesforce Data 360 APIs.postman_collection.json',
  'Salesforce Data 360 Connect APIs.postman_collection.json',
];

function* walk(items, path = []) {
  for (const item of items ?? []) {
    if (Array.isArray(item.item)) yield* walk(item.item, [...path, item.name]);
    else if (item.request) yield { path: [...path, item.name], item };
  }
}

for (const f of files) {
  const c = JSON.parse(readFileSync(resolve(DIR, f), 'utf8'));
  let empty = 0;
  let nonJson = 0;
  const samples = [];
  const nonJsonSamples = [];
  for (const { path, item } of walk(c.item)) {
    const b = item.request.body;
    if (!b || b.mode !== 'raw') continue;
    const raw = b.raw;
    if (typeof raw !== 'string' || !raw.trim()) {
      empty++;
      if (samples.length < 4) samples.push(`${path.join(' > ')} | raw=${JSON.stringify(raw)}`);
      continue;
    }
    try {
      JSON.parse(raw);
    } catch {
      nonJson++;
      nonJsonSamples.push(`${path.join(' > ')} | NON-JSON: ${JSON.stringify(raw.slice(0, 200))}`);
    }
  }
  console.log(`=== ${f}`);
  console.log(`  empty raw bodies : ${empty}`);
  console.log(`  non-JSON raw     : ${nonJson}`);
  for (const s of samples) console.log(`    - ${s}`);
  for (const s of nonJsonSamples) console.log(`    ! ${s}`);
}
