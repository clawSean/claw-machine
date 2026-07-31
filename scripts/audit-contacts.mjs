import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContactIndex, extractContactIdentities } from '../handler.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contactsDir = path.resolve(process.argv[2] || path.join(projectDir, 'memory', 'contacts'));
const entries = (await fs.readdir(contactsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort();
const phoneFamilies = new Map();
const placeholderFiles = [];
const filesWithoutResolvableIdentity = [];

for (const fileName of entries) {
  const content = await fs.readFile(path.join(contactsDir, fileName), 'utf-8');
  if (/^id:\s*["']?<channel>:<user_id>/mu.test(content)) placeholderFiles.push(fileName);
  if (!fileName.startsWith('_') && extractContactIdentities(content).length === 0) {
    filesWithoutResolvableIdentity.push(fileName);
  }

  const phoneMatch = fileName.match(/^(phone|imessage|sms|rcs|bluebubbles)-(\+\d+)\.md$/u);
  if (phoneMatch) {
    const files = phoneFamilies.get(phoneMatch[2]) || [];
    files.push(fileName);
    phoneFamilies.set(phoneMatch[2], files);
  }
}

const index = await buildContactIndex(contactsDir, { maxFiles: 100_000 });
const duplicatePhoneFamilies = [...phoneFamilies.entries()]
  .filter(([, files]) => files.length > 1)
  .map(([phone, files]) => ({ phone, files }));

console.log(
  JSON.stringify(
    {
      contactsDir,
      markdownFiles: entries.length,
      indexedFiles: index.fileCount,
      resolvableIdentities: index.identityCount,
      explicitIdentityCollisions: Object.fromEntries(index.collisions),
      placeholderFiles,
      filesWithoutResolvableIdentity,
      duplicatePhoneFamilies,
    },
    null,
    2,
  ),
);
