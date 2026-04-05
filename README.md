# Feishu Plus

English | [中文](./README.cn.md)

OpenClaw already ships with a bundled Feishu plugin. Use the bundled plugin if you only need standard message delivery, baseline routing, and the default Feishu tool surface. `feishu-plus` exists for deployments that outgrew that baseline.

Our actual deployment needed four things the bundled path did not give us cleanly enough: shared context across multiple agents inside the same group chat, group-based slash command permissions, much stronger long-markdown delivery for Feishu, and deeper spreadsheet / bitable workflows. Command permissions matter especially in enterprise multi-user deployments where different teams need different access levels — management and dev teams may switch models freely, creative teams get access to image-generation skills, while junior staff stays on the default model. This repository keeps the upstream Feishu foundation, backports newer bundled changes from [`openclaw/openclaw`](https://github.com/openclaw/openclaw), and layers on the production behavior that motivated the fork in the first place.

Two additions define this fork:

**GroupSense** is a context-enhancement layer for multi-agent group chats. It lets you `@` one agent and continue a discussion that another agent was already part of, without manually replaying the whole conversation. The plugin achieves that by combining milestone summaries with recent raw group history and injecting both back into later prompts.

**Command Control** is a group-based permission system for slash commands. In multi-user enterprise deployments, not everyone should be able to run every command — `/model` and `/think` should probably be off-limits for general staff, while admins and power users get full access. Command Control lets you define user groups that map directly to your org structure, assign each group an allowlist, denylist, or full access, and have the rules take effect on save without a gateway restart.

This repository is also derived from [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu), which remains part of the project lineage.

This distribution is **Feishu-only**. Some inherited source files still use `Lark` naming because the official SDK package is `@larksuiteoapi/node-sdk`, but Lark is not a supported target here.

## Why Not Just Use The Bundled Plugin?

| Need | Bundled Feishu | `feishu-plus` |
| --- | --- | --- |
| Standard Feishu channel integration | Yes | Yes |
| Multiple agents, each with its own Feishu app | No (single app) | Yes |
| One agent serving multiple Feishu orgs | No | Yes |
| Shared context across multiple agents in one group | No | Yes |
| Milestone summaries + recent group history injection | No | Yes |
| Long-markdown delivery tuned for Feishu-heavy usage | Baseline | Yes |
| Sheet workflow as a first-class tool surface | No | Yes |
| Expanded bitable field / record operations | Partial | Yes |
| Group-based slash command permissions | No | Yes |

## What Feishu Plus Adds

- **Multi-account architecture**. The bundled Feishu plugin connects a single Feishu app to the entire OpenClaw instance. `feishu-plus` supports two layers of multi-account: (1) each agent can have its own dedicated Feishu app with independent credentials, permissions, and behavior settings; (2) a single agent can be bound to multiple Feishu apps across different organizations, so the same agent serves users in your personal tenant and your corporate tenant simultaneously. Inbound messages route automatically; outbound tool calls use explicit account selection to prevent cross-org misrouting.
- **GroupSense**. Multi-agent group chats become materially more natural because later prompts can see milestone summaries and recent raw group history, not just the latest `@mention`.
- **Milestone-aware prompting**. Group discussion windows are periodically summarized via LLM and stored under `~/.openclaw/shared-knowledge/feishu-group-milestones`. Bot outbound messages are also recorded. Group sessions roll over after each dispatch so every turn uses only the refined GroupSense context.
- **Long-form reply delivery**. `textChunkLimit`, card rendering, and Feishu-specific reply behavior are tuned for large markdown outputs.
- **Dedicated sheet tooling**. This fork ships a full sheet workflow instead of treating spreadsheets as a side case.
- **Expanded bitable tooling**. The bitable surface covers metadata, fields, records, and batch deletion in a way that fits real operations.
- **Retained upstream tooling**. Doc, wiki, drive, chat, app-scope diagnostics, and other bundled Feishu capabilities are still here.
- **Group-based command control**. Slash command permissions can be restricted per user group. Each group chooses an allowlist, denylist, or full access. Groups are user-defined and can reflect existing org structure.

## Requirements

- OpenClaw `>= 2026.3.13`
- Node.js `>= 20`
- One or more Feishu self-built apps
- If you enable `milestoneContext`: OpenClaw `>= 2026.3.24` (for the `agent-runtime` simple-completion API)

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
        "assistant": {
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

For multi-account setups, bind each agent to its Feishu `accountId`(s) at the OpenClaw level:

```json
{
  "bindings": [
    {
      "agentId": "assistant",
      "match": {
        "channel": "feishu",
        "accountId": "assistant"
      }
    },
    {
      "agentId": "advisor",
      "match": {
        "channel": "feishu",
        "accountId": "advisor"
      }
    }
  ]
}
```

### Multi-organization binding

An agent can be bound to multiple Feishu apps across different organizations. For example, the same agent serving both a personal tenant and a corporate tenant:

```json
{
  "bindings": [
    {
      "agentId": "assistant",
      "match": { "channel": "feishu", "accountId": "assistant" }
    },
    {
      "agentId": "assistant",
      "match": { "channel": "feishu", "accountId": "assistant-corp" }
    }
  ]
}
```

How multi-binding routing works:

- **Inbound message → reply:** the plugin knows which Feishu app received the message and replies through the same app. Zero ambiguity.
- **Agent-initiated tool calls:** the agent must pass `accountId` (or `asAccountId` for tools that use it) to specify which Feishu app to use. If the agent omits the parameter and multiple bindings exist, the tool raises an explicit routing error — no silent fallback, no cross-org misrouting.
- **All Feishu tools** (`feishu_doc`, `feishu_wiki`, `feishu_drive`, `feishu_chat`, `feishu_perm`, `feishu_app_scopes`, `feishu_id`, `feishu_id_admin`, bitable, sheet, task) support explicit account selection via their `accountId` or `asAccountId` parameter.

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

Operationally, it does five things:

1. Records recent group turns per chat — including bot-initiated outbound messages (via the Message tool, etc.).
2. Periodically summarizes a discussion window into milestones using an LLM call (via the plugin-sdk `agent-runtime` API).
3. Stores those milestones under `~/.openclaw/shared-knowledge/feishu-group-milestones`.
4. Injects milestone summaries plus recent raw group history back into later prompts.
5. Rolls over the group session after each dispatch (stateless mode), so every turn starts with only the refined GroupSense context — no LLM history accumulation, no wasted tokens.

The resulting user experience is straightforward: one agent can respond with immediate context about what another agent recently argued, decided, or promised, so the group feels less like isolated bots and more like a coherent team conversation.

### LLM summarization

GroupSense uses the OpenClaw plugin-sdk `agent-runtime` API (`prepareSimpleCompletionModel` + `completeWithPreparedSimpleCompletionModel`) to call an LLM for milestone extraction. No separate summarizer agent or gateway RPC is needed.

The model defaults to the global `agents.defaults.model.primary` in `openclaw.json`. You can override it per-account with the `milestoneContext.model` field:

```json
"milestoneContext": {
  "enabled": true,
  "model": "zhipu-coding/GLM-5"
}
```

Format is `provider/modelId`. If the LLM call fails, the plugin falls back to a regex-based summarizer. The feature still runs, but summary quality is materially worse.

## Reply Delivery And Long Markdown

- `textChunkLimit` is the main knob for keeping a long markdown reply inside a single Feishu message or card.
- `chunkMode` only matters after the chunk limit is exceeded.
- `renderMode: "raw"` keeps replies in the plain message path.
- `renderMode: "auto"` is intentionally conservative. In current code it mainly upgrades replies to cards when content clearly looks like code blocks or markdown tables.
- `renderMode: "card"` always uses interactive markdown cards and gives the clearest streaming-card behavior.
- `streaming: true` enables the Feishu Card Kit streaming path for that account. It does **not** guarantee a smooth typewriter effect by itself; visible smoothness still depends on how often upstream partial text arrives.
- This fork explicitly sets `disableBlockStreaming: true` for Feishu replies so OpenClaw block flushes do not prematurely close the streaming card.
- **Live reasoning display** — when `streaming: true`, the card includes a collapsible "Reasoning" panel that shows live model thinking. To actually light it up, the agent must be configured with `reasoningDefault: "stream"` (per agent in `agents.list`). Without that, the panel stays empty because the SDK defaults to `reasoningLevel: "on"` or `"off"`, which do not emit through the plugin's `onReasoningStream` callback. The panel auto-collapses the moment the model starts producing its answer.

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

By default, all users can only run a small set of safe commands (`/status`, `/new`, `/reset`, `/compact`). To grant access to more commands — or to fine-tune permissions per user group — configure `commandControl` under `channels.feishu`.

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
      "admin":  ["admin_user_id_1", "admin_user_id_2"],
      "tech":   ["user_id_a", "user_id_b", "user_id_c"],
      "design": ["user_id_x", "user_id_y"]
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
- A Feishu `user_id` (tenant-scoped, consistent across all apps) — **recommended**
- `ou_xxx` — a raw Feishu `open_id` (app-scoped, different per Feishu app) — avoid if possible
- `"*"` — matches any sender; use as the last entry for a catch-all default rule

**Always prefer `user_id` over `open_id`.** A person's `user_id` is the same across all Feishu apps in the same tenant, so one entry per person is enough. An `open_id` is different for each Feishu app — you would need N entries per person for N bots. See [Feishu app permissions](#feishu-app-permissions-for-command-control) for how to enable `user_id` resolution.

IDs are normalized the same way as `allowFrom` entries. The `feishu:` prefix is stripped automatically if present.

### Default behavior

If a sender is not covered by any group rule — or if `commandControl` is not configured at all — the fallback allows only `/status`, `/new`, `/reset`, and `/compact`. All other commands return the `blockMessage`.

This is the default for everyone. To give a user or group access to more commands, add an explicit group rule that covers them.

### Per-bot override

"Account" here refers to a **Feishu bot account** (a self-built app), not a human user's Feishu account. Each bot corresponds to one entry under `channels.feishu.accounts.<accountId>` and typically maps to one OpenClaw agent.

`commandControl` and `userGroups` can be set inside a specific bot account. When present, the bot-level config **fully replaces** the top-level config for that bot — there is no merging of rules.

```json
"channels": {
  "feishu": {
    "userGroups": {
      "admin": ["admin_user_id"]
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
          "admin": ["admin_user_id"]
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

### Feishu app permissions for command control

For `user_id`-based matching to work, each Feishu self-built app (bot) must have these permissions enabled on the [Feishu Open Platform](https://open.feishu.cn/) under **tenant_access_token** (application identity, not user identity):

| Permission | Purpose |
|---|---|
| `contact:user.base:readonly` | Read user profile (name resolution) |
| `contact:user.employee_id:readonly` | Read the user's `user_id` field from the contact API |

After adding permissions, **publish a new app version** on the Feishu Open Platform for them to take effect.

**Why both are needed:** The Feishu webhook event only reliably includes `open_id` (app-scoped). The plugin calls the contact API to look up each sender's `user_id` (tenant-scoped). Without `contact:user.employee_id:readonly`, the API returns `user_id` as empty, and matching falls back to `open_id` only — which means you would need a separate `open_id` entry per person per app.

**Also check:** the app's **contact scope** (通讯录权限范围) must include the users you want to resolve. If it's set too narrowly (e.g., "current department only"), the API won't return data for users outside that scope.

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
- `feishu_id`
  - resolve (ID conversion across open_id/union_id/user_id/chat_id), lookup (email/phone → IDs), whois (full profile), members (enriched with all ID types), my_chats, search_chats
- `feishu_id_admin`
  - rebuild_index (scan session history for observed IDs), search_observed (zero-API local search), verify_matrix (cross-account visibility report), explain_visibility (single-target deep diagnosis)

Optional sensitive tooling:

- `feishu_perm` is disabled by default because it modifies ACLs

Operational note:

- Tool execution resolves the effective Feishu identity from inbound message context first, then from agent/account bindings.
- Agents bound to multiple Feishu apps (cross-organization) must specify `accountId` or `asAccountId` when initiating tool calls outside of a message-reply context (e.g., cron jobs, heartbeats). The plugin will not guess — ambiguous routing is an explicit error.

Usability note:

- When creating a document, pass the requester's `owner_open_id` if you want the human requester to immediately receive access on the created doc instead of leaving it visible only to the bot app.

## Notes For AI Agents

### Understanding the command permission model

This section explains the command permission system in full, because the layered design can be non-obvious.

**Three separate concepts:**

1. **`userGroups`** — named sets of Feishu IDs. No permissions here, just names for groups of people. These exist purely so you don't repeat ID lists everywhere.

2. **`commandControl.groups`** — ordered permission rules. Each rule has `members` (who this applies to) and a command policy (`commands: "*"`, `commands: [...]`, or `except: [...]`). Rules are checked top-to-bottom; the first matching rule wins.

3. **Feishu bot accounts** — each Feishu self-built app (bot) corresponds to one OpenClaw agent. "Account" in this context always means a **bot account**, not a human user account. `userGroups` and `commandControl` live at the channel level, not the agent level. There is no per-agent command permission — only per-bot-account (i.e., per-Feishu-app).

**How a command is evaluated:**

```
User sends /model to agent X
    ↓
Which Feishu bot account received this message?
    ↓
Does that bot account have its own commandControl?
    ├─ Yes → use the bot's commandControl + its userGroups (or inherited global userGroups if bot has none)
    └─ No  → use the top-level commandControl + top-level userGroups
    ↓
Walk the groups list top-to-bottom. Find the first group whose members match the sender.
    ├─ Match found → apply that group's command policy
    └─ No match   → apply built-in fallback: /status /new /reset /compact only
    ↓
Allowed → message reaches the agent
Denied  → sender receives a private DM with the blockMessage; agent never sees the message
```

**Per-bot override semantics:**

Bot-level config does a **full replacement**, not a merge:
- If `accounts.X.commandControl` is set, the top-level `commandControl` is completely ignored for bot X
- If `accounts.X.commandControl` is not set, bot X inherits the top-level `commandControl` entirely
- `userGroups` follow the same rule independently: bot-level replaces top-level if set, otherwise inherited
- Consequence: if you set `accounts.X.commandControl` but not `accounts.X.userGroups`, bot X's rules can still reference `@groupName` entries from the top-level `userGroups`

**Default behavior (no configuration):**

Even with no `commandControl` configured at all, the default is **restrictive**: only `/status`, `/new`, `/reset`, and `/compact` are available to everyone. Any other command requires an explicit group rule. This is by design — deploy first, configure access second, without risk of accidental exposure.

**User ID resolution:**

`userGroups` should contain Feishu `user_id` values (tenant-scoped, consistent across all apps), not `open_id` values (app-scoped, different per app). The plugin resolves each sender's `user_id` by calling the Feishu contact API at message time. For this to work, every Feishu app must have `contact:user.employee_id:readonly` and `contact:user.base:readonly` permissions under **tenant_access_token**. If these permissions are missing, the plugin falls back to `open_id` matching only, which requires N entries per person for N bots.

---

If you are an AI agent helping a human operator deploy this plugin, use this order:

1. Confirm that the host runs OpenClaw `>= 2026.3.13`.
2. Decide whether the deployment is single-account or multi-account.
3. Create the Feishu self-built app(s) and collect `appId`, `appSecret`, and transport choice (`websocket` or `webhook`).
4. If transport is `webhook`, also collect `verificationToken` and `encryptKey`.
5. **Configure Feishu app permissions.** Each self-built app needs these permissions on the Feishu Open Platform (all under **tenant_access_token**, not user_access_token):
   - `contact:user.base:readonly` — required for sender name resolution
   - `contact:user.employee_id:readonly` — required for `user_id` resolution (command control matching)
   - `cardkit:card:write` — required only if the deployment wants streaming cards
   - After adding permissions, the human (or their Feishu admin) must **publish a new app version** for the permissions to take effect. Guide them to: Feishu Open Platform → app page → Version Management → Create Version → Publish.
   - Also ensure the app's **contact scope** (通讯录权限范围) covers all users who will interact with the bot. By default it may be too narrow.
6. Write the smallest working `channels.feishu` block first. Add per-account overrides only after DM and group delivery work.
7. Add explicit Feishu `accountId` bindings for every agent that will use Feishu tools.
8. **Configure command control.** Collect user IDs from the Feishu admin panel (each employee's `user_id` is visible under the admin console's member management). Use `user_id` values — not `open_id` — in `userGroups` so one entry per person covers all bots. If you cannot obtain a user's `user_id`, have them send any message to one of the bots and read the `user_id` from the gateway log.
9. If `milestoneContext` is enabled, ensure the OpenClaw version is `>= 2026.3.24` so the `agent-runtime` simple-completion API is available. Optionally set `milestoneContext.model` to control which model is used for summarization.
10. Verify event subscriptions before debugging message flow.
11. Test at least these cases:
    - DM round-trip
    - group `@mention`
    - one long markdown reply with headings, lists, and a table
    - one streaming-card reply if `streaming: true`
    - one doc, wiki, drive, bitable, or sheet operation against a resource already shared with the bot
    - a restricted command (e.g. `/model`) from both an admin and a non-admin user, to verify command control is working

## Attribution

- Derived from [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu)
- Includes backports from the bundled Feishu extension in [`openclaw/openclaw`](https://github.com/openclaw/openclaw)
- Distributed under the MIT license in [LICENSE](./LICENSE)
- Additional provenance notes live in [NOTICE](./NOTICE)
