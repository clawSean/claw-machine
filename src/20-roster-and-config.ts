/** Add a member ID to frontmatter without parsing or rewriting the whole YAML document. */
function addMemberToFrontmatter(content: string, senderId: string): string | null {
  if (!isSafeProfileId(senderId) || getMemberIds(content).includes(senderId)) return null;

  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
  if (!match) return null;

  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = (match[2] ?? '').split(/\r?\n/u);
  const memberLine = `  - ${JSON.stringify(senderId)}`;
  const keyIndex = lines.findIndex((line) => /^members:\s*/u.test(line));

  if (keyIndex < 0) {
    if (lines.at(-1)?.trim()) lines.push('');
    lines.push('members:', memberLine);
  } else {
    const inline = lines[keyIndex]?.match(/^members:\s*(.*?)\s*$/u)?.[1] ?? '';
    if (inline === '[]') {
      lines[keyIndex] = 'members:';
      lines.splice(keyIndex + 1, 0, memberLine);
    } else if (inline === '') {
      let insertIndex = keyIndex + 1;
      while (insertIndex < lines.length && /^\s+-\s+/u.test(lines[insertIndex] ?? '')) {
        insertIndex += 1;
      }
      lines.splice(insertIndex, 0, memberLine);
    } else if (inline.startsWith('[')) {
      const existing = getMemberIds(content);
      lines[keyIndex] = 'members:';
      lines.splice(
        keyIndex + 1,
        0,
        ...existing.map((id) => `  - ${JSON.stringify(id)}`),
        memberLine,
      );
    } else {
      return null;
    }
  }

  const updatedFrontmatter = lines.join(lineEnding);
  return `${match[1]}${updatedFrontmatter}${match[3]}${content.slice(match[0].length)}`;
}

function capContent(content: string, depth: ProfileDepth, maxChars = Number.POSITIVE_INFINITY): string {
  const suffix = '\n\n... (profile truncated by profile-injector)';
  let capped = content;

  if (depth !== 'full') {
    const lines = content.split('\n');
    const lineCap = depth === 'small' ? 15 : 40;
    if (lines.length > lineCap) capped = `${lines.slice(0, lineCap).join('\n')}${suffix}`;
  }

  if (Number.isFinite(maxChars) && capped.length > maxChars) {
    const budget = Math.max(0, Math.floor(maxChars));
    if (budget <= suffix.length) return capped.slice(0, budget);
    capped = `${capped.slice(0, budget - suffix.length).trimEnd()}${suffix}`;
  }

  return capped;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspacePath(
  workspaceDir: string,
  configuredPath: unknown,
  fallbackRelativePath: string,
): string {
  const relativePath =
    typeof configuredPath === 'string' && configuredPath.trim()
      ? configuredPath.trim()
      : fallbackRelativePath;
  const resolved = path.resolve(workspaceDir, relativePath);

  if (isPathInside(workspaceDir, resolved)) return resolved;

  logIssueOnce(
    `unsafe-workspace-path:${relativePath}`,
    `[profile-injector] Ignoring path outside workspace: ${relativePath}`,
  );
  return path.resolve(workspaceDir, fallbackRelativePath);
}

function resolveProfileDirectories(workspaceDir: string, hookConfig: any): ProfileDirectories {
  return {
    contactsDir: resolveWorkspacePath(
      workspaceDir,
      hookConfig?.contactDir ?? hookConfig?.contactsDir,
      DEFAULT_CONTACT_DIR,
    ),
    groupsDir: resolveWorkspacePath(
      workspaceDir,
      hookConfig?.groupDir ?? hookConfig?.groupsDir,
      DEFAULT_GROUP_DIR,
    ),
  };
}
function safeProfileFilePath(directory: string, channel: string, id: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel) || !isSafeProfileId(id)) return null;
  const filePath = path.resolve(directory, `${channel}-${id}.md`);
  return isPathInside(directory, filePath) ? filePath : null;
}

function identityResolutionOptions(hookConfig: any): IdentityResolutionOptions {
  const config = hookConfig?.identityResolution ?? {};
  return {
    enabled: config.enabled !== false,
    cacheTtlMs: boundedInteger(
      config.cacheTtlMs,
      DEFAULT_IDENTITY_CACHE_TTL_MS,
      0,
      3_600_000,
    ),
    maxFiles: boundedInteger(
      config.maxFiles,
      DEFAULT_IDENTITY_MAX_FILES,
      1,
      100_000,
    ),
    scanConcurrency: boundedInteger(
      config.scanConcurrency,
      DEFAULT_IDENTITY_SCAN_CONCURRENCY,
      1,
      16,
    ),
  };
}
