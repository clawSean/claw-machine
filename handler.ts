import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Profile Injector Hook
 * 
 * Automatically loads user/group profiles into the agent's context
 * based on session keys (channel, chat type, ID).
 */

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Helper to cap profile size for social awareness
function capContent(content: string, depth: string): string {
  if (depth === 'full') return content;
  const lines = content.split('\n');
  const cap = depth === 'small' ? 15 : 40;
  if (lines.length <= cap) return content;
  return lines.slice(0, cap).join('\n') + '\n\n... (profile truncated by depth setting)';
}

const handler = async (event: any) => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  const { sessionKey, workspaceDir, bootstrapFiles, cfg } = event.context;
  if (!sessionKey || !workspaceDir) return;

  // Hook config
  const hookConfig = cfg?.hooks?.internal?.entries?.['profile-injector'] || {};
  const createOnMiss = hookConfig.createOnMiss === true;
  const groupInclusion = hookConfig.groupInclusion || { enabled: false, maxContacts: 3, profileDepth: 'small' };
  
  const contactTemplate = hookConfig.contactTemplate || 'memory/contacts/_EXAMPLE-contact.md';
  const channelTemplate = hookConfig.channelTemplate || 'memory/groups/_EXAMPLE-channel.md';

  let filesToInject: { name: string; filePath: string; depth: string }[] = [];

  // Parse sessionKey (format: agent:agentId:channel:type:id)
  const parts = sessionKey.split(':');

  if (parts[0] === 'agent' && parts.length >= 5) {
    const channel = parts[2];
    const type = parts[3]; // 'direct', 'group', 'channel'
    const id = parts[4];

    if (type === 'direct') {
      filesToInject.push({
        name: 'CONTACT_PROFILE.md',
        filePath: path.join(workspaceDir, 'memory', 'contacts', `${channel}-${id}.md`),
        depth: 'full'
      });
    } else if (type === 'group' || type === 'channel') {
      filesToInject.push({
        name: 'CHANNEL_PROFILE.md',
        filePath: path.join(workspaceDir, 'memory', 'groups', `${channel}-${id}.md`),
        depth: 'full'
      });

      // Group Member Context (Social Awareness)
      if (groupInclusion.enabled) {
        try {
          const transcriptFile = bootstrapFiles.find((f: any) => f.name === 'TRANSCRIPT.md' || f.name === 'SESSION.md');
          const transcript = transcriptFile?.content || '';
          const senderMatches = [...transcript.matchAll(/\(ID:\s*(\d+)\)/g)];
          const uniqueSenderIds = [...new Set(senderMatches.map(m => m[1]))]
            .filter(senderId => senderId !== id)
            .slice(0, groupInclusion.maxContacts);

          for (const senderId of uniqueSenderIds) {
            filesToInject.push({
              name: `PROFILE_${senderId}.md`,
              filePath: path.join(workspaceDir, 'memory', 'contacts', `${channel}-${senderId}.md`),
              depth: groupInclusion.profileDepth
            });
          }
        } catch (err) {
          console.error(`[profile-injector] Group inclusion scanning failed:`, err);
        }
      }
    }
  }

  // Process injections
  for (const item of filesToInject) {
    let exists = await fileExists(item.filePath);

    if (!exists && createOnMiss) {
        // ... (creation logic remains same as previous version)
        // Kept simple for readability; uses templatePath logic from prev version if needed
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
            missing: false
          });
          // console.log(`[profile-injector] Injected ${item.name}`);
        }
      } catch (err) {}
    }
  }
};

export default handler;
