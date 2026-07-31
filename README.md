# 🦞 Claw Machine

Drop a coin, grab the right profile.

Claw Machine is an [OpenClaw](https://openclaw.ai) internal hook that injects
human-readable contact and room profiles into agent bootstrap context. Version 4
lets one person keep one canonical profile across Telegram, iMessage, SMS,
Slack, Discord, and other explicit channel identities.

It is intentionally local and boring: Markdown files, exact IDs, one small
in-memory index, no database, no LLM lookup, and no fuzzy identity matching.

## What It Injects

| Conversation | Bootstrap context |
|---|---|
| Direct message | `CONTACT_PROFILE.md` from the resolved canonical contact file |
| Group/channel | `CHANNEL_PROFILE.md` plus bounded member contact profiles |

Group frontmatter keeps a flat `members:` roster. The hook auto-adds senders on
`message:received` and `command:new`, then resolves every member through the
same contact index used for DMs.

## One Person, Multiple Channels

Choose one canonical contact file and list only identities you have verified:

```yaml
---
id: "telegram:123456789"
identities:
  - "telegram:123456789"
  - "imessage:+12065550100"
  - "sms:+12065550100"
  - "slack:U01234567"
name: "Example Person"
---
```

Lookup order:

1. Normalize the incoming `channel:id` without changing channels or guessing.
2. Resolve it through `identities:` plus the legacy scalar `id:`.
3. If two files claim it, refuse to inject either and log the collision.
4. If no alias claims it, fall back to the legacy exact filename
   `memory/contacts/<channel>-<id>.md`.
5. Create a new exact-path profile only after both lookup paths miss.

Names, usernames, phone similarity, and profile prose are never used to merge
people. `session.identityLinks` is also deliberately separate: it changes
OpenClaw session routing, while Claw Machine changes only profile resolution.
Provider IDs that are workspace/account-scoped must be unique in this contact
set; current bootstrap session keys do not expose a separate account scope.

## Performance Model

The contact directory is scanned once on the first lookup. The resulting
`Map<identity, canonical-file>` is:

- reused by every DM and every member in a group bootstrap;
- invalidated when the contact directory changes;
- rebuilt after a TTL as a self-healing fallback for missed filesystem events;
- bounded by `identityResolution.maxFiles`;
- stored only in memory, never as a second persisted source of truth.

Warm identity resolution is an in-memory map lookup plus the same one profile
read the legacy hook already needed. Group member context also has a separate
character budget so a large roster cannot consume the entire bootstrap budget.

Run the included benchmark against a real workspace:

```bash
npm run benchmark -- /path/to/workspace/memory/contacts 100
```

## Install

Requires Node.js `>=22.13` and an OpenClaw version with `agent:bootstrap`
internal hooks.

```bash
git clone https://github.com/clawSean/claw-machine.git
cd claw-machine
bash install.sh
```

The installer runs the tests, builds `handler.js` with Node's built-in
TypeScript transformer, and copies `handler.js` plus `HOOK.md` into
`~/.openclaw/hooks/profile-injector/`.

Then enable the hook and restart OpenClaw according to your operator approval
and rollback policy:

```bash
openclaw hooks enable profile-injector
openclaw gateway restart
```

Hook code is loaded at Gateway start; a config hot reload does not replace the
already-imported handler module.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "profile-injector": {
          "enabled": true,
          "createOnMiss": false,
          "autoRoster": true,
          "contactDir": "memory/contacts",
          "groupDir": "memory/groups",
          "contactTemplate": "memory/contacts/_EXAMPLE-contact.md",
          "channelTemplate": "memory/groups/_EXAMPLE-channel.md",
          "identityResolution": {
            "enabled": true,
            "cacheTtlMs": 60000,
            "maxFiles": 1000,
            "scanConcurrency": 4
          },
          "groupInclusion": {
            "enabled": true,
            "maxContacts": 10,
            "profileDepth": "full",
            "maxTotalChars": 30000
          }
        }
      }
    }
  }
}
```

| Option | Default | Purpose |
|---|---:|---|
| `createOnMiss` | `false` | Create a rendered profile only after alias and exact lookup miss |
| `autoRoster` | `true` | Serialize and atomically persist new group senders |
| `contactDir` | `memory/contacts` | Workspace-relative canonical contact directory |
| `groupDir` | `memory/groups` | Workspace-relative room-profile directory |
| `identityResolution.enabled` | `true` | Enable frontmatter alias resolution |
| `identityResolution.cacheTtlMs` | `60000` | Maximum cache age; filesystem edits invalidate sooner |
| `identityResolution.maxFiles` | `1000` | Fail-safe scan bound; exact lookup remains available on index failure |
| `identityResolution.scanConcurrency` | `4` | Bounded parallel reads while rebuilding the tiny index |
| `groupInclusion.enabled` | `false` | Inject rostered member profiles |
| `groupInclusion.maxContacts` | `10` | Maximum roster entries considered per bootstrap |
| `groupInclusion.profileDepth` | `full` | `full`, `medium` (40 lines), or `small` (15 lines) |
| `groupInclusion.maxTotalChars` | `30000` | Aggregate character cap for member profiles only |

Configured directories and templates must remain inside the workspace.

## Group Roster Format

Block lists and inline JSON arrays are accepted. IDs may be numeric or
platform-native strings such as Slack IDs, phone handles, and emails.

```yaml
---
id: "slack:C01234567"
members:
  - "U01234567"
  - "U07654321"
---
```

Auto-roster writes are serialized per room and replaced atomically, preventing
concurrent inbound messages from losing each other's IDs.

## Safe Migration

Audit before adding aliases:

```bash
npm run audit -- /path/to/workspace/memory/contacts
```

Then, per real person:

1. Pick the canonical file after reviewing every duplicate's facts and trust.
2. Merge only verified facts into it.
3. Add every verified `channel:id` to `identities:`.
4. Remove or archive duplicate live profiles; do not leave two claimants.
5. Re-run the audit until `explicitIdentityCollisions` is empty.
6. Deploy with rollback ready, restart, and prove both DM and group-member paths.

Do not bulk-merge from names or usernames. A wrong alias can inject another
person's private memory and authority posture; a collision is safer than a
guess.

## Development

```bash
npm test
npm run audit -- /path/to/contacts
npm run benchmark -- /path/to/contacts 100
```

The project has no runtime dependency. Small ordered modules under `src/` are
the canonical source; `handler.js` is generated and committed for managed-hook
installs.

## Troubleshooting

- Run `openclaw hooks check` and `openclaw hooks info profile-injector`.
- Check logs for `Identity collision`; the listed files must be reconciled.
- Confirm aliases use exact `channel:id` values from OpenClaw session keys.
- Confirm configured paths stay inside the workspace.
- If aliases were edited, the watcher should invalidate immediately; the TTL
  guarantees a later rebuild even if the platform misses the event.
- If group context is large, lower `maxContacts`, `profileDepth`, or
  `maxTotalChars` before raising OpenClaw's global bootstrap budget.

## License

MIT — grab it, use it, claw away.
