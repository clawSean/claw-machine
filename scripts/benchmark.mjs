import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildContactIndex,
  clearRuntimeCaches,
  resolveContactProfile,
} from '../handler.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contactsDir = path.resolve(process.argv[2] || path.join(projectDir, 'memory', 'contacts'));
const iterations = Number.parseInt(process.argv[3] || '100', 10);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

const firstIndex = await buildContactIndex(contactsDir, {
  maxFiles: 100_000,
  scanConcurrency: 4,
});
const coldBuilds = [];
for (let index = 0; index < iterations; index += 1) {
  const started = process.hrtime.bigint();
  await buildContactIndex(contactsDir, { maxFiles: 100_000, scanConcurrency: 4 });
  coldBuilds.push(Number(process.hrtime.bigint() - started) / 1_000_000);
}

const firstIdentity = firstIndex.byIdentity.keys().next().value;
const separator = firstIdentity?.indexOf(':') ?? -1;
const channel = separator > 0 ? firstIdentity.slice(0, separator) : 'missing';
const id = separator > 0 ? firstIdentity.slice(separator + 1) : 'missing';
const warmLookups = [];
clearRuntimeCaches();
await resolveContactProfile({
  contactsDir,
  channel,
  id,
  options: { enabled: true, cacheTtlMs: 60_000, maxFiles: 100_000, scanConcurrency: 4 },
});
for (let index = 0; index < iterations * 10; index += 1) {
  const started = process.hrtime.bigint();
  await resolveContactProfile({
    contactsDir,
    channel,
    id,
    options: { enabled: true, cacheTtlMs: 60_000, maxFiles: 100_000, scanConcurrency: 4 },
  });
  warmLookups.push(Number(process.hrtime.bigint() - started) / 1_000_000);
}

const samplePath = firstIndex.byIdentity.get(firstIdentity);
const directReads = [];
for (let index = 0; samplePath && index < iterations; index += 1) {
  const started = process.hrtime.bigint();
  await fs.readFile(samplePath, 'utf-8');
  directReads.push(Number(process.hrtime.bigint() - started) / 1_000_000);
}

console.log(
  JSON.stringify(
    {
      contactsDir,
      files: firstIndex.fileCount,
      identities: firstIndex.identityCount,
      collisions: firstIndex.collisions.size,
      coldIndexBuildMs: {
        median: percentile(coldBuilds, 0.5),
        p95: percentile(coldBuilds, 0.95),
      },
      warmIdentityLookupMs: {
        median: percentile(warmLookups, 0.5),
        p95: percentile(warmLookups, 0.95),
      },
      directProfileReadMs: {
        median: percentile(directReads, 0.5),
        p95: percentile(directReads, 0.95),
      },
    },
    null,
    2,
  ),
);

clearRuntimeCaches();
