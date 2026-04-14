// handler.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
function capContent(content, depth) {
  if (depth === "full") return content;
  const lines = content.split("\n");
  const cap = depth === "small" ? 15 : 40;
  if (lines.length <= cap) return content;
  return lines.slice(0, cap).join("\n") + "\n\n... (profile truncated by depth setting)";
}
function getMemberIds(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const fmText = fmMatch[1];
  const membersStart = fmText.match(/(^|\n)members:\s*\n/);
  if (!membersStart) return [];
  const afterMembers = fmText.slice((membersStart.index || 0) + membersStart[0].length);
  const ids = [];
  for (const line of afterMembers.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) break;
    const idMatch = trimmed.match(/^-\s+["']?(-?\d+)["']?$/);
    if (idMatch) ids.push(idMatch[1]);
  }
  return ids;
}
function addMemberToFrontmatter(content, senderId) {
  const existing = getMemberIds(content);
  if (existing.includes(senderId)) return null;
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return null;
  const fmText = fmMatch[2];
  const newEntry = `  - "${senderId}"`;
  const membersMatch = fmText.match(/(^|\n)(members:\s*\n((?:\s+-\s+.*\n?)*))/);
  if (membersMatch) {
    const fullMatch = membersMatch[2];
    const updated = fullMatch.trimEnd() + "\n" + newEntry + "\n";
    const newFmText2 = fmText.replace(fullMatch, updated);
    return fmMatch[1] + newFmText2 + fmMatch[3] + content.slice(fmMatch[0].length);
  }
  const emptyMatch = fmText.match(/(members:\s*)\[\s*\]/);
  if (emptyMatch) {
    const replacement = "members:\n" + newEntry;
    const newFmText2 = fmText.replace(emptyMatch[0], replacement);
    return fmMatch[1] + newFmText2 + fmMatch[3] + content.slice(fmMatch[0].length);
  }
  const newFmText = fmText.trimEnd() + "\n\nmembers:\n" + newEntry + "\n";
  return fmMatch[1] + newFmText + fmMatch[3] + content.slice(fmMatch[0].length);
}
async function handleBootstrap(event) {
  const { sessionKey, workspaceDir, bootstrapFiles, cfg } = event.context;
  if (!sessionKey || !workspaceDir) return;
  const hookConfig = cfg?.hooks?.internal?.entries?.["profile-injector"] || {};
  const createOnMiss = hookConfig.createOnMiss === true;
  const groupInclusion = hookConfig.groupInclusion || { enabled: false, maxContacts: 10, profileDepth: "full" };
  const contactTemplate = hookConfig.contactTemplate || "memory/contacts/_EXAMPLE-contact.md";
  const channelTemplate = hookConfig.channelTemplate || "memory/groups/_EXAMPLE-channel.md";
  const filesToInject = [];
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 5) return;
  const channel = parts[2];
  const type = parts[3];
  const id = parts[4];
  if (type === "direct") {
    filesToInject.push({
      name: "CONTACT_PROFILE.md",
      filePath: path.join(workspaceDir, "memory", "contacts", `${channel}-${id}.md`),
      depth: "full"
    });
  } else if (type === "group" || type === "channel") {
    const groupFilePath = path.join(workspaceDir, "memory", "groups", `${channel}-${id}.md`);
    filesToInject.push({
      name: "CHANNEL_PROFILE.md",
      filePath: groupFilePath,
      depth: "full"
    });
    if (groupInclusion.enabled) {
      try {
        if (await fileExists(groupFilePath)) {
          const groupContent = await fs.readFile(groupFilePath, "utf-8");
          const memberIds = getMemberIds(groupContent);
          const maxContacts = groupInclusion.maxContacts || 10;
          for (const memberId of memberIds.slice(0, maxContacts)) {
            filesToInject.push({
              name: `MEMBER_PROFILE_${memberId}.md`,
              filePath: path.join(workspaceDir, "memory", "contacts", `${channel}-${memberId}.md`),
              depth: groupInclusion.profileDepth || "full"
            });
          }
        }
      } catch (err) {
        console.error(`[profile-injector] Group member loading failed:`, err);
      }
    }
  }
  for (const item of filesToInject) {
    let exists = await fileExists(item.filePath);
    if (!exists && createOnMiss) {
      try {
        const isContact = item.name !== "CHANNEL_PROFILE.md";
        const templateRelPath = isContact ? contactTemplate : channelTemplate;
        const templatePath = path.join(workspaceDir, templateRelPath);
        let newContent = "";
        if (await fileExists(templatePath)) {
          newContent = await fs.readFile(templatePath, "utf-8");
        } else {
          const profileId = path.basename(item.filePath, ".md");
          newContent = `---
id: "${profileId}"
created: "${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}"
---

# Profile: ${profileId}

*Auto-created by profile-injector.*
`;
        }
        await fs.mkdir(path.dirname(item.filePath), { recursive: true });
        await fs.writeFile(item.filePath, newContent, "utf-8");
        exists = true;
        console.log(`[profile-injector] Created missing profile: ${item.filePath}`);
      } catch (err) {
        console.error(`[profile-injector] Failed to create profile ${item.filePath}:`, err);
      }
    }
    if (exists) {
      try {
        let content = await fs.readFile(item.filePath, "utf-8");
        content = capContent(content, item.depth);
        if (!bootstrapFiles.some((f) => f.name === item.name)) {
          bootstrapFiles.push({
            name: item.name,
            path: item.filePath,
            content,
            missing: false
          });
        }
      } catch {
      }
    }
  }
}
async function resolveWorkspaceDir(cfg) {
  if (cfg?.workspace?.dir) return cfg.workspace.dir;
  if (cfg?.agents?.defaults?.workspace) return cfg.agents.defaults.workspace;
  try {
    const homeDir = process.env.HOME || "/root";
    const configPath = path.join(homeDir, ".openclaw", "openclaw.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const dir = parsed?.workspace?.dir || parsed?.agents?.defaults?.workspace;
    if (dir) return dir;
  } catch {
  }
  return path.join(process.env.HOME || "/root", ".openclaw", "workspace");
}
async function resolveHookConfig(cfg) {
  const fromCfg = cfg?.hooks?.internal?.entries?.["profile-injector"];
  if (fromCfg) return fromCfg;
  try {
    const homeDir = process.env.HOME || "/root";
    const configPath = path.join(homeDir, ".openclaw", "openclaw.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed?.hooks?.internal?.entries?.["profile-injector"] || {};
  } catch {
    return {};
  }
}
async function handleMessageReceived(event) {
  const { metadata, cfg } = event.context || {};
  const sessionKey = event.sessionKey;
  if (!sessionKey) return;
  const hookConfig = await resolveHookConfig(cfg);
  if (hookConfig.autoRoster === false) return;
  const createOnMiss = hookConfig.createOnMiss === true;
  const contactTemplate = hookConfig.contactTemplate || "memory/contacts/_EXAMPLE-contact.md";
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 5) return;
  const channel = parts[2];
  const chatType = parts[3];
  const groupId = parts[4];
  if (chatType !== "group" && chatType !== "channel") return;
  const senderId = metadata?.senderId || metadata?.sender_id;
  if (!senderId) return;
  const workspaceDir = await resolveWorkspaceDir(cfg);
  if (!workspaceDir) return;
  const groupFilePath = path.join(workspaceDir, "memory", "groups", `${channel}-${groupId}.md`);
  if (!await fileExists(groupFilePath)) return;
  try {
    const groupContent = await fs.readFile(groupFilePath, "utf-8");
    const senderStr = String(senderId);
    const existingMembers = getMemberIds(groupContent);
    if (existingMembers.includes(senderStr)) return;
    const updated = addMemberToFrontmatter(groupContent, senderStr);
    if (updated) {
      await fs.writeFile(groupFilePath, updated, "utf-8");
      console.log(`[profile-injector] Auto-rostered ${senderStr} into ${path.basename(groupFilePath)}`);
    }
    if (createOnMiss) {
      const contactFilePath = path.join(workspaceDir, "memory", "contacts", `${channel}-${senderStr}.md`);
      if (!await fileExists(contactFilePath)) {
        const senderName = metadata?.senderName || metadata?.sender_name || metadata?.displayName || "";
        const templatePath = path.join(workspaceDir, contactTemplate);
        let newContent = "";
        if (await fileExists(templatePath)) {
          newContent = await fs.readFile(templatePath, "utf-8");
        } else {
          const displayName = senderName || `User ${senderStr}`;
          newContent = `---
id: "${channel}:${senderStr}"
created: "${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}"
---

# Profile: ${displayName}

*Auto-created by profile-injector.*
`;
        }
        await fs.mkdir(path.dirname(contactFilePath), { recursive: true });
        await fs.writeFile(contactFilePath, newContent, "utf-8");
        console.log(`[profile-injector] Created contact file: ${contactFilePath}`);
      }
    }
  } catch (err) {
    console.error(`[profile-injector] Auto-roster failed:`, err);
  }
}
async function handleCommandNew(event) {
  const sessionKey = event.sessionKey;
  const { senderId, cfg } = event.context || {};
  if (!sessionKey || !senderId) return;
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 5) return;
  const channel = parts[2];
  const chatType = parts[3];
  const groupId = parts[4];
  if (chatType !== "group" && chatType !== "channel") return;
  const hookConfig = cfg?.hooks?.internal?.entries?.["profile-injector"] || await resolveHookConfig(cfg);
  if (hookConfig.autoRoster === false) return;
  const workspaceDir = await resolveWorkspaceDir(cfg);
  if (!workspaceDir) return;
  const groupFilePath = path.join(workspaceDir, "memory", "groups", `${channel}-${groupId}.md`);
  if (!await fileExists(groupFilePath)) return;
  try {
    const groupContent = await fs.readFile(groupFilePath, "utf-8");
    const senderStr = String(senderId);
    const existingMembers = getMemberIds(groupContent);
    if (existingMembers.includes(senderStr)) return;
    const updated = addMemberToFrontmatter(groupContent, senderStr);
    if (updated) {
      await fs.writeFile(groupFilePath, updated, "utf-8");
      console.log(`[profile-injector] Auto-rostered ${senderStr} via /new into ${path.basename(groupFilePath)}`);
    }
  } catch (err) {
    console.error(`[profile-injector] Command auto-roster failed:`, err);
  }
}
var handler = async (event) => {
  if (event.type === "agent" && event.action === "bootstrap") {
    return handleBootstrap(event);
  }
  if (event.type === "message" && event.action === "received") {
    return handleMessageReceived(event);
  }
  if (event.type === "command" && event.action === "new") {
    return handleCommandNew(event);
  }
};
var handler_default = handler;
export {
  handler_default as default
};
