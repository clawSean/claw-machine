import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import {
  addMemberToFrontmatter,
  buildContactIndex,
  extractContactIdentities,
  getMemberIds,
  invalidateContactIndex,
  normalizeIdentity,
  parseSessionAddress,
  resolveContactProfile,
} from '../handler.js';
import { makeWorkspace, registerCleanup, write } from '../test-support/helpers.mjs';

registerCleanup();

test('normalizes explicit identities without cross-channel guessing', () => {
  assert.equal(normalizeIdentity('Telegram:123456789'), 'telegram:123456789');
  assert.equal(normalizeIdentity('imessage', '+1 (202) 555-0142'), 'imessage:+12025550142');
  assert.equal(normalizeIdentity('IMESSAGE:USER@EXAMPLE.COM'), 'imessage:user@example.com');
  assert.equal(normalizeIdentity('twitter:@Example_User'), 'twitter:example_user');
  assert.equal(normalizeIdentity('<channel>:<user_id>'), null);
  assert.equal(normalizeIdentity('telegram:UNKNOWN'), null);
  assert.equal(normalizeIdentity('telegram:../../private'), null);
});

test('parses only supported, path-safe session addresses', () => {
  assert.deepEqual(parseSessionAddress('agent:main:telegram:group:-1001:topic:7'), {
    channel: 'telegram',
    type: 'group',
    id: '-1001',
  });
  assert.equal(parseSessionAddress('agent:main:telegram:direct:../../bad'), null);
  assert.equal(parseSessionAddress('agent:main:telegram:thread:1'), null);
});

test('reads legacy id plus block and inline identity aliases', () => {
  const block = `---\nid: "telegram:1"\nidentities:\n  - "sms:+12065550100"\n  - 'imessage:+12065550100'\n---\n`;
  assert.deepEqual(extractContactIdentities(block), [
    'telegram:1',
    'sms:+12065550100',
    'imessage:+12065550100',
  ]);

  const inline = `---\nid: "discord:2"\nidentities: ["slack:U123", "telegram:2"]\n---\n`;
  assert.deepEqual(extractContactIdentities(inline), [
    'discord:2',
    'slack:U123',
    'telegram:2',
  ]);
});

test('supports nonnumeric group member IDs and preserves roster entries', () => {
  const initial = `---\nid: "slack:G1"\nmembers:\n  - "U123ABC"\n  - "+12065550100"\n---\n\n# Room\n`;
  assert.deepEqual(getMemberIds(initial), ['U123ABC', '+12065550100']);

  const updated = addMemberToFrontmatter(initial, 'user@example.com');
  assert.ok(updated);
  assert.deepEqual(getMemberIds(updated), ['U123ABC', '+12065550100', 'user@example.com']);
  assert.equal(addMemberToFrontmatter(updated, 'U123ABC'), null);
});

test('builds a deterministic identity index and ignores template placeholders', async () => {
  const workspace = await makeWorkspace();
  const contactsDir = path.join(workspace, 'memory', 'contacts');
  await write(
    workspace,
    'memory/contacts/person.md',
    `---\nid: "telegram:1"\nidentities:\n  - "imessage:+12065550100"\n---\n`,
  );
  await write(
    workspace,
    'memory/contacts/_EXAMPLE-contact.md',
    `---\nid: "<channel>:<user_id>"\n---\n`,
  );

  const index = await buildContactIndex(contactsDir, { maxFiles: 10 });
  assert.equal(index.fileCount, 1);
  assert.equal(index.identityCount, 2);
  assert.equal(index.collisions.size, 0);
  assert.equal(path.basename(index.byIdentity.get('imessage:+12065550100')), 'person.md');
});

test('fails closed when two files claim one identity, even when an exact path exists', async () => {
  const workspace = await makeWorkspace();
  const contactsDir = path.join(workspace, 'memory', 'contacts');
  await write(workspace, 'memory/contacts/telegram-1.md', `---\nid: "telegram:1"\n---\nA\n`);
  await write(
    workspace,
    'memory/contacts/b.md',
    `---\nid: "discord:2"\nidentities:\n  - "telegram:1"\n---\nB\n`,
  );

  const resolution = await resolveContactProfile({
    contactsDir,
    channel: 'telegram',
    id: '1',
    options: { cacheTtlMs: 60_000, maxFiles: 10 },
  });
  assert.equal(resolution.status, 'collision');
  assert.equal(resolution.collisions.length, 2);
});

test('keeps exact-path fallback for unmigrated profiles', async () => {
  const workspace = await makeWorkspace();
  const contactsDir = path.join(workspace, 'memory', 'contacts');
  const filePath = await write(
    workspace,
    'memory/contacts/telegram-9.md',
    `---\nid: "<channel>:<user_id>"\n---\nLegacy\n`,
  );

  const resolution = await resolveContactProfile({
    contactsDir,
    channel: 'telegram',
    id: '9',
    options: { cacheTtlMs: 60_000, maxFiles: 10 },
  });
  assert.equal(resolution.status, 'legacy');
  assert.equal(resolution.filePath, filePath);
});

test('keeps exact-path fallback when the contact index exceeds its safety bound', async () => {
  const workspace = await makeWorkspace();
  const contactsDir = path.join(workspace, 'memory', 'contacts');
  const filePath = await write(
    workspace,
    'memory/contacts/telegram-9.md',
    `---\nid: "<channel>:<user_id>"\n---\nLegacy\n`,
  );
  await write(workspace, 'memory/contacts/other.md', `---\nid: "telegram:10"\n---\nOther\n`);

  const resolution = await resolveContactProfile({
    contactsDir,
    channel: 'telegram',
    id: '9',
    options: { cacheTtlMs: 60_000, maxFiles: 1 },
  });
  assert.equal(resolution.status, 'legacy');
  assert.equal(resolution.filePath, filePath);
});

test('rebuilds cached aliases after explicit invalidation', async () => {
  const workspace = await makeWorkspace();
  const contactsDir = path.join(workspace, 'memory', 'contacts');
  const filePath = await write(
    workspace,
    'memory/contacts/person.md',
    `---\nid: "telegram:1"\n---\nPerson\n`,
  );

  const missing = await resolveContactProfile({
    contactsDir,
    channel: 'slack',
    id: 'U1',
    options: { cacheTtlMs: 60_000, maxFiles: 10 },
  });
  assert.equal(missing.status, 'missing');

  await fs.writeFile(
    filePath,
    `---\nid: "telegram:1"\nidentities:\n  - "slack:U1"\n---\nPerson\n`,
    'utf-8',
  );
  invalidateContactIndex(contactsDir);

  const resolved = await resolveContactProfile({
    contactsDir,
    channel: 'slack',
    id: 'U1',
    options: { cacheTtlMs: 60_000, maxFiles: 10 },
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.filePath, filePath);
});
