# 🦞 Claw Machine

Drop a coin, grab a profile.

An [OpenClaw](https://openclaw.ai) hook that automatically injects contact and group profile files into agent context at bootstrap — so your agent already knows who it's talking to before the conversation starts. No more "who are you again?" every session.

## ⚙️ How It Works

When a session bootstraps, the hook parses the `sessionKey` to determine the channel, chat type, and user/group ID, then looks for a matching profile file in your workspace:

| Chat type | Lookup path | Injected as |
|-----------|------------|-------------|
| Direct message | `memory/contacts/<channel>-<id>.md` | `CONTACT_PROFILE.md` |
| Group / channel | `memory/groups/<channel>-<id>.md` | `CHANNEL_PROFILE.md` |

If the file exists, its contents are injected into the agent's bootstrap context automatically.

### 👥 Group Social Awareness

When `groupInclusion` is enabled, the hook also scans the session transcript for recent sender IDs and injects their contact profiles (capped and truncated) alongside the group profile. Your agent walks into every group chat knowing the room.

## 📦 Install

```bash
openclaw hooks install claw-machine
```

Or clone and link locally:

```bash
git clone https://github.com/clawSean/claw-machine.git
openclaw hooks install -l ./claw-machine
```

Then enable it:

```bash
openclaw hooks enable profile-injector
```

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
          "contactTemplate": "memory/contacts/_EXAMPLE-contact.md",
          "channelTemplate": "memory/groups/_EXAMPLE-channel.md",
          "groupInclusion": {
            "enabled": false,
            "maxContacts": 3,
            "profileDepth": "small"
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
| `contactTemplate` | `string` | `memory/contacts/_EXAMPLE-contact.md` | Workspace-relative path to contact template |
| `channelTemplate` | `string` | `memory/groups/_EXAMPLE-channel.md` | Workspace-relative path to group template |
| `groupInclusion.enabled` | `boolean` | `false` | Inject profiles of recent group participants |
| `groupInclusion.maxContacts` | `number` | `3` | Max participant profiles to inject per group session |
| `groupInclusion.profileDepth` | `string` | `"small"` | How much of each profile to inject: `"small"` (15 lines), `"medium"` (40 lines), or `"full"` |

## 📂 Expected Directory Structure

The hook expects profile markdown files in your workspace's `memory/` directory:

```
<workspace>/
└── memory/
    ├── contacts/
    │   ├── telegram-123456.md
    │   ├── discord-789012.md
    │   └── _EXAMPLE-contact.md    # template (optional)
    └── groups/
        ├── telegram--1003707644960.md
        ├── discord-456789.md
        └── _EXAMPLE-channel.md    # template (optional)
```

File naming follows the pattern `<channel>-<id>.md`, derived from the session key.

## 📄 License

MIT — grab it, use it, claw away.
