import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import handler, { getMemberIds, renderProfileTemplate } from '../handler.js';
import { hookConfig, makeWorkspace, registerCleanup, write } from '../test-support/helpers.mjs';

registerCleanup();

test('injects one canonical DM profile through a cross-channel alias', async () => {
  const workspace = await makeWorkspace();
  const canonicalPath = await write(
    workspace,
    'memory/contacts/canonical.md',
    `---\nid: "telegram:1"\nidentities:\n  - "imessage:+12065550100"\n---\n\n# Example Person\n`,
  );
  const bootstrapFiles = [];

  await handler({
    type: 'agent',
    action: 'bootstrap',
    context: {
      sessionKey: 'agent:main:imessage:direct:+12065550100',
      workspaceDir: workspace,
      bootstrapFiles,
      cfg: hookConfig(),
    },
  });

  assert.equal(bootstrapFiles.length, 1);
  assert.equal(bootstrapFiles[0].name, 'CONTACT_PROFILE.md');
  assert.equal(bootstrapFiles[0].path, canonicalPath);
  assert.match(bootstrapFiles[0].content, /# Example Person/u);
});

test('resolves group members through the same index and deduplicates canonical files', async () => {
  const workspace = await makeWorkspace();
  const canonicalPath = await write(
    workspace,
    'memory/contacts/person.md',
    `---\nid: "telegram:1"\nidentities:\n  - "slack:U1"\n  - "slack:U2"\n---\n\n# Person\n`,
  );
  await write(
    workspace,
    'memory/groups/slack-G1.md',
    `---\nid: "slack:G1"\nmembers:\n  - "U1"\n  - "U2"\n---\n\n# Team\n`,
  );
  const bootstrapFiles = [];

  await handler({
    type: 'agent',
    action: 'bootstrap',
    context: {
      sessionKey: 'agent:main:slack:group:G1',
      workspaceDir: workspace,
      bootstrapFiles,
      cfg: hookConfig({
        groupInclusion: { enabled: true, maxContacts: 10, maxTotalChars: 30_000 },
      }),
    },
  });

  assert.equal(bootstrapFiles.length, 2);
  assert.equal(bootstrapFiles[0].name, 'CHANNEL_PROFILE.md');
  assert.equal(bootstrapFiles[1].path, canonicalPath);
});

test('renders real IDs and aliases when createOnMiss copies the contact template', async () => {
  const workspace = await makeWorkspace();
  await write(
    workspace,
    'memory/contacts/_EXAMPLE-contact.md',
    `---\nid: "<channel>:<user_id>"\nname: ""\n---\n\n# <Name>\n\nCreated YYYY-MM-DD\n`,
  );
  const bootstrapFiles = [];

  await handler({
    type: 'agent',
    action: 'bootstrap',
    context: {
      sessionKey: 'agent:main:telegram:direct:77',
      workspaceDir: workspace,
      bootstrapFiles,
      cfg: hookConfig({ createOnMiss: true }),
    },
  });

  const created = await fs.readFile(
    path.join(workspace, 'memory', 'contacts', 'telegram-77.md'),
    'utf-8',
  );
  assert.match(created, /id: "telegram:77"/u);
  assert.match(created, /identities:\n  - "telegram:77"/u);
  assert.doesNotMatch(created, /<channel>|<user_id>|<Name>|YYYY-MM-DD/u);
  assert.equal(bootstrapFiles.length, 1);
});

test('serializes concurrent auto-roster writes without losing members', async () => {
  const workspace = await makeWorkspace();
  const groupPath = await write(
    workspace,
    'memory/groups/telegram--1001.md',
    `---\nid: "telegram:-1001"\nmembers: []\n---\n\n# Group\n`,
  );
  const cfg = hookConfig({ autoRoster: true, createOnMiss: false });

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      handler({
        type: 'message',
        action: 'received',
        sessionKey: 'agent:main:telegram:group:-1001',
        context: { cfg, workspaceDir: workspace, metadata: { senderId: String(index + 1) } },
      }),
    ),
  );

  const updated = await fs.readFile(groupPath, 'utf-8');
  assert.equal(getMemberIds(updated).length, 20);
});

test('caps aggregate group-member context independently of the room profile', async () => {
  const workspace = await makeWorkspace();
  await write(
    workspace,
    'memory/groups/telegram--1002.md',
    `---\nid: "telegram:-1002"\nmembers:\n  - "1"\n  - "2"\n---\n\n# Room\n`,
  );
  for (const id of ['1', '2']) {
    await write(
      workspace,
      `memory/contacts/telegram-${id}.md`,
      `---\nid: "telegram:${id}"\n---\n${'x'.repeat(300)}\n`,
    );
  }
  const bootstrapFiles = [];

  await handler({
    type: 'agent',
    action: 'bootstrap',
    context: {
      sessionKey: 'agent:main:telegram:group:-1002',
      workspaceDir: workspace,
      bootstrapFiles,
      cfg: hookConfig({
        groupInclusion: { enabled: true, maxContacts: 10, maxTotalChars: 120 },
      }),
    },
  });

  const memberChars = bootstrapFiles
    .filter((file) => file.name.startsWith('MEMBER_PROFILE_'))
    .reduce((total, file) => total + file.content.length, 0);
  assert.ok(memberChars <= 120);
  assert.match(bootstrapFiles[0].content, /# Room/u);
});

test('template renderer works independently for audit and migration tooling', () => {
  const rendered = renderProfileTemplate(
    `---\nid: "<channel>:<user_id>"\n---\n# <Name>\nYYYY-MM-DD\n`,
    {
      channel: 'sms',
      id: '+12065550100',
      kind: 'contact',
      displayName: 'Test User',
      date: '2026-07-31',
    },
  );
  assert.match(rendered, /id: "sms:\+12065550100"/u);
  assert.match(rendered, /# Test User/u);
  assert.match(rendered, /2026-07-31/u);
});
