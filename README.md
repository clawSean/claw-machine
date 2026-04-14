# 🦞 Claw Machine

Drop a coin, grab a profile.

An [OpenClaw](https://openclaw.ai) hook that automatically injects contact and group profile files into agent context at bootstrap - so your agent already knows who it's talking to before the conversation starts.

## ⚙️ How It Works

When a session bootstraps, the hook parses the `sessionKey` to determine the channel, chat type, and user/group ID, then looks for a matching profile file in your workspace:

| Chat type | Lookup path | Injected as |
|-----------|------------|-------------|
| Direct message | `memory/contacts/<channel>-<id>.md` | `CONTACT_PROFILE.md` |
| Group / channel | `memory/groups/<channel>-<id>.md` | `CHANNEL_PROFILE.md` |

If the file exists, its contents are injected into the agent's bootstrap context automatically.

### 👥 Group Member Profiles

When `groupInclusion` is enabled, the hook reads the group file's frontmatter `members` list (a flat array of sender IDs) and injects each member's contact file alongside the group profile. Your agent walks into every group chat knowing the room.

Members are maintained automatically via the **auto-roster**: when someone sends a message in a group, their ID is added to the group file's `members` list if it isn't there already. No manual maintenance required.

## 📦 Install

> ⚠️ **The handler must be compiled before it can run.** `handler.ts` is the source - OpenClaw needs `handler.js`.

```bash
git clone https://github.com/clawSean/claw-machine.git
cd claw-machine
bash install.sh
```

That script:
1. Compiles `handler.ts` → `handler.js` via `esbuild`
2. Copies `handler.js` + `HOOK.md` into `~/.openclaw/hooks/profile-injector/`
3. Prints confirmation

Then enable and restart:

```bash
openclaw hooks enable profile-injector
openclaw gateway restart
```

### Manual install

```bash
npx esbuild handler.ts --bundle --platform=node --format=esm --outfile=handler.js --external:node:fs --external:node:path
mkdir -p ~/.openclaw/hooks/profile-injector
cp handler.js HOOK.md ~/.openclaw/hooks/profile-injector/
openclaw hooks enable profile-injector
openclaw gateway restart
```

### Verify

```bash
openclaw hooks list
# Should show: 👤 profile-injector ✓ ready
```

In a chat, run `/context` or `/status` to confirm profile files are being injected.

## 🔧 Configuration

Add to your `openclaw.json` under `hooks.internal.entries`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "profile-injector": {
          "enabled": true,
          "createOnMiss": false,
          "autoRoster": true,
          "contactTemplate": "memory/contacts/_EXAMPLE-contact.md",
          "channelTemplate": "memory/groups/_EXAMPLE-channel.md",
          "groupInclusion": {
            "enabled": true,
            "maxContacts": 10,
            "profileDepth": "full"
          }
        }
      }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `createOnMiss` | `boolean` | `false` | Create a new profile from template if none exists |
| `autoRoster` | `boolean` | `true` | Auto-add new group senders to group file's members list |
| `contactTemplate` | `string` | `memory/contacts/_EXAMPLE-contact.md` | Workspace-relative path to contact template |
| `channelTemplate` | `string` | `memory/groups/_EXAMPLE-channel.md` | Workspace-relative path to group template |
| `groupInclusion.enabled` | `boolean` | `false` | Inject member contact profiles in group sessions |
| `groupInclusion.maxContacts` | `number` | `10` | Max member profiles to inject per group session |
| `groupInclusion.profileDepth` | `string` | `"full"` | `"full"`, `"medium"` (40 lines), or `"small"` (15 lines) |

## ⚠️ Critical: File Naming & Format

**The hook is strict about naming conventions and frontmatter format. Deviations silently fail - no crash, no error, just no injection.**

### File Naming

Files **must** follow `<channel>-<id>.md`, derived directly from the session key:

```
memory/contacts/telegram-6566057320.md       ✅
memory/groups/telegram--1003813189624.md     ✅ (double dash = negative group ID)
memory/contacts/tg-6566057320.md             ❌ (wrong channel prefix)
memory/contacts/jpop.md                       ❌ (no channel-id pattern)
```

**Telegram group IDs are negative**, so group filenames always have a double dash (e.g., `telegram--1003813189624.md`). This is correct - don't "fix" it.

### Group Frontmatter - Members List

The `members` key must be a YAML list of ID strings inside the frontmatter:

```yaml
---
id: "telegram:-1003813189624"
name: "My Group"
type: "group"

members:
  - "6566057320"
  - "123456"
---
```

**Rules:**
- Each entry is just a sender ID - no names, roles, or paths needed
- Must be inside the `---` frontmatter block
- Each entry on its own `- "id"` line
- Both quoted strings and bare numbers work

**Will NOT work:**
```yaml
members: ["6566057320", "123456"]       # inline array
members:                                 # object entries
  - id: "6566057320"
    name: "JPop"
```

## 📂 Expected Directory Structure

```
<workspace>/
└── memory/
    ├── contacts/
    │   ├── telegram-6566057320.md
    │   ├── discord-789012.md
    │   └── _EXAMPLE-contact.md        # template (optional)
    └── groups/
        ├── telegram--1003707644960.md  # note: double dash
        ├── discord-456789.md
        └── _EXAMPLE-channel.md        # template (optional)
```

## 🔍 Troubleshooting

### Profile not showing up in `/context`

1. **File exists?** Check the exact path - `ls memory/contacts/telegram-<id>.md`
2. **Filename correct?** Must be `<channel>-<id>.md` with the right channel prefix
3. **For groups - `groupInclusion.enabled: true`?** Default is `false`
4. **For groups - members in frontmatter?** Check `members:` list exists and has IDs
5. **Hook loaded?** `openclaw hooks list` should show `👤 profile-injector ✓`
6. **Restarted?** Hook changes need a gateway restart

### Auto-roster not working

- Group file must already exist (auto-roster updates existing files, doesn’t create new ones)
- Check `autoRoster` isn’t explicitly set to `false` in config
- Channel must provide `metadata.senderId` in the `message:received` event
- Chat type is derived from `event.sessionKey`, not `metadata.chatType` (which OpenClaw does not provide)
- **Workspace dir is NOT `process.cwd()`** — gateway cwd is `/root`, not the workspace. The hook reads `workspace.dir` from `~/.openclaw/openclaw.json` or falls back to `~/.openclaw/workspace`
- Config and hook settings are read from `~/.openclaw/openclaw.json` directly since `message:received` events don’t include `cfg`
- **Group must be in `channels.telegram.groups` config** with `requireMention: false` — unconfigured groups default to mention-required, and unmentioned messages are dropped before the hook fires
- Auto-roster also fires on `command:new` (/new), ensuring members are rostered before bootstrap reads them

### Context too large / truncation warnings

Each member profile counts toward `bootstrapMaxChars`. For large groups:
- Set `profileDepth: "small"` (15 lines per profile)
- Lower `maxContacts` (e.g., 5 instead of 10)
- Or increase `agents.defaults.bootstrapMaxChars` in config

### Gateway crash after deploy

SIGUSR1 hot-reload can occasionally crash during active processing. If the bot stops responding:
- Check: `pgrep openclaw-gateway`
- It auto-restarts, but messages during the ~5s crash window are lost
- Safer: deploy during low-traffic periods or use full `openclaw gateway restart`

## 📄 License

MIT - grab it, use it, claw away.
