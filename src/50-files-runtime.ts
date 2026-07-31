function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function ensureContactIdentityList(content: string, identity: string): string {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
  if (!match) {
    return `---\nid: ${yamlQuote(identity)}\nidentities:\n  - ${yamlQuote(identity)}\n---\n\n${content}`;
  }

  const frontmatter = match[2] ?? '';
  if (/^identities:\s*/mu.test(frontmatter)) return content;

  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const idPattern = /^id:\s*.*$/mu;
  const newFrontmatter = idPattern.test(frontmatter)
    ? frontmatter.replace(
        idPattern,
        (line) => `${line}${lineEnding}identities:${lineEnding}  - ${yamlQuote(identity)}`,
      )
    : `id: ${yamlQuote(identity)}${lineEnding}identities:${lineEnding}  - ${yamlQuote(identity)}${lineEnding}${frontmatter}`;

  return `${match[1]}${newFrontmatter}${match[3]}${content.slice(match[0].length)}`;
}

function renderProfileTemplate(
  template: string,
  params: {
    channel: string;
    id: string;
    kind: 'contact' | 'group';
    displayName?: string;
    date?: string;
  },
): string {
  const identity = `${params.channel}:${params.id}`;
  const displayName = params.displayName?.trim() || params.id;
  const date = params.date ?? new Date().toISOString().slice(0, 10);

  let rendered = template
    .replaceAll('<channel>:<user_id>', identity)
    .replaceAll('<channel>:<group_id>', identity)
    .replaceAll('<channel>', params.channel)
    .replaceAll('<user_id>', params.id)
    .replaceAll('<group_id>', params.id)
    .replaceAll('<Name>', displayName)
    .replaceAll('YYYY-MM-DD', date);

  if (params.kind === 'contact') rendered = ensureContactIdentityList(rendered, identity);
  return rendered;
}

async function createProfileIfMissing(params: ProfileCreation): Promise<boolean> {
  if (await fileExists(params.filePath)) return true;

  let template = '';
  if (await fileExists(params.templatePath)) {
    template = await fs.readFile(params.templatePath, 'utf-8');
  } else {
    const identity = `${params.channel}:${params.id}`;
    const heading = params.displayName?.trim() || params.id;
    template =
      params.kind === 'contact'
        ? `---\nid: ${yamlQuote(identity)}\nidentities:\n  - ${yamlQuote(identity)}\ncreated: "YYYY-MM-DD"\n---\n\n# Profile: <Name>\n\n*Auto-created by profile-injector.*\n`
        : `---\nid: ${yamlQuote(identity)}\ntype: "group"\ncreated: "YYYY-MM-DD"\nmembers: []\n---\n\n# Social memory for <Name>\n\n*Auto-created by profile-injector.*\n`;
    template = template.replaceAll('<Name>', heading);
  }

  const content = renderProfileTemplate(template, {
    channel: params.channel,
    id: params.id,
    kind: params.kind,
    displayName: params.displayName,
  });

  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  try {
    await fs.writeFile(params.filePath, content, { encoding: 'utf-8', flag: 'wx' });
    if (params.contactsDir) invalidateContactIndex(params.contactsDir);
    console.log(`[profile-injector] Created missing profile: ${params.filePath}`);
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return true;
    console.error(`[profile-injector] Failed to create profile ${params.filePath}:`, error);
    return false;
  }
}

async function writeFileAtomically(filePath: string, content: string) {
  const stat = await fs.stat(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, content, {
      encoding: 'utf-8',
      mode: stat.mode & 0o777,
      flag: 'wx',
    });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withFileMutationLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  fileMutationQueues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
  }
}

function resolveConfigFilePath(): string {
  const homeDir = process.env.HOME || '/root';
  return process.env.OPENCLAW_CONFIG_PATH || path.join(homeDir, '.openclaw', 'openclaw.json');
}

async function readOpenClawConfigCached(): Promise<any> {
  const filePath = resolveConfigFilePath();
  const now = Date.now();
  if (
    openClawConfigCache &&
    openClawConfigCache.filePath === filePath &&
    now < openClawConfigCache.expiresAt
  ) {
    return openClawConfigCache.value;
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const value = JSON.parse(raw);
    openClawConfigCache = { filePath, value, expiresAt: now + CONFIG_CACHE_TTL_MS };
    return value;
  } catch {
    return {};
  }
}

async function resolveRuntime(
  cfg: any,
  explicitWorkspaceDir?: string,
): Promise<{ cfg: any; workspaceDir: string; hookConfig: any }> {
  const effectiveCfg = cfg ?? (await readOpenClawConfigCached());
  const homeDir = process.env.HOME || '/root';
  const workspaceDir =
    explicitWorkspaceDir ||
    effectiveCfg?.workspace?.dir ||
    effectiveCfg?.agents?.defaults?.workspace ||
    path.join(homeDir, '.openclaw', 'workspace');
  const hookConfig = effectiveCfg?.hooks?.internal?.entries?.['profile-injector'] || {};
  return { cfg: effectiveCfg, workspaceDir, hookConfig };
}

function templatePath(
  workspaceDir: string,
  hookConfig: any,
  kind: 'contact' | 'group',
): string {
  const configured =
    kind === 'contact' ? hookConfig?.contactTemplate : hookConfig?.channelTemplate;
  return resolveWorkspacePath(
    workspaceDir,
    configured,
    kind === 'contact' ? DEFAULT_CONTACT_TEMPLATE : DEFAULT_CHANNEL_TEMPLATE,
  );
}

function memberBootstrapName(memberId: string): string {
  const safeId = memberId.replace(/[^a-zA-Z0-9_.+@-]/gu, '_').slice(0, 100);
  return `MEMBER_PROFILE_${safeId}.md`;
}
