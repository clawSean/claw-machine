---
name: profile-injector
description: "Injects canonical contact and room profiles with bounded cross-channel identity resolution and auto-roster."
metadata:
  { "openclaw": { "emoji": "👤", "events": ["agent:bootstrap", "message:received", "command:new"] } }
---

# Profile Injector v4

Injects deterministic social context before the system prompt is finalized and
keeps group membership frontmatter synchronized.

## Event Behavior

### `agent:bootstrap`

- Parses `agent:<agentId>:<channel>:<type>:<id>`.
- Direct conversations resolve one canonical contact profile and inject it as
  `CONTACT_PROFILE.md`.
- Groups inject their exact room profile as `CHANNEL_PROFILE.md`, parse its
  `members:` list, then resolve each member through the same contact index.
- Member files are deduplicated by canonical path and bounded by count, depth,
  and aggregate characters.

### `message:received` and `command:new`

- For a group/channel session, add the sender to the room's `members:` list.
- Serialize mutations per room and replace the file atomically.
- If `createOnMiss` is enabled, resolve aliases before creating a contact so an
  existing canonical profile does not gain a duplicate channel file.
- Cache the fallback `openclaw.json` parse for one second because
  `message:received` normally does not include `cfg`.

## Contact Identity Contract

```yaml
---
id: "telegram:123"
identities:
  - "telegram:123"
  - "imessage:+12065550100"
  - "sms:+12065550100"
  - "slack:U01234567"
---
```

Rules:

1. Only explicit `channel:id` claims participate.
2. Legacy `id:` remains an alias.
3. Phone-like `+E.164` values get punctuation/spacing normalization; iMessage
   emails and Twitter handles get case normalization.
4. Names and prose never participate.
5. Duplicate claims fail closed; exact-path fallback is not allowed to bypass a
   known collision.
6. `session.identityLinks` is intentionally not read or changed.
7. Provider IDs that are account/workspace-scoped must be unique in this
   contact set because the bootstrap session key has no separate account scope.

## Resolution and Cache

1. Lazily scan non-template Markdown files in the contact directory.
2. Build `normalized identity -> canonical file` plus a collision map.
3. Watch the directory and invalidate on edits.
4. Rebuild after `cacheTtlMs` even without an event.
5. Reuse the same map for all members in a group bootstrap.
6. If the bounded index cannot build, log once and retain legacy exact lookup.

The index is process-memory only. Contact Markdown remains the single persisted
source of truth.

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

Defaults:

| Setting | Default |
|---|---:|
| `createOnMiss` | `false` |
| `autoRoster` | `true` |
| `contactDir` | `memory/contacts` |
| `groupDir` | `memory/groups` |
| `identityResolution.enabled` | `true` |
| `identityResolution.cacheTtlMs` | `60000` |
| `identityResolution.maxFiles` | `1000` |
| `identityResolution.scanConcurrency` | `4` |
| `groupInclusion.enabled` | `false` |
| `groupInclusion.maxContacts` | `10` |
| `groupInclusion.profileDepth` | `full` |
| `groupInclusion.maxTotalChars` | `30000` |

All configurable file/directory paths are workspace-relative and are contained
to the workspace. Unsafe paths fall back to the documented defaults and log
once.

## Profile Creation

`createOnMiss` checks the alias map and exact path before writing. Template
placeholders are rendered:

- `<channel>`, `<user_id>`, `<group_id>`
- `<channel>:<user_id>`, `<channel>:<group_id>`
- `<Name>`, `YYYY-MM-DD`

New contact profiles always gain an `identities:` list even when an older
template does not include one. Writes use exclusive create semantics to avoid
races.

## Group Roster Contract

```yaml
members:
  - "123456789"
  - "U01234567"
  - "+12065550100"
```

Block lists and inline JSON arrays are accepted. Auto-roster writes the block
form. Sender IDs must be bounded, nonempty, and path-safe.

## Operational Verification

Before deployment:

```bash
npm test
npm run audit -- /path/to/workspace/memory/contacts
npm run benchmark -- /path/to/workspace/memory/contacts 100
```

After installing `handler.js` and `HOOK.md`, a full Gateway restart is required
to import the new handler. Follow the operator's approval and rollback policy.

Prove:

1. legacy exact-path DM;
2. aliased cross-channel DM;
3. group room plus aliased member profile;
4. collision refusal;
5. create-on-miss placeholder rendering;
6. auto-roster under concurrent inbound events;
7. cache rebuild after an alias edit.

## Failure Posture

- Invalid session IDs or paths: skip.
- Identity collision: log and inject no contact for that identity.
- Index error/limit: log once and use legacy exact lookup.
- Unreadable individual profile: log and skip it.
- Missing group file: do not auto-roster; bootstrap may create it only when
  `createOnMiss` is enabled.
- No fuzzy fallback under any failure mode.
