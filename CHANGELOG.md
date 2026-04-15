# Changelog

## v3 — Frontmatter-Based Member Roster with Auto-Sync

*2026-04-15 — commit `297890e`*

Complete rewrite of the profile-injector hook. Replaces v2's markdown table + transcript scanning with frontmatter `members:` lists and auto-sync across three event types.

### What Changed

- **Frontmatter is source of truth.** Group membership is a flat YAML list of sender IDs in the `---` block. Markdown tables in the body are optional decoration.
- **Zero external deps.** Removed `yaml` package (270kb). Hand-parse `- "id"` lines instead. Final bundle: ~11kb.
- **Three events** instead of one: `command:new` → `agent:bootstrap` → `message:received`.
- **Auto-roster** adds new senders to the group file automatically on both regular messages and `/new` commands.

### Bugs Found During Development

These were squashed into the v3 commit but are documented here for regression context:

#### 1. `metadata.chatType` does not exist in `message:received`

OpenClaw's `toInternalMessageReceivedContext` maps `from`, `content`, `metadata` (with `senderId`, `senderName`, etc.) but **never** includes `chatType`. This is true on all OpenClaw installs, not a config issue.

**Fix:** Parse `event.sessionKey` (format `agent:agentId:channel:type:id`) to derive chat type, channel, and group ID.

**Regression signal:** Auto-roster silently does nothing for group messages. No error, no log. The `chatType` guard returns early.

#### 2. `cfg` is not provided in `message:received` events

`agent:bootstrap` gets full `cfg` (config object). `message:received` only gets `from`, `content`, `timestamp`, `channelId`, `accountId`, `conversationId`, `messageId`, `metadata`. No `cfg`, no `workspaceDir`, no `bootstrapFiles`.

**Fix:** `resolveHookConfig()` reads `~/.openclaw/openclaw.json` directly when `cfg` is unavailable.

**Regression signal:** Auto-roster silently does nothing (hookConfig defaults to `{}`, workspaceDir is undefined → early return).

#### 3. `process.cwd()` is `/root`, NOT the workspace dir

The gateway process runs with cwd `/root`. Earlier assumption that it was `/root/.openclaw/workspace` was wrong. Any hook using `process.cwd()` as a workspace fallback will resolve file paths incorrectly.

**Fix:** `resolveWorkspaceDir()` reads `workspace.dir` from `openclaw.json`, falls back to `~/.openclaw/workspace`. Never uses `process.cwd()`.

**Regression signal:** Hook logs `group file not found` or silently bails. Debug by checking the resolved `groupFilePath` — if it starts with `/root/memory/` instead of `/root/.openclaw/workspace/memory/`, this is the bug.

#### 4. Chicken-and-egg: `/new` triggers bootstrap before auto-roster

The original design only rostered on `message:received`. But `/new` is a command, not a message — it triggers `command:new` → `agent:bootstrap`. By the time bootstrap reads the group file, no roster update has happened yet.

**Fix:** Added `command:new` as a third event. It runs auto-roster *before* bootstrap fires, using `event.context.senderId` (which `command:new` provides, unlike `message:received` where it's in `metadata`).

**Regression signal:** Profile injection works on second `/new` but not first. Members list is always one session behind.

### Event Context Reference

| Field | `agent:bootstrap` | `message:received` | `command:new` |
|-------|-------------------|--------------------|---------------|
| `context.cfg` | ✅ | ❌ | ✅ |
| `context.workspaceDir` | ✅ | ❌ | ❌ |
| `context.bootstrapFiles` | ✅ (mutable) | ❌ | ❌ |
| `context.metadata.chatType` | n/a | ❌ | n/a |
| `context.metadata.senderId` | n/a | ✅ | n/a |
| `context.senderId` | n/a | n/a | ✅ |
| `event.sessionKey` | ✅ | ✅ | ✅ |

### Operational Notes

- **SIGUSR1 does NOT reload ES module imports.** After editing `handler.js`, a full `openclaw gateway stop` + `start` is required. SIGUSR1 only hot-reloads config.
- **`requireMention` defaults to `true`** for groups not explicitly in `channels.telegram.groups`. Unmentioned messages are dropped *before* `message:received` fires — the hook never sees them.
- **Telegram group IDs are negative**, producing double-dash filenames like `telegram--1003813189624.md`. This is correct.
