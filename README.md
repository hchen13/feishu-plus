# Feishu Plus

English | [中文](./README.cn.md)

OpenClaw already ships with a bundled Feishu plugin. Use the bundled plugin if you only need standard message delivery, baseline routing, and the default Feishu tool surface. `feishu-plus` exists for deployments that outgrew that baseline.

Our actual deployment needed three things the bundled path did not give us cleanly enough: shared context across multiple agents inside the same group chat, much stronger long-markdown delivery for Feishu, and deeper spreadsheet / bitable workflows. This repository keeps the upstream Feishu foundation, backports newer bundled changes from [`openclaw/openclaw`](https://github.com/openclaw/openclaw), and layers on the production behavior that motivated the fork in the first place.

Two additions define this fork:

**GroupSense** is a context-enhancement layer for multi-agent group chats. It lets you `@` one agent and continue a discussion that another agent was already part of, without manually replaying the whole conversation. The plugin achieves that by combining milestone summaries with recent raw group history and injecting both back into later prompts.

**Command Control** is a group-based permission system for slash commands. In multi-user enterprise deployments, not everyone should be able to run every command — `/model` and `/think` should probably be off-limits for general staff, while admins and power users get full access. Command Control lets you define user groups that map directly to your org structure, assign each group an allowlist, denylist, or full access, and have the rules take effect on save without a gateway restart.

This repository is also derived from [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu), which remains part of the project lineage.

This distribution is **Feishu-only**. Some inherited source files still use `Lark` naming because the official SDK package is `@larksuiteoapi/node-sdk`, but Lark is not a supported target here.

## Why Not Just Use The Bundled Plugin?

| Need | Bundled Feishu | `feishu-plus` |
| --- | --- | --- |
| Standard Feishu channel integration | Yes | Yes |
| Shared context across multiple agents in one group | No | Yes |
| Milestone summaries + recent group history injection | No | Yes |
| Long-markdown delivery tuned for Feishu-heavy usage | Baseline | Yes |
| Sheet workflow as a first-class tool surface | No | Yes |
| Expanded bitable field / record operations | Partial | Yes |
| Group-based slash command permissions | No | Yes |

## What Feishu Plus Adds

- **GroupSense**. Multi-agent group chats become materially more natural because later prompts can see milestone summaries and recent raw group history, not just the latest `@mention`.
- **Milestone-aware prompting**. Group discussion windows are periodically summarized and stored under `~/.openclaw/shared-knowledge/feishu-group-milestones`.
- **Long-form reply delivery**. `textChunkLimit`, card rendering, and Feishu-specific reply behavior are tuned for large markdown outputs.
- **Dedicated sheet tooling**. This fork ships a full sheet workflow instead of treating spreadsheets as a side case.
- **Expanded bitable tooling**. The bitable surface covers metadata, fields, records, and batch deletion in a way that fits real operations.
- **Retained upstream tooling**. Doc, wiki, drive, chat, app-scope diagnostics, and other bundled Feishu capabilities are still here.
- **Group-based command control**. Slash command permissions can be restricted per user group. Each group chooses an allowlist, denylist, or full access. Groups are user-defined and can reflect existing org structure.

## Requirements

- OpenClaw `>= 2026.3.13`
- Node.js `>= 20`
- One or more Feishu self-built apps
- If you enable `milestoneContext`: a host OpenClaw instance with a reachable local gateway and a headless agent whose id is exactly `summarizer`

## Installation

### Local path

```bash
git clone https://github.com/hchen13/feishu-plus.git
cd feishu-plus
npm install
openclaw plugins install /absolute/path/to/feishu-plus
```

### GitHub install spec

```bash
openclaw plugins install github:hchen13/feishu-plus
```

### Direct config loading

```json
{
  "plugins": {
    "allow": ["feishu-plus"],
    "load": {
      "paths": ["/absolute/path/to/feishu-plus"]
    },
    "entries": {
      "feishu-plus": {
        "enabled": true
      }
    }
  }
}
```

## Minimal Configuration

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "connectionMode": "websocket",
      "renderMode": "auto",
      "textChunkLimit": 30000,
      "milestoneContext": {
        "enabled": false
      },
      "accounts": {
        "xinge": {
          "enabled": true,
          "appId": "cli_xxxxx",
          "appSecret": "xxxx",
          "dmPolicy": "open",
          "groupPolicy": "open",
          "requireMention": true,
          "chunkMode": "length",
          "textChunkLimit": 30000,
          "streaming": true
        }
      }
    }
  }
}
```

Single-account deployments can often stop there. Multi-account deployments should also add explicit Feishu `accountId` bindings for each agent that will use Feishu tools.

## Bind Agents To Feishu Accounts

For multi-account setups, bind each agent to exactly one Feishu `accountId` at the OpenClaw level:

```json
{
  "bindings": [
    {
      "agentId": "xinge",
      "match": {
        "channel": "feishu",
        "accountId": "xinge"
      }
    },
    {
      "agentId": "laok",
      "match": {
        "channel": "feishu",
        "accountId": "laok"
      }
    }
  ]
}
```

Why this matters:

- Inbound message routing already knows which Feishu account delivered the event.
- Tool execution also needs an unambiguous Feishu identity.
- This plugin will refuse ambiguous tool-account routing instead of silently guessing.

If an agent has multiple Feishu bindings, they should still resolve to a single `accountId`. Otherwise the tool layer will raise an explicit routing error.

## Feishu App Setup

### Recommended baseline scopes

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`
- `contact:user.base:readonly`

`contact:user.base:readonly` matters because `resolveSenderNames` is enabled by default. Without it, message delivery still works, but sender-name lookup may fail and the agent may surface a permission-grant notice back to the user.

### Optional scopes by feature

Grant only what your deployment actually uses:

- `docx:document` or `docx:document:readonly`
- `docx:document.block:convert`
- `drive:drive` or `drive:drive:readonly`
- `wiki:wiki` or `wiki:wiki:readonly`
- `bitable:app` or `bitable:app:readonly`
- `sheets:spreadsheet` or `sheets:spreadsheet:readonly`
- `task:task:read` or `task:task:write`
- `drive:permission` if you enable `perm`
- `im:message:update` if you rely on message/card patch flows outside the normal reply pipeline

### Streaming card permission

If you enable account-level `streaming: true`, also grant:

- `cardkit:card:write`

This is the exact permission used by the streaming-card path. The plugin creates a Card Kit card entity through `/cardkit/v1/cards` and then updates that card as text arrives.

Important distinction:

- Regular interactive markdown cards can still be sent through the standard Feishu message API.
- **Streaming cards are different.** They use the Card Kit entity API, so `streaming: true` is not only a UI toggle. It is a separate permission path.

If the permission is missing, the typical runtime symptom is a log like:

`Create card failed: Access denied ... [cardkit:card:write]`

### Event subscriptions

Minimum:

- `im.message.receive_v1`
- `im.chat.member.bot.added_v1`
- `im.chat.member.bot.deleted_v1`

Enable these when you use the corresponding features:

- `im.message.reaction.created_v1` if `reactionNotifications` is not `off`
- `card.action.trigger` if your deployment uses interactive card actions as input

Transport-specific setup:

- `connectionMode: "websocket"`: configure **Long connection**
- `connectionMode: "webhook"`: configure **Request URL**, `verificationToken`, and `encryptKey`

The webhook path is hardened in code: signature validation, body limits, content-type checks, and rate limiting are all enforced.

### Resource sharing still matters

API scopes alone are not enough. The bot must also be added to or shared on the actual resource:

- docs
- wiki spaces
- drive folders and files
- bitables
- sheets

If authentication succeeds but results are empty, or permission errors persist, check sharing before debugging plugin logic.

### Multi-app reminder

`open_id` is app-scoped in Feishu. The same human will have different `open_id` values under different Feishu apps. Do not reuse an `open_id` captured from app A when operating through app B.

## Introducing GroupSense

**GroupSense** is the public name for this fork's context-enhancement layer for multi-agent group chats.

Operationally, it does four things:

1. Records recent group turns per chat.
2. Periodically summarizes a discussion window into milestones.
3. Stores those milestones under `~/.openclaw/shared-knowledge/feishu-group-milestones`.
4. Injects milestone summaries plus recent raw group history back into later prompts.

The resulting user experience is straightforward: one agent can respond with immediate context about what another agent recently argued, decided, or promised, so the group feels less like isolated bots and more like a coherent team conversation.

### GroupSense is not self-contained

`milestoneContext` is implemented inside this plugin, but the summarization step depends on the host OpenClaw runtime:

- it dynamically resolves an internal gateway helper
- it calls `agent`, `agent.wait`, `chat.history`, and `sessions.delete`
- it expects a headless agent whose id is exactly `summarizer`

If that host-side contract is missing, the plugin falls back to a regex summarizer. The feature still runs, but summary quality is materially worse.

### Host-side summarizer contract

Add a headless agent like this to `openclaw.json`:

```json
{
  "id": "summarizer",
  "name": "Summarizer",
  "workspace": "/Users/you/.openclaw/agents/summarizer",
  "model": {
    "primary": "zhipu-coding/GLM-5"
  },
  "skills": [],
  "subagents": {
    "allowAgents": []
  }
}
```

The recommended workspace template is:

- [`docs/summarizer/AGENTS.md`](./docs/summarizer/AGENTS.md)

Copy it into the summarizer agent's workspace directory. No `BOOTSTRAP.md` is needed — the summarizer is a headless extraction endpoint, not a user-facing agent.

Guidelines:

- Keep this agent headless. Do not bind it to Feishu or any other chat channel.
- Keep the workspace contract narrow: JSON extraction only, no personality, no side workflows.
- The `AGENTS.md` contract includes strict length limits (20–40 characters per item, never exceeding 60) to ensure milestones stay concise and fit cleanly into later prompts.

## Reply Delivery And Long Markdown

- `textChunkLimit` is the main knob for keeping a long markdown reply inside a single Feishu message or card.
- `chunkMode` only matters after the chunk limit is exceeded.
- `renderMode: "raw"` keeps replies in the plain message path.
- `renderMode: "auto"` is intentionally conservative. In current code it mainly upgrades replies to cards when content clearly looks like code blocks or markdown tables.
- `renderMode: "card"` always uses interactive markdown cards and gives the clearest streaming-card behavior.
- `streaming: true` enables the Feishu Card Kit streaming path for that account. It does **not** guarantee a smooth typewriter effect by itself; visible smoothness still depends on how often upstream partial text arrives.
- This fork explicitly sets `disableBlockStreaming: true` for Feishu replies so OpenClaw block flushes do not prematurely close the streaming card.

Practical reading:

- If your priority is **long markdown integrity**, start with `textChunkLimit`.
- If your priority is **visible streaming-card UX**, tune `renderMode` and upstream partial cadence first.

## Group Routing And Operator Knobs

These options matter in real deployments and are worth understanding:

- `requireMention`: whether group replies require an explicit `@bot`
- `groupPolicy` / `groupAllowFrom`: whether the group itself is allowed
- `groupSenderAllowFrom`: optional sender-level allowlist inside allowed groups
- `groupSessionScope`: how group sessions are isolated
- `replyInThread`: whether replies should create or continue Feishu topic threads
- `reactionNotifications`: whether reactions become synthetic inbound messages
- `typingIndicator`: whether the bot adds a temporary typing reaction before replying
- `resolveSenderNames`: whether the bot resolves display names through the Feishu contact API
- `dynamicAgentCreation`: optional DM-only mode that auto-creates one agent per direct-message user

`groupSessionScope` supports:

- `group`: one session per group
- `group_sender`: one session per `(group + sender)`
- `group_topic`: one session per topic thread inside a group
- `group_topic_sender`: one session per `(group + topic + sender)`

`topicSessionMode` still exists for backward compatibility, but `groupSessionScope` is the real knob now.

## Command Control

By default, any user who can reach an agent can also run any slash command. If you need to restrict which commands different users can run, configure `commandControl` under `channels.feishu`.

### How it works

Two fields work together:

- `userGroups` — define named sets of Feishu user or department IDs once, then reference them by name anywhere
- `commandControl.groups` — ordered rules that map group membership to command permissions

When a slash command arrives, the sender is matched against the groups list top-to-bottom. The first matching group's rule applies. If no group matches, a built-in safe fallback applies: `/status`, `/new`, `/reset`, and `/compact` are permitted; all other commands are denied.

If `commandControl` is not configured, the safe defaults still apply: `/status`, `/new`, `/reset`, and `/compact` are available to all users; everything else is denied until a group rule explicitly permits it.

### Configuration

```json
"channels": {
  "feishu": {
    "userGroups": {
      "admin":  ["ou_admin1", "ou_admin2"],
      "tech":   ["ou_dept_tech_group_id"],
      "design": ["ou_dept_design_group_id"]
    },
    "commandControl": {
      "blockMessage": "You don't have permission to use this command.",
      "groups": [
        {
          "name": "admin",
          "members": ["@admin"],
          "commands": "*"
        },
        {
          "name": "tech",
          "members": ["@tech"],
          "except": ["/dangerous-command"]
        },
        {
          "name": "design",
          "members": ["@design"],
          "commands": ["/new", "/reset", "/help", "/status"]
        },
        {
          "name": "default",
          "members": ["*"],
          "commands": ["/new", "/help", "/status"]
        }
      ]
    }
  }
}
```

### Group rule modes

Each group rule uses exactly one of:

| Field | Mode | Behavior |
|-------|------|----------|
| `commands: "*"` | allow-all | All commands are permitted, including ones added by future plugins |
| `commands: [...]` | allowlist | Only the listed commands are permitted; new commands are **not** automatically allowed |
| `except: [...]` | denylist | All commands are permitted except the listed ones; new commands are **automatically allowed** |

`commands` and `except` cannot both be set on the same group — the schema rejects that config at load time.

### Members

`members` accepts:

- `@groupName` — reference a key in `userGroups`; the group is expanded to its ID list at match time
- `ou_xxx` — a raw Feishu open ID or department ID
- `"*"` — matches any sender; use as the last entry for a catch-all default rule

IDs are normalized the same way as `allowFrom` entries. The `feishu:` prefix is stripped automatically if present.

### Default behavior

If a sender is not covered by any group rule — or if `commandControl` is not configured at all — the fallback allows only `/status`, `/new`, `/reset`, and `/compact`. All other commands return the `blockMessage`.

This is the default for everyone. To give a user or group access to more commands, add an explicit group rule that covers them.

### Per-account override

`commandControl` and `userGroups` can also be set inside a specific account under `channels.feishu.accounts.<accountId>`. When present, the account-level config **fully replaces** the top-level config for that account — there is no merging of rules.

```json
"channels": {
  "feishu": {
    "userGroups": {
      "admin": ["ou_xxx"]
    },
    "commandControl": {
      "groups": [
        { "name": "admin", "members": ["@admin"], "commands": "*" },
        { "name": "default", "members": ["*"], "commands": ["/new", "/help", "/status", "/compact", "/reset"] }
      ]
    },
    "accounts": {
      "sensitive-agent": {
        "userGroups": {
          "admin": ["ou_xxx"]
        },
        "commandControl": {
          "groups": [
            { "name": "admin", "members": ["@admin"], "commands": "*" },
            { "name": "default", "members": ["*"], "commands": ["/status"] }
          ]
        }
      }
    }
  }
}
```

In this example, `sensitive-agent` only allows `/status` for non-admins, while all other agents use the top-level rules that allow four commands.

**Important:** if an account defines its own `commandControl` but not its own `userGroups`, it still inherits the top-level `userGroups` — so `@admin` references continue to resolve correctly. If an account defines its own `userGroups`, the top-level `userGroups` are no longer visible to that account.

### Block message delivery

When a command is blocked, the denial message is sent as a **direct message to the sender**, not posted to the group. This avoids broadcasting that a user attempted a restricted command.

### Hot reload

`commandControl` and `userGroups` take effect immediately on save — no gateway restart is needed.

### Open IDs are app-scoped

Feishu `open_id` values are scoped per app, not per person. A user's `open_id` under app A differs from their `open_id` under app B. Make sure the IDs you put in `userGroups` match the Feishu app that your bot accounts use.

## Tool Surface

Retained from the upstream Feishu foundation:

- `feishu_doc`
- `feishu_wiki`
- `feishu_drive`
- `feishu_chat`
- `feishu_app_scopes`

Local additions or expansions in this fork:

- `feishu_sheet`
  - `get_meta`, `read_range`, `write_range`, `append_rows`, `set_format`, `set_style`, `insert_image`, `insert_cell_image`
- expanded `feishu_bitable_*`
  - meta lookup from URL, field CRUD, record CRUD, batch delete
- `feishu_task_*`
  - create, get, update, delete

Optional sensitive tooling:

- `feishu_perm` is disabled by default because it modifies ACLs

Operational note:

- Tool execution resolves the effective Feishu identity from inbound context or agent/account bindings.
- Do not leave agent-to-account mapping ambiguous in a multi-account deployment.

Usability note:

- When creating a document, pass the requester's `owner_open_id` if you want the human requester to immediately receive access on the created doc instead of leaving it visible only to the bot app.

## Notes For AI Agents

### Understanding the command permission model

This section explains the command permission system in full, because the layered design can be non-obvious.

**Three separate concepts:**

1. **`userGroups`** — named sets of Feishu IDs. No permissions here, just names for groups of people. These exist purely so you don't repeat ID lists everywhere.

2. **`commandControl.groups`** — ordered permission rules. Each rule has `members` (who this applies to) and a command policy (`commands: "*"`, `commands: [...]`, or `except: [...]`). Rules are checked top-to-bottom; the first matching rule wins.

3. **Feishu accounts** — each Feishu app corresponds to one agent. `userGroups` and `commandControl` live at the channel level, not the agent level. There is no per-agent command permission — only per-account (i.e., per-Feishu-app).

**How a command is evaluated:**

```
User sends /model to agent X
    ↓
Which Feishu account received this message?
    ↓
Does that account have its own commandControl?
    ├─ Yes → use the account's commandControl + its userGroups (or inherited global userGroups if account has none)
    └─ No  → use the top-level commandControl + top-level userGroups
    ↓
Walk the groups list top-to-bottom. Find the first group whose members match the sender.
    ├─ Match found → apply that group's command policy
    └─ No match   → apply built-in fallback: /status /new /reset /compact only
    ↓
Allowed → message reaches the agent
Denied  → sender receives a private DM with the blockMessage; agent never sees the message
```

**Account-level override semantics:**

Account config does a **full replacement**, not a merge:
- If `accounts.X.commandControl` is set, the top-level `commandControl` is completely ignored for account X
- If `accounts.X.commandControl` is not set, account X inherits the top-level `commandControl` entirely
- `userGroups` follow the same rule independently: account-level replaces top-level if set, otherwise inherited
- Consequence: if you set `accounts.X.commandControl` but not `accounts.X.userGroups`, account X's rules can still reference `@groupName` entries from the top-level `userGroups`

**Default behavior (no configuration):**

Even with no `commandControl` configured at all, the default is **restrictive**: only `/status`, `/new`, `/reset`, and `/compact` are available to everyone. Any other command requires an explicit group rule. This is by design — deploy first, configure access second, without risk of accidental exposure.

**Feishu open_id scoping:**

A user has a different `open_id` under each Feishu app. If you need someone to be an admin across all agents (which span multiple apps), you must include all of their app-specific `open_id` values in the same `userGroups` entry.

---

If you are an AI agent helping a human operator deploy this plugin, use this order:

1. Confirm that the host runs OpenClaw `>= 2026.3.13`.
2. Decide whether the deployment is single-account or multi-account.
3. Create the Feishu self-built app(s) and collect `appId`, `appSecret`, and transport choice (`websocket` or `webhook`).
4. If transport is `webhook`, also collect `verificationToken` and `encryptKey`.
5. Write the smallest working `channels.feishu` block first. Add per-account overrides only after DM and group delivery work.
6. If the deployment wants streaming cards, grant `cardkit:card:write` before debugging UX.
7. If the deployment keeps `resolveSenderNames: true`, grant `contact:user.base:readonly`.
8. Add explicit Feishu `accountId` bindings for every agent that will use Feishu tools.
9. If `milestoneContext` is enabled, create a headless `summarizer` agent with id exactly `summarizer`, and copy [`docs/summarizer/AGENTS.md`](./docs/summarizer/AGENTS.md) into its workspace. No `BOOTSTRAP.md` is needed.
10. Verify event subscriptions before debugging message flow.
11. Test at least these cases:
    - DM round-trip
    - group `@mention`
    - one long markdown reply with headings, lists, and a table
    - one streaming-card reply if `streaming: true`
    - one doc, wiki, drive, bitable, or sheet operation against a resource already shared with the bot

## Attribution

- Derived from [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu)
- Includes backports from the bundled Feishu extension in [`openclaw/openclaw`](https://github.com/openclaw/openclaw)
- Distributed under the MIT license in [LICENSE](./LICENSE)
- Additional provenance notes live in [NOTICE](./NOTICE)
