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
const handler = async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }
  const { sessionKey, workspaceDir, bootstrapFiles, cfg } = event.context;
  if (!sessionKey || !workspaceDir) return;
  const hookConfig = cfg?.hooks?.internal?.entries?.["profile-injector"] || {};
  const createOnMiss = hookConfig.createOnMiss === true;
  const groupInclusion = hookConfig.groupInclusion || { enabled: false, maxContacts: 3, profileDepth: "small" };
  const contactTemplate = hookConfig.contactTemplate || "memory/contacts/_EXAMPLE-contact.md";
  const channelTemplate = hookConfig.channelTemplate || "memory/groups/_EXAMPLE-channel.md";
  let filesToInject = [];
  const parts = sessionKey.split(":");
  if (parts[0] === "agent" && parts.length >= 5) {
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
      filesToInject.push({
        name: "CHANNEL_PROFILE.md",
        filePath: path.join(workspaceDir, "memory", "groups", `${channel}-${id}.md`),
        depth: "full"
      });
      if (groupInclusion.enabled) {
        try {
          const transcriptFile = bootstrapFiles.find((f) => f.name === "TRANSCRIPT.md" || f.name === "SESSION.md");
          const transcript = transcriptFile?.content || "";
          const senderMatches = [...transcript.matchAll(/\(ID:\s*(\d+)\)/g)];
          const uniqueSenderIds = [...new Set(senderMatches.map((m) => m[1]))].filter((senderId) => senderId !== id).slice(0, groupInclusion.maxContacts);
          for (const senderId of uniqueSenderIds) {
            filesToInject.push({
              name: `PROFILE_${senderId}.md`,
              filePath: path.join(workspaceDir, "memory", "contacts", `${channel}-${senderId}.md`),
              depth: groupInclusion.profileDepth
            });
          }
        } catch (err) {
          console.error(`[profile-injector] Group inclusion scanning failed:`, err);
        }
      }
    }
  }
  for (const item of filesToInject) {
    let exists = await fileExists(item.filePath);
    if (!exists && createOnMiss) {
      try {
        const isContact = item.name === "CONTACT_PROFILE.md" || item.name.startsWith("PROFILE_");
        const templateRelPath = isContact ? contactTemplate : channelTemplate;
        const templatePath = path.join(workspaceDir, templateRelPath);
        const templateExists = await fileExists(templatePath);
        let newContent = "";
        if (templateExists) {
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
      } catch (err) {
      }
    }
  }
};
var handler_default = handler;
export {
  handler_default as default
};
