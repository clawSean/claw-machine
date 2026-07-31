/** Normalize a `channel:id` identity without guessing across channels. */
function normalizeIdentity(rawIdentity: string): string | null;
function normalizeIdentity(channel: string, id: string): string | null;
function normalizeIdentity(channelOrIdentity: string, maybeId?: string): string | null {
  let channel: string;
  let value: string;

  if (maybeId === undefined) {
    const separator = channelOrIdentity.indexOf(':');
    if (separator <= 0 || separator === channelOrIdentity.length - 1) return null;
    channel = channelOrIdentity.slice(0, separator).trim();
    value = channelOrIdentity.slice(separator + 1).trim();
  } else {
    channel = channelOrIdentity.trim();
    value = maybeId.trim();
  }

  channel = channel.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel) || !isSafeProfileId(value)) return null;
  if (isPlaceholderIdentity(channel, value)) return null;

  if (PHONE_CHANNELS.has(channel) && value.startsWith('+')) {
    const digits = value.slice(1).replace(/[\s().-]/gu, '');
    if (!/^\d{7,15}$/u.test(digits)) return null;
    value = `+${digits}`;
  } else if (PHONE_CHANNELS.has(channel) && value.includes('@')) {
    value = value.toLowerCase();
  } else if (channel === 'twitter' || channel === 'x') {
    value = value.replace(/^@/u, '').toLowerCase();
  }

  return `${channel}:${value}`;
}

function parseSessionAddress(sessionKey: string): SessionAddress | null {
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent' || parts.length < 5) return null;

  const channel = parts[2]?.trim().toLowerCase();
  const type = parts[3] as ChatType | undefined;
  const id = parts[4]?.trim();

  if (!channel || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel)) return null;
  if (type !== 'direct' && type !== 'group' && type !== 'channel') return null;
  if (!id || !isSafeProfileId(id)) return null;

  return { channel, type, id };
}

function parseYamlScalar(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) return null;

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : String(parsed);
    } catch {
      return null;
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }

  return value;
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  return match?.[1] ?? null;
}

function getFrontmatterScalar(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'mu'));
  return match?.[1] ? parseYamlScalar(match[1]) : null;
}

function getFrontmatterList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/u);
  const keyPattern = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'u');
  const keyIndex = lines.findIndex((line) => keyPattern.test(line));
  if (keyIndex < 0) return [];

  const keyMatch = lines[keyIndex]?.match(keyPattern);
  const inline = keyMatch?.[1]?.trim() ?? '';
  if (inline.startsWith('[') && inline.endsWith(']')) {
    try {
      const parsed = JSON.parse(inline);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return inline
        .slice(1, -1)
        .split(',')
        .map((item) => parseYamlScalar(item))
        .filter((item): item is string => item !== null);
    }
  }

  const values: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\s+-\s+/u.test(line)) break;
    const parsed = parseYamlScalar(line.replace(/^\s+-\s+/u, ''));
    if (parsed !== null) values.push(parsed);
  }
  return values;
}

function extractContactIdentities(content: string): string[] {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return [];

  const candidates = [
    getFrontmatterScalar(frontmatter, 'id'),
    ...getFrontmatterList(frontmatter, 'identities'),
  ];
  const identities = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeIdentity(candidate);
    if (normalized) identities.add(normalized);
  }

  return [...identities];
}

/** Extract group member IDs from a simple YAML block or inline JSON array. */
function getMemberIds(content: string): string[] {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return [];

  const uniqueIds = new Set<string>();
  for (const id of getFrontmatterList(frontmatter, 'members')) {
    if (isSafeProfileId(id)) uniqueIds.add(id);
  }
  return [...uniqueIds];
}
