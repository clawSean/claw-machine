import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Profile Injector Hook (v3)
 *
 * Events:
 *   agent:bootstrap  — inject contact/channel profiles into bootstrap context
 *   message:received — auto-roster: add new group senders to frontmatter members list
 *
 * Bootstrap behavior:
 *   - DMs: injects CONTACT_PROFILE.md for the sender
 *   - Groups: injects CHANNEL_PROFILE.md, then reads frontmatter `members` array
 *     (simple list of sender IDs) to inject each contact file as MEMBER_PROFILE_<id>.md
 *
 * Auto-roster (message:received):
 *   - For group messages, checks if the sender ID is in the group file's
 *     frontmatter `members` array. If not, appends it.
 */

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function capContent(content: string, depth: string): string {
  if (depth === 'full') return content;
  const lines = content.split('\n');
  const cap = depth === 'small' ? 15 : 40;
  if (lines.length <= cap) return content;
  return lines.slice(0, cap).join('\n') + '\n\n... (profile truncated by depth setting)';
}

/**
 * Extract member IDs from group file frontmatter.
 * Lightweight parser — no YAML dependency.
 * Expects frontmatter block with:
 *   members:
 *     - "6566057320"
 *     - "123456"
 * Also handles unquoted: - 6566057320
 */
function getMemberIds(content: string): string[] {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];

  const fmText = fmMatch[1];
  const membersStart = fmText.match(/(^|\n)members:\s*\n/);
  if (!membersStart) return [];

  const afterMembers = fmText.slice((membersStart.index || 0) + membersStart[0].length);
  const ids: string[] = [];

  for (const line of afterMembers.split('\n')) {
    const trimmed = line.trim();
    // Stop at next YAML key or empty line after list
    if (!trimmed.startsWith('-')) break;
    // Extract ID: - "6566057320" or - 6566057320 or - '6566057320'
    const idMatch = trimmed.match(/^-\s+["']?(-?\d+)["']?$/);
    if (idMatch) ids.push(idMatch[1]);
  }

  return ids;
}

/**
 * Add a member ID to the frontmatter members array in file content.
 * Returns updated content, or null if unable to modify.
 */
function addMemberToFrontmatter(content: string, senderId: string): string | null {
  // Already present?
  const existing = getMemberIds(content);
  if (existing.includes(senderId)) return null;

  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return null;

  const fmText = fmMatch[2];
  const newEntry = `  - "${senderId}"`;

  // Find existing members: block
  const membersMatch = fmText.match(/(^|\n)(members:\s*\n((?:\s+-\s+.*\n?)*))/);
  if (membersMatch) {
    // Append to existing list
    const fullMatch = membersMatch[2];
    const updated = fullMatch.trimEnd() + '\n' + newEntry + '\n';
    const newFmText = fmText.replace(fullMatch, updated);
    return fmMatch[1] + newFmText + fmMatch[3] + content.slice(fmMatch[0].length);
  }

  // members key exists but is empty array: members: []
  const emptyMatch = fmText.match(/(members:\s*)\[\s*\]/);
  if (emptyMatch) {
    const replacement = 'members:\n' + newEntry;
    const newFmText = fmText.replace(emptyMatch[0], replacement);
    return fmMatch[1] + newFmText + fmMatch[3] + content.slice(fmMatch[0].length);
  }

  // No members key at all — add before closing ---
  const newFmText = fmText.trimEnd() + '\n\nmembers:\n' + newEntry + '\n';
  return fmMatch[1] + newFmText + fmMatch[3] + content.slice(fmMatch[0].length);
}

// ─── agent:bootstrap handler ───────────────────────────────────────────────

async function handleBootstrap(event: any) {
  const { sessionKey, workspaceDir, bootstrapFiles, cfg } = event.context;
  if (!sessionKey || !workspaceDir) return;

  const hookConfig = cfg?.hooks?.internal?.entries?.['profile-injector'] || {};
  const createOnMiss = hookConfig.createOnMiss === true;
  const groupInclusion = hookConfig.groupInclusion || { enabled: false, maxContacts: 10, profileDepth: 'full' };
  const contactTemplate = hookConfig.contactTemplate || 'memory/contacts/_EXAMPLE-contact.md';
  const channelTemplate = hookConfig.channelTemplate || 'memory/groups/_EXAMPLE-channel.md';

  const filesToInject: { name: string; filePath: string; depth: string }[] = [];

  // Parse sessionKey: agent:agentId:channel:type:id
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent' || parts.length < 5) return;

  const channel = parts[2];
  const type = parts[3]; // 'direct', 'group', 'channel'
  const id = parts[4];

  if (type === 'direct') {
    filesToInject.push({
      name: 'CONTACT_PROFILE.md',
      filePath: path.join(workspaceDir, 'memory', 'contacts', `${channel}-${id}.md`),
      depth: 'full',
    });
  } else if (type === 'group' || type === 'channel') {
    const groupFilePath = path.join(workspaceDir, 'memory', 'groups', `${channel}-${id}.md`);
    filesToInject.push({
      name: 'CHANNEL_PROFILE.md',
      filePath: groupFilePath,
      depth: 'full',
    });

    // Group member injection: read frontmatter members list
    if (groupInclusion.enabled) {
      try {
        if (await fileExists(groupFilePath)) {
          const groupContent = await fs.readFile(groupFilePath, 'utf-8');
          const memberIds = getMemberIds(groupContent);
          const maxContacts = groupInclusion.maxContacts || 10;

          for (const memberId of memberIds.slice(0, maxContacts)) {
            filesToInject.push({
              name: `MEMBER_PROFILE_${memberId}.md`,
              filePath: path.join(workspaceDir, 'memory', 'contacts', `${channel}-${memberId}.md`),
              depth: groupInclusion.profileDepth || 'full',
            });
          }
        }
      } catch (err) {
        console.error(`[profile-injector] Group member loading failed:`, err);
      }
    }
  }

  // Inject files
  for (const item of filesToInject) {
    let exists = await fileExists(item.filePath);

    if (!exists && createOnMiss) {
      try {
        const isContact = item.name !== 'CHANNEL_PROFILE.md';
        const templateRelPath = isContact ? contactTemplate : channelTemplate;
        const templatePath = path.join(workspaceDir, templateRelPath);
        let newContent = '';
        if (await fileExists(templatePath)) {
          newContent = await fs.readFile(templatePath, 'utf-8');
        } else {
          const profileId = path.basename(item.filePath, '.md');
          newContent = `---\nid: "${profileId}"\ncreated: "${new Date().toISOString().slice(0, 10)}"\n---\n\n# Profile: ${profileId}\n\n*Auto-created by profile-injector.*\n`;
        }
        await fs.mkdir(path.dirname(item.filePath), { recursive: true });
        await fs.writeFile(item.filePath, newContent, 'utf-8');
        exists = true;
        console.log(`[profile-injector] Created missing profile: ${item.filePath}`);
      } catch (err) {
        console.error(`[profile-injector] Failed to create profile ${item.filePath}:`, err);
      }
    }

    if (exists) {
      try {
        let content = await fs.readFile(item.filePath, 'utf-8');
        content = capContent(content, item.depth);
        if (!bootstrapFiles.some((f: any) => f.name === item.name)) {
          bootstrapFiles.push({
            name: item.name,
            path: item.filePath,
            content,
            missing: false,
          });
        }
      } catch {
        // Silently skip unreadable files
      }
    }
  }
}

// ─── message:received handler (auto-roster) ────────────────────────────────

/**
 * Resolve workspace dir from cfg (if available), config file, or known default.
 * NOTE: process.cwd() is /root (gateway root), NOT the workspace dir.
 */
async function resolveWorkspaceDir(cfg: any): Promise<string> {
  if (cfg?.workspace?.dir) return cfg.workspace.dir;
  if (cfg?.agents?.defaults?.workspace) return cfg.agents.defaults.workspace;

  // Fallback: read from config file
  try {
    const homeDir = process.env.HOME || '/root';
    const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const dir = parsed?.workspace?.dir || parsed?.agents?.defaults?.workspace;
    if (dir) return dir;
  } catch {}

  // Last resort: standard OpenClaw workspace path
  return path.join(process.env.HOME || '/root', '.openclaw', 'workspace');
}

/**
 * Load hook config. message:received events don't include cfg,
 * so we fall back to reading openclaw.json directly.
 */
async function resolveHookConfig(cfg: any): Promise<any> {
  const fromCfg = cfg?.hooks?.internal?.entries?.['profile-injector'];
  if (fromCfg) return fromCfg;

  // Fallback: read config file directly
  try {
    const homeDir = process.env.HOME || '/root';
    const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.hooks?.internal?.entries?.['profile-injector'] || {};
  } catch {
    return {};
  }
}

async function handleMessageReceived(event: any) {
  const { metadata, cfg } = event.context || {};
  const sessionKey = event.sessionKey;
  if (!sessionKey) return;

  const hookConfig = await resolveHookConfig(cfg);
  if (hookConfig.autoRoster === false) return;
  const createOnMiss = hookConfig.createOnMiss === true;
  const contactTemplate = hookConfig.contactTemplate || 'memory/contacts/_EXAMPLE-contact.md';

  // Derive chat type, channel, and IDs from sessionKey
  // Format: agent:agentId:channel:type:id
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent' || parts.length < 5) return;

  const channel = parts[2];
  const chatType = parts[3]; // 'direct', 'group', 'channel'
  const groupId = parts[4];

  if (chatType !== 'group' && chatType !== 'channel') return;

  const senderId = metadata?.senderId || metadata?.sender_id;
  if (!senderId) return;

  const workspaceDir = await resolveWorkspaceDir(cfg);
  if (!workspaceDir) return;

  const groupFilePath = path.join(workspaceDir, 'memory', 'groups', `${channel}-${groupId}.md`);
  if (!(await fileExists(groupFilePath))) return;

  try {
    const groupContent = await fs.readFile(groupFilePath, 'utf-8');
    const senderStr = String(senderId);

    // Check if already in members list
    const existingMembers = getMemberIds(groupContent);
    if (existingMembers.includes(senderStr)) return;

    // Add to frontmatter
    const updated = addMemberToFrontmatter(groupContent, senderStr);
    if (updated) {
      await fs.writeFile(groupFilePath, updated, 'utf-8');
      console.log(`[profile-injector] Auto-rostered ${senderStr} into ${path.basename(groupFilePath)}`);
    }

    // Create contact file if needed
    if (createOnMiss) {
      const contactFilePath = path.join(workspaceDir, 'memory', 'contacts', `${channel}-${senderStr}.md`);
      if (!(await fileExists(contactFilePath))) {
        const senderName = metadata?.senderName || metadata?.sender_name || metadata?.displayName || '';
        const templatePath = path.join(workspaceDir, contactTemplate);
        let newContent = '';
        if (await fileExists(templatePath)) {
          newContent = await fs.readFile(templatePath, 'utf-8');
        } else {
          const displayName = senderName || `User ${senderStr}`;
          newContent = `---\nid: "${channel}:${senderStr}"\ncreated: "${new Date().toISOString().slice(0, 10)}"\n---\n\n# Profile: ${displayName}\n\n*Auto-created by profile-injector.*\n`;
        }
        await fs.mkdir(path.dirname(contactFilePath), { recursive: true });
        await fs.writeFile(contactFilePath, newContent, 'utf-8');
        console.log(`[profile-injector] Created contact file: ${contactFilePath}`);
      }
    }
  } catch (err) {
    console.error(`[profile-injector] Auto-roster failed:`, err);
  }
}

// ─── command:new handler (auto-roster before next bootstrap) ───────────────

async function handleCommandNew(event: any) {
  const sessionKey = event.sessionKey;
  const { senderId, cfg } = event.context || {};
  if (!sessionKey || !senderId) return;

  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent' || parts.length < 5) return;

  const channel = parts[2];
  const chatType = parts[3];
  const groupId = parts[4];

  if (chatType !== 'group' && chatType !== 'channel') return;

  const hookConfig = cfg?.hooks?.internal?.entries?.['profile-injector'] || await resolveHookConfig(cfg);
  if (hookConfig.autoRoster === false) return;

  const workspaceDir = await resolveWorkspaceDir(cfg);
  if (!workspaceDir) return;

  const groupFilePath = path.join(workspaceDir, 'memory', 'groups', `${channel}-${groupId}.md`);
  if (!(await fileExists(groupFilePath))) return;

  try {
    const groupContent = await fs.readFile(groupFilePath, 'utf-8');
    const senderStr = String(senderId);

    const existingMembers = getMemberIds(groupContent);
    if (existingMembers.includes(senderStr)) return;

    const updated = addMemberToFrontmatter(groupContent, senderStr);
    if (updated) {
      await fs.writeFile(groupFilePath, updated, 'utf-8');
      console.log(`[profile-injector] Auto-rostered ${senderStr} via /new into ${path.basename(groupFilePath)}`);
    }
  } catch (err) {
    console.error(`[profile-injector] Command auto-roster failed:`, err);
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────

const handler = async (event: any) => {
  if (event.type === 'agent' && event.action === 'bootstrap') {
    return handleBootstrap(event);
  }
  if (event.type === 'message' && event.action === 'received') {
    return handleMessageReceived(event);
  }
  if (event.type === 'command' && event.action === 'new') {
    return handleCommandNew(event);
  }
};

export default handler;
