---
name: profile-injector
description: "Injects contact and channel profile files into session context, with auto-roster for group members."
metadata:
  { "openclaw": { "emoji": "👤", "events": ["agent:bootstrap", "message:received", "command:new"] } }
---

# Profile Injector (v3)

Listens for `agent:bootstrap` and `message:received` to automatically inject and maintain profile context.

## What It Does

### Bootstrap (agent:bootstrap)

1. Parses the `sessionKey` to determine channel, chat type, and ID.
2. **DMs**: Injects `CONTACT_PROFILE.md` from `memory/contacts/<channel>-<id>.md`.
3. **Groups**: Injects `CHANNEL_PROFILE.md` from `memory/groups/<channel>-<id>.md`, then reads the frontmatter `members` array (a flat list of sender IDs) to inject each member's contact file as `MEMBER_PROFILE_<id>.md`.

### Auto-Roster (message:received)

For group messages, checks whether the sender's ID is in the group file's frontmatter `members` array. If not:
- Appends the sender ID to the `members` array in frontmatter
- Optionally creates a contact file from the template (if `createOnMiss: true`)

This keeps the members list self-maintaining — after someone talks in a group, they're automatically registered for future bootstrap injection.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "profile-injector": {
          "enabled": true,
          "createOnMiss": true,
          "autoRoster": true,
          "groupInclusion": {
            "enabled": true,
            "maxContacts": 10,
            "profileDepth": "full"
          },
          "contactTemplate": "memory/contacts/_EXAMPLE-contact.md",
          "channelTemplate": "memory/groups/_EXAMPLE-channel.md"
        }
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `createOnMiss` | `boolean` | `false` | Create profile files from templates when they don't exist |
| `autoRoster` | `boolean` | `true` | Auto-add new group senders to frontmatter members list |
| `groupInclusion.enabled` | `boolean` | `false` | Inject member contact files for group sessions |
| `groupInclusion.maxContacts` | `number` | `10` | Max member profiles to inject per session |
| `groupInclusion.profileDepth` | `string` | `"full"` | `"full"`, `"medium"` (40 lines), or `"small"` (15 lines) |
| `contactTemplate` | `string` | `memory/contacts/_EXAMPLE-contact.md` | Workspace-relative path to contact template |
| `channelTemplate` | `string` | `memory/groups/_EXAMPLE-channel.md` | Workspace-relative path to channel/group template |

## Critical: File Naming & Format

⚠️ **The hook is strict about naming conventions and frontmatter format. Deviations will silently fail (no crash, but no injection).**

### File Naming Convention

Files MUST follow `<channel>-<id>.md`, derived from the session key:

```
Session key: agent:mainelobster:telegram:group:-1003813189624
                                ^^^^^^^^       ^^^^^^^^^^^^^^
                                channel        id

Contact file: memory/contacts/telegram-6566057320.md
Group file:   memory/groups/telegram--1003813189624.md
                            ^^^^^^^^^^^^^^^^^^^^^^^^
                            channel + "-" + id (negative IDs produce double dash)
```

**Common gotcha:** Telegram group IDs are negative numbers (e.g., `-1003813189624`), so the filename has a double dash: `telegram--1003813189624.md`. This is correct — don't "fix" it.

### Group File Frontmatter — Members Format

The `members` key must be a YAML list of ID strings in the frontmatter block:

```yaml
---
id: "telegram:-1003813189624"
name: "My Group"
type: "group"

members:
  - "6566057320"
  - "123456"
  - "789012"
---
```

**Rules:**
- Each entry is just a sender ID (string or number — both work)
- No names, roles, paths, or other metadata needed — the hook derives file paths from the ID + channel
- The `members:` key must be inside the `---` frontmatter block, not in the markdown body
- If `members:` is missing, the hook returns an empty list (no crash, just no member profiles injected)
- If `autoRoster: true`, new senders are appended automatically on `message:received`

**❌ Wrong formats (will not parse):**
```yaml
# Inline array — not supported
members: ["6566057320", "123456"]

# Objects — not supported
members:
  - id: "6566057320"
    name: "JPop"

# In markdown body — ignored by the hook
## Members
| Name | ID |
|------|----|
| JPop | 6566057320 |
```

**✅ Correct format:**
```yaml
members:
  - "6566057320"
  - "123456"
```

### Contact File Naming

Contact files follow `<channel>-<id>.md`:

```
memory/contacts/telegram-6566057320.md    ✅
memory/contacts/telegram-123456.md        ✅
memory/contacts/tg-6566057320.md          ❌ (wrong channel prefix)
memory/contacts/jpop.md                   ❌ (no channel-id pattern)
```

The channel prefix must match exactly what appears in the session key (typically `telegram`, `discord`, `signal`, etc.).

## How Injection Shows Up

After bootstrap, check `/context` or `/status` to verify injection:

| Chat type | Injected file names |
|-----------|-------------------|
| DM | `CONTACT_PROFILE.md` |
| Group | `CHANNEL_PROFILE.md` + `MEMBER_PROFILE_<id>.md` per member |

Example `/context` output for a group with 2 members:
```
• CHANNEL_PROFILE.md: OK | raw 1,075 chars
• MEMBER_PROFILE_6566057320.md: OK | raw 5,200 chars
• MEMBER_PROFILE_123456.md: OK | raw 2,100 chars
```

## Installation

1. Place in `<workspace>/hooks/profile-injector/` or `~/.openclaw/hooks/profile-injector/`.
2. Compile: `npx esbuild handler.ts --bundle --platform=node --format=esm --outfile=handler.js --external:node:fs --external:node:path`
3. Copy compiled files to managed dir: `cp handler.js HOOK.md ~/.openclaw/hooks/profile-injector/`
4. Enable: `openclaw hooks enable profile-injector`
5. Restart OpenClaw.

## Troubleshooting

### Profile not injected (silent failure)

The hook never crashes — it silently skips files it can't find or parse. Check:

1. **File exists?** Verify the exact path: `ls memory/contacts/telegram-<id>.md` or `memory/groups/telegram-<groupid>.md`
2. **Filename correct?** Must be `<channel>-<id>.md`. Double-dash for negative group IDs is normal.
3. **Frontmatter valid?** `members:` must be inside `---` block, each entry on its own `- "id"` line.
4. **`groupInclusion.enabled`?** Must be `true` in config for member profiles to inject in groups.
5. **Hook loaded?** Run `openclaw hooks list` — should show `👤 profile-injector ✓ ready`.
6. **Gateway restarted?** Hook changes require a gateway restart to take effect.

### Auto-roster not adding members

- `autoRoster` defaults to `true`, but check config for `autoRoster: false`
- Group file must already exist (auto-roster doesn't create group files, only `createOnMiss` at bootstrap does)
- The `message:received` event must include `metadata.senderId` — verify your channel provides this
- Chat type (group vs DM) is derived from `event.sessionKey`, not metadata — if the session key format is wrong, auto-roster won't detect groups
- **Group must be configured in `channels.telegram.groups`** — unconfigured groups default to `requireMention: true`, and unmentioned messages are dropped *before* `message:received` fires. The hook also fires on `command:new` for rostering on `/new`.
- `message:received` only fires for messages that pass the mention gate — if `requireMention: true` and the bot wasn't @-mentioned, the message never reaches dispatch and the hook never runs (unless `ingest: true` is set on the group)

### Known OpenClaw event context limitations

`message:received` events provide a **lean context** compared to `agent:bootstrap`:

| Field | `agent:bootstrap` | `message:received` |
|-------|-------------------|--------------------|
| Field | `agent:bootstrap` | `message:received` | `command:new` |
|-------|-------------------|--------------------|---------------|
| `context.cfg` | ✅ | ❌ (not provided) | ✅ |
| `context.workspaceDir` | ✅ | ❌ (not provided) | ❌ |
| `context.bootstrapFiles` | ✅ (mutable) | ❌ | ❌ |
| `context.metadata.chatType` | n/a | ❌ (not provided) | n/a |
| `context.metadata.senderId` | n/a | ✅ | n/a |
| `context.senderId` | n/a | n/a | ✅ |
| `event.sessionKey` | ✅ | ✅ | ✅ |

The hook handles this by:
- Deriving chat type and group ID from `event.sessionKey` (not metadata)
- Reading `workspace.dir` from `~/.openclaw/openclaw.json` when `cfg` is unavailable, falling back to `~/.openclaw/workspace`
- Reading hook config from `~/.openclaw/openclaw.json` directly when `cfg` is unavailable

> ⚠️ **`process.cwd()` is NOT the workspace dir.** The gateway's cwd is typically `/root` (or the user's home). Do not rely on it for workspace path resolution.

### Gateway crash on restart

SIGUSR1 hot-reload can occasionally crash the gateway if issued during active session processing. If `/new` stops responding after a hook deploy:
- Check if gateway is running: `pgrep openclaw-gateway`
- If dead, it should auto-restart (check with `ps aux | grep openclaw`)
- Messages sent during the crash window (~5 seconds) are lost

### Large member profiles bloating context

Each injected member profile counts against `bootstrapMaxChars` / `bootstrapTotalMaxChars`. For groups with many members or large contact files:
- Use `profileDepth: "small"` (15 lines) or `"medium"` (40 lines) to cap size
- Reduce `maxContacts` to limit how many profiles are injected
- Increase `agents.defaults.bootstrapMaxChars` if truncation warnings appear

### Template files not found

If `createOnMiss: true` but templates don't exist, the hook falls back to a minimal auto-generated profile. To use custom templates:
- Place `_EXAMPLE-contact.md` in `memory/contacts/`
- Place `_EXAMPLE-channel.md` in `memory/groups/`
- Or set custom paths via `contactTemplate` / `channelTemplate` in config
