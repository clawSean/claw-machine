---
name: profile-injector
description: "Automatically injects contact and channel profile files into session context based on deterministic session identifiers."
metadata:
  { "openclaw": { "emoji": "👤", "events": ["agent:bootstrap"] } }
---

# Profile Injector

This hook listens for the `agent:bootstrap` event and automatically injects relevant profile files from your `memory/` directory into the agent's context.

## What It Does

1. Parses the `sessionKey` to determine the channel, chat type, and ID.
2. Looks for matching profile files in:
   - `memory/contacts/<channel>-<id>.md` (for direct chats)
   - `memory/groups/<channel>-<id>.md` (for group chats)
3. If a file exists, it is injected as a bootstrap file (e.g., `CONTACT_PROFILE.md`), making it immediately available in the agent's project context.
4. (Optional) Can create new profile files from templates when they don't exist.

## Configuration

You can configure this hook in your `openclaw.json` under `hooks.internal.entries.profile-injector`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "profile-injector": {
          "enabled": true,
          "createOnMiss": false,
          "contactTemplate": "memory/contacts/_EXAMPLE-contact.md",
          "channelTemplate": "memory/groups/_EXAMPLE-channel.md"
        }
      }
    }
  }
}
```

- **`createOnMiss`**: If `true`, creates a new profile file from a template if none is found. (Default: `false`)
- **`contactTemplate`**: Workspace-relative path to the contact profile template.
- **`channelTemplate`**: Workspace-relative path to the channel profile template.

## Benefits

- **Automatic Context**: You no longer need to manually read a user's profile at the start of a session.
- **Persistent**: Survives OpenClaw updates.
- **Low Overhead**: Files are only injected when a session bootstraps.

## Installation

1. Create the directory: `hooks/profile-injector/`.
2. Enable it: `openclaw hooks enable profile-injector`.
3. Restart OpenClaw.
