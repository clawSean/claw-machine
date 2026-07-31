import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Profile Injector Hook (v4)
 *
 * - Resolves explicit cross-channel contact aliases from frontmatter.
 * - Keeps legacy memory/contacts/<channel>-<id>.md fallback.
 * - Fails closed when two files claim the same identity.
 * - Builds one bounded, dependency-free contact index and caches it in memory.
 * - Invalidates the cache on filesystem edits, with a TTL as a self-healing
 *   backstop if a watch event is missed.
 * - Maintains group rosters with serialized, atomic writes.
 */

const DEFAULT_CONTACT_DIR = 'memory/contacts';
const DEFAULT_GROUP_DIR = 'memory/groups';
const DEFAULT_CONTACT_TEMPLATE = 'memory/contacts/_EXAMPLE-contact.md';
const DEFAULT_CHANNEL_TEMPLATE = 'memory/groups/_EXAMPLE-channel.md';
const DEFAULT_IDENTITY_CACHE_TTL_MS = 60_000;
const DEFAULT_IDENTITY_MAX_FILES = 1_000;
const DEFAULT_IDENTITY_SCAN_CONCURRENCY = 4;
const DEFAULT_GROUP_MAX_CONTACTS = 10;
const DEFAULT_GROUP_MAX_TOTAL_CHARS = 30_000;
const CONFIG_CACHE_TTL_MS = 1_000;
const MAX_PROFILE_ID_CHARS = 320;
const PHONE_CHANNELS = new Set([
  'bluebubbles',
  'imessage',
  'phone',
  'rcs',
  'signal',
  'sms',
  'whatsapp',
]);

type ChatType = 'direct' | 'group' | 'channel';
type ProfileDepth = 'full' | 'medium' | 'small';

type SessionAddress = {
  channel: string;
  type: ChatType;
  id: string;
};

type IdentityResolutionOptions = {
  enabled: boolean;
  cacheTtlMs: number;
  maxFiles: number;
  scanConcurrency: number;
};

type ContactIndex = {
  byIdentity: Map<string, string>;
  collisions: Map<string, string[]>;
  fileCount: number;
  parsedFileCount: number;
  identityCount: number;
  ignoredIdentityCount: number;
  buildMs: number;
};

type ContactIndexCacheEntry = {
  value?: ContactIndex;
  loading?: Promise<ContactIndex>;
  expiresAt: number;
  version: number;
  optionsKey: string;
  watcher?: FSWatcher;
};

type ContactResolution = {
  status: 'resolved' | 'legacy' | 'missing' | 'collision' | 'invalid';
  identity?: string;
  filePath?: string;
  collisions?: string[];
};

type ProfileDirectories = {
  contactsDir: string;
  groupsDir: string;
};

type ProfileCreation = {
  filePath: string;
  templatePath: string;
  workspaceDir: string;
  contactsDir?: string;
  channel: string;
  id: string;
  kind: 'contact' | 'group';
  displayName?: string;
};

type InjectionItem = {
  name: string;
  filePath: string;
  depth: ProfileDepth;
  kind: 'contact' | 'channel' | 'member';
};

const contactIndexCache = new Map<string, ContactIndexCacheEntry>();
const fileMutationQueues = new Map<string, Promise<void>>();
const loggedIssues = new Set<string>();

let openClawConfigCache:
  | {
      filePath: string;
      value: any;
      expiresAt: number;
    }
  | undefined;

function logIssueOnce(key: string, message: string) {
  if (loggedIssues.has(key)) return;
  loggedIssues.add(key);
  console.error(message);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function profileDepth(value: unknown): ProfileDepth {
  return value === 'small' || value === 'medium' || value === 'full' ? value : 'full';
}

function isSafeProfileId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_CHARS &&
    value !== '.' &&
    value !== '..' &&
    !/[\0\r\n/\\]/u.test(value) &&
    !/^\s|\s$/u.test(value)
  );
}

function isPlaceholderIdentity(channel: string, value: string): boolean {
  const normalizedChannel = channel.toLowerCase();
  const normalizedValue = value.toLowerCase();
  return (
    normalizedChannel.includes('<') ||
    normalizedChannel.includes('>') ||
    normalizedValue.includes('<user_id>') ||
    normalizedValue.includes('<group_id>') ||
    normalizedValue === 'unknown' ||
    normalizedValue.endsWith('-todo')
  );
}
