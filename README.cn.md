# Feishu Plus

[English](./README.md) | 中文

OpenClaw 本身已经带有 bundled Feishu 插件。如果你的需求只是标准消息收发、基础 routing，以及默认那套 Feishu tools，那么直接用 bundled 插件通常就够了。`feishu-plus` 是为那些已经把这条基线跑到上限的部署准备的。

我们自己的实际部署需要三类 bundled 插件没有很好覆盖的能力：同一群里的多 agent 共享上下文、面向飞书的长 Markdown 稳定投递、以及更完整的 sheet / bitable 工作流。这个仓库不是推倒重来，而是在保留上游 Feishu 基础能力的前提下，回补 [`openclaw/openclaw`](https://github.com/openclaw/openclaw) 较新的 bundled 更新，再把真正驱动这个 fork 出现的生产行为叠加上去。

这个 fork 有两项定义性的新增能力：

**GroupSense** 是面向多 agent 群聊的上下文增强层。用户可以 `@` 某个 agent，直接接着另一个 agent 刚才的观点、结论或承诺继续问，而不用手工复述整段群聊。插件会把里程碑摘要和最近原始群消息一起注回到后续 prompt 中。

**命令权限控制（Command Control）** 是面向企业多人部署的 slash command 分组授权系统。在实际企业场景里，不是所有人都应该能执行所有命令——`/model`、`/think` 这类操作应该只对管理员和高权限用户开放，普通员工只需要基础命令。Command Control 允许你定义可直接映射企业组织架构的用户组，为每个组分配白名单、黑名单或全放行策略，配置保存后立即热重载生效，无需重启 gateway。

这个仓库同样继承自 [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu)，这也是项目谱系中的明确上游来源。

这个发行版本是 **纯飞书** 的。代码里残留的一些 `Lark` 命名，主要来自官方 SDK 包名 `@larksuiteoapi/node-sdk` 以及上游继承，不代表这里承诺支持 Lark。

## 为什么不直接用 Bundled Feishu？

| 需求 | Bundled Feishu | `feishu-plus` |
| --- | --- | --- |
| 标准 Feishu 渠道接入 | 支持 | 支持 |
| 同一群里多 agent 共享上下文 | 不支持 | 支持 |
| 群里程碑摘要 + 最近群记录注入 | 不支持 | 支持 |
| 面向飞书的长 Markdown 强化投递 | 基线能力 | 支持 |
| 把 sheet 当成一等工具面 | 不支持 | 支持 |
| 更完整的 bitable 字段 / 记录操作 | 部分支持 | 支持 |
| 基于用户组的 slash command 权限控制 | 不支持 | 支持 |

## Feishu Plus 具体补了什么

- **GroupSense**。多 agent 群聊会自然得多，因为后续 prompt 看到的不只是当前这次 `@mention`，还包括里程碑摘要和最近的原始群聊记录。
- **里程碑感知 prompt**。系统会定期整理群聊窗口，并把结果落到 `~/.openclaw/shared-knowledge/feishu-group-milestones`。
- **长文本回复链路**。围绕 `textChunkLimit`、卡片渲染、飞书回复路径做了更适合长 Markdown 的处理。
- **完整的 sheet 工具链**。不是把 spreadsheet 当附属能力，而是明确提供一整套 workflow。
- **扩展过的 bitable 工具面**。覆盖元数据、字段、记录、批量删除等真正会在生产里用到的操作。
- **上游 Feishu tools 继续保留**。doc、wiki、drive、chat、应用权限诊断等能力仍然在。
- **基于用户组的命令权限控制**。Slash command 可以按用户组限制。每个组独立配置白名单、黑名单或全放行，用户组由部署者自定义，可直接映射现有企业组织架构。

## 环境要求

- OpenClaw `>= 2026.3.13`
- Node.js `>= 20`
- 一个或多个飞书自建应用
- 如果启用 `milestoneContext`：宿主 OpenClaw 还必须具备可达的本地 gateway，以及一个 id **必须等于** `summarizer` 的 headless agent

## 安装

### 本地路径安装

```bash
git clone https://github.com/hchen13/feishu-plus.git
cd feishu-plus
npm install
openclaw plugins install /absolute/path/to/feishu-plus
```

### 通过 GitHub 安装

```bash
openclaw plugins install github:hchen13/feishu-plus
```

### 通过配置直接加载

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

## 最小配置

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

单账号部署很多时候到这里就能跑起来。多账号部署还应该给会使用 Feishu tools 的 agent 增加显式的 Feishu `accountId` 绑定。

## 把 Agent 绑定到 Feishu Account

多账号场景下，建议在 OpenClaw 顶层把每个 agent 明确绑定到唯一的 Feishu `accountId`：

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

这一步为什么重要：

- 入站消息 routing 本来就知道事件是哪个 Feishu app 收到的。
- 但 tool 执行也需要一个明确的 Feishu 身份。
- 这个插件不会在多账号场景里偷偷猜账号，而是要求映射关系足够明确。

如果一个 agent 有多条 Feishu binding，这些 binding 最终也应该落到同一个 `accountId`。否则 tool 层会直接报 routing 冲突，而不是静默选错账号。

## 飞书应用配置

### 建议作为基线的权限

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`
- `contact:user.base:readonly`

`contact:user.base:readonly` 之所以建议作为基线，是因为 `resolveSenderNames` 默认开启。没有这个权限时，消息仍然能收发，但发送者姓名解析可能失败，agent 还可能把权限授权链接提示给用户。

### 按能力补充的可选权限

按实际用到的能力开，不要一股脑全开：

- `docx:document` 或 `docx:document:readonly`
- `docx:document.block:convert`
- `drive:drive` 或 `drive:drive:readonly`
- `wiki:wiki` 或 `wiki:wiki:readonly`
- `bitable:app` 或 `bitable:app:readonly`
- `sheets:spreadsheet` 或 `sheets:spreadsheet:readonly`
- `task:task:read` 或 `task:task:write`
- 如果启用 `perm`，再加 `drive:permission`
- 如果你在正常 reply pipeline 之外依赖 message/card patch 流程，再加 `im:message:update`

### Streaming Card 额外权限

如果某个账号开启了 `streaming: true`，还需要给这个账号的应用开：

- `cardkit:card:write`

这就是 streaming-card 实际走到的权限路径。插件会先通过 `/cardkit/v1/cards` 创建 Card Kit card entity，再在生成过程中持续更新它。

一个重要区分：

- 普通 interactive markdown card 仍然可以走标准的 Feishu message API。
- **streaming card 不是一回事。** 只要你打开 `streaming: true`，就进入了 Card Kit entity API 的权限路径。

如果权限没开，最典型的运行时现象就是日志里出现：

`Create card failed: Access denied ... [cardkit:card:write]`

### 事件订阅

至少订阅：

- `im.message.receive_v1`
- `im.chat.member.bot.added_v1`
- `im.chat.member.bot.deleted_v1`

以下能力按需再开：

- 如果 `reactionNotifications` 不是 `off`，订阅 `im.message.reaction.created_v1`
- 如果你的部署会把 interactive card action 当输入，订阅 `card.action.trigger`

不同连接方式的额外配置：

- `connectionMode: "websocket"`：在飞书后台配置 **Long connection**
- `connectionMode: "webhook"`：配置 **Request URL**、`verificationToken`、`encryptKey`

Webhook 路径在代码里是做了加固的：签名校验、body 大小限制、content-type 检查、rate limiting 都在。

### 资源共享仍然是硬条件

只有 API 权限还不够。bot 还必须被真正加入或共享到资源本身：

- 文档
- 知识库空间
- 云盘文件夹和文件
- bitable
- sheet

如果鉴权看起来正常，但结果为空，或者持续报权限错误，优先检查共享设置，而不是先怀疑插件代码。

### 多应用提醒

飞书里的 `open_id` 是 **按 app 隔离** 的。同一个人，在不同 Feishu app 下会拿到不同的 `open_id`。不要把 app A 下拿到的 `open_id` 拿去让 app B 使用。

## Introducing GroupSense

**GroupSense** 是这个 fork 对外命名的群聊上下文增强层。

它在运行上做了四件事：

1. 按 chat 记录最近群消息。
2. 周期性把一个讨论窗口总结成里程碑。
3. 把这些里程碑落到 `~/.openclaw/shared-knowledge/feishu-group-milestones`。
4. 在后续群聊里把里程碑摘要和最近原始群记录一起注回 prompt。

用户层面的结果很直观：一个 agent 可以立即接住另一个 agent 刚才的观点、决策或承诺，群聊体验更像一支协同中的团队，而不是若干相互隔离的 bot。

### GroupSense 不是一个自包含模块

`milestoneContext` 的实现确实在这个插件里，但摘要这一步依赖宿主 OpenClaw：

- 它会动态解析内部 gateway helper
- 会调用 `agent`、`agent.wait`、`chat.history`、`sessions.delete`
- 并且要求宿主存在一个 id **必须等于** `summarizer` 的 headless agent

如果宿主侧这条链路不完整，插件会回退到正则摘要。功能还能跑，但摘要质量会明显下降。

### 宿主侧 summarizer 合约

在 `openclaw.json` 里增加一个 headless agent：

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

推荐的 workspace 模板已经放在这里：

- [`docs/summarizer/AGENTS.md`](./docs/summarizer/AGENTS.md)
- [`docs/summarizer/BOOTSTRAP.md`](./docs/summarizer/BOOTSTRAP.md)

建议：

- 这个 agent 保持 headless，不要绑定到飞书或其他聊天渠道。
- workspace 合约尽量窄，只做 JSON 抽取，不要塞 personality 或旁支流程。
- 插件真正依赖的是 `AGENTS.md` 的输出合约。`BOOTSTRAP.md` 的作用，是在宿主要求有 bootstrap 文件时，也让这个 workspace 保持可预测和安全。

## 回复链路与长 Markdown

- `textChunkLimit` 是保证长 Markdown 尽量维持在单条飞书消息 / 单张卡片中的主旋钮。
- `chunkMode` 只在超过 chunk limit 之后才生效。
- `renderMode: "raw"` 让回复走普通消息路径。
- `renderMode: "auto"` 是刻意保守的。当前实现里，主要是在内容明显像代码块或 markdown 表格时才升级成 card。
- `renderMode: "card"` 会始终使用 interactive markdown card，也是 streaming-card 观感最清晰的模式。
- `streaming: true` 是给这个账号打开 Feishu Card Kit streaming 路径。它**不等于**一定会有理想的打字机效果；最终观感还取决于上游 partial 文本到底多久来一次。
- 这个 fork 已经对 Feishu reply 明确设置了 `disableBlockStreaming: true`，避免 OpenClaw block flush 把 streaming card 提前关掉。

经验上可以这样理解：

- 如果你更在意 **长 Markdown 完整性**，先看 `textChunkLimit`
- 如果你更在意 **streaming card 观感**，优先调 `renderMode` 和上游 partial 频率

## 群聊路由与运维开关

这些配置在真实部署里很重要：

- `requireMention`：群里是否必须显式 `@bot`
- `groupPolicy` / `groupAllowFrom`：这个群本身是否允许接入
- `groupSenderAllowFrom`：允许的群里，再额外限制哪些发送者可触发 bot
- `groupSessionScope`：群聊 session 怎样隔离
- `replyInThread`：bot 回复是否创建 / 延续飞书话题线程
- `reactionNotifications`：reaction 是否转成 synthetic inbound message
- `typingIndicator`：回复前是否先加一个临时 typing reaction
- `resolveSenderNames`：是否通过 Feishu contact API 解析显示名
- `dynamicAgentCreation`：可选的 DM-only 模式，为每个私聊用户自动创建独立 agent

`groupSessionScope` 支持：

- `group`：一个群一个 session
- `group_sender`：按 `(group + sender)` 切 session
- `group_topic`：按群里的 topic thread 切 session
- `group_topic_sender`：按 `(group + topic + sender)` 切 session

`topicSessionMode` 现在更多是兼容旧配置，真正的主开关已经是 `groupSessionScope`。

## 命令权限控制

默认情况下，能访问某个 agent 的用户，就能使用所有 slash commands。如果你需要针对不同用户限制可用命令，在 `channels.feishu` 下配置 `commandControl`。

### 工作原理

两个字段配合使用：

- `userGroups` — 集中定义命名用户组（飞书 ID 或部门 ID 列表），之后在任何地方都可以通过名称引用
- `commandControl.groups` — 有序规则列表，将用户组成员身份映射到命令权限

收到 slash command 时，sender 按列表顺序从上往下匹配，第一条命中的规则生效。若 sender 不属于任何组，内置安全兜底生效：仅允许 `/status`、`/new`、`/reset`，其余命令一律拒绝。

即使完全不配置 `commandControl`，默认规则同样生效：所有用户只能使用 `/status`、`/new`、`/reset`，其他命令需要显式的组规则才能放行。

### 配置示例

```json
"channels": {
  "feishu": {
    "userGroups": {
      "admin":  ["ou_admin1", "ou_admin2"],
      "tech":   ["ou_技术部门组ID"],
      "design": ["ou_设计部门组ID"]
    },
    "commandControl": {
      "blockMessage": "你没有权限使用该命令",
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

### 三种规则模式

每个组规则只能选其中一种：

| 字段 | 模式 | 行为 |
|------|------|------|
| `commands: "*"` | 全放行 | 所有命令可用，包括未来新增的命令 |
| `commands: [...]` | 白名单 | 只有列出的命令可用，新增命令**不会**自动放行 |
| `except: [...]` | 黑名单 | 除列出的命令外全部可用，新增命令**自动放行** |

`commands` 和 `except` 不能同时配置在同一个组规则上，schema 在加载时会拒绝这种配置。

### members 写法

`members` 支持以下写法混用：

- `@groupName` — 引用 `userGroups` 里的某个键，匹配时展开为对应的 ID 列表
- `ou_xxx` — 飞书 open ID 或部门组 ID
- `"*"` — 匹配所有人，通常放在最后一条兜底规则里

ID 标准化方式与 `allowFrom` 一致，`feishu:` 前缀会自动剥除。如果 `@groupName` 引用了一个在 `userGroups` 里不存在的键，运行时会输出 `console.warn`。

### 默认行为

如果 sender 不被任何组规则覆盖——或者完全没有配置 `commandControl`——兜底只允许 `/status`、`/new`、`/reset`。其他命令一律返回 `blockMessage`。

这是所有用户的默认状态。想给某个用户或用户组开放更多命令，必须显式配置覆盖他们的组规则。

### Account 级别覆盖

`commandControl` 和 `userGroups` 也可以配置在具体的 `channels.feishu.accounts.<accountId>` 下。Account 级别有配置时，会**完整替换**顶层配置，在这个 account 上生效——不是合并，是替换。

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

在这个例子里，`sensitive-agent` 对非管理员只开放 `/status`，其他 agent 仍然走顶层规则（开放四个命令）。

**注意：** 如果某个 account 定义了自己的 `commandControl` 但没有定义自己的 `userGroups`，它仍然继承顶层的 `userGroups`——`@admin` 这样的引用依然能正常解析。如果 account 同时定义了自己的 `userGroups`，顶层的 `userGroups` 对这个 account 就不再可见。

### 拒绝通知的发送方式

命令被拒时，通知以**私信形式**发给 sender，而不是发到群里，避免在群内暴露用户尝试了受限命令这一信息。

### 热重载

`commandControl` 和 `userGroups` 改动保存后立即生效，不需要重启 gateway。

### 注意：open_id 按应用隔离

飞书的 `open_id` 是按应用隔离的，同一个人在不同飞书应用下有不同的 `open_id`。`userGroups` 里填写的 ID 必须与对应 bot 账号所属的飞书应用一致。

## 工具面

从上游 Feishu 基座保留下来的：

- `feishu_doc`
- `feishu_wiki`
- `feishu_drive`
- `feishu_chat`
- `feishu_app_scopes`

这个 fork 自己补的或扩展过的：

- `feishu_sheet`
  - `get_meta`、`read_range`、`write_range`、`append_rows`、`set_format`、`set_style`、`insert_image`、`insert_cell_image`
- 扩展后的 `feishu_bitable_*`
  - URL 解析、字段 CRUD、记录 CRUD、批量删除
- `feishu_task_*`
  - create、get、update、delete

敏感能力：

- `feishu_perm` 默认关闭，因为它会直接修改 ACL

运维层面的注意点：

- tool 执行会从入站上下文或 agent/account binding 里解析有效的 Feishu 身份
- 多账号部署里，不要让 agent 到 account 的映射处于模糊状态

可用性补充：

- 创建文档时，如果希望发起请求的人立刻拿到访问权限，记得传 `owner_open_id`，否则新文档可能只对 bot app 可见

## 给 AI Agents 的部署说明

### 命令权限模型详解

这一节完整说明命令权限系统的工作方式，因为这套分层设计有一定理解门槛。

**三个独立概念：**

1. **`userGroups`** — 用户组，就是一批飞书 ID 的命名集合。这里不承载任何权限，只是方便引用，避免到处重复写 ID。

2. **`commandControl.groups`** — 有序的权限规则列表。每条规则描述"哪些人（members）能用哪些命令（commands 或 except）"。规则从上到下匹配，第一条命中的规则生效。

3. **飞书 account** — 每个飞书应用对应一个 agent。`userGroups` 和 `commandControl` 配置在渠道层，不是 agent 层。命令权限没有"per-agent"的粒度，只有"per-account（即 per 飞书应用）"的粒度。

**一条命令的完整判定流程：**

```
用户向 agent X 发送 /model
    ↓
这条消息是通过哪个飞书 account 收到的？
    ↓
这个 account 有自己的 commandControl 吗？
    ├─ 有 → 用这个 account 的 commandControl
    │        userGroups 用 account 自己的（没有则继承顶层）
    └─ 没有 → 用顶层全局的 commandControl + userGroups
    ↓
从上到下遍历 groups，找到第一条 members 覆盖该 sender 的规则
    ├─ 找到 → 按该规则的命令策略判断
    └─ 没找到 → 走内置兜底：只允许 /status /new /reset /compact
    ↓
通过 → 消息到达 agent
拒绝 → 以私信形式通知 sender；agent 感知不到这条消息
```

**Account 级别覆盖的语义：**

Account 配置做的是**完整替换**，不是合并：
- `accounts.X.commandControl` 有配置 → 顶层 commandControl 对 account X 完全失效
- `accounts.X.commandControl` 没有配置 → account X 完整继承顶层 commandControl
- `userGroups` 遵循同样的规则，独立判断
- 因此：如果只配了 `accounts.X.commandControl` 但没配 `accounts.X.userGroups`，account X 的规则里仍然可以用 `@groupName` 引用顶层 `userGroups` 里定义的组

**没有任何配置时的默认行为：**

即使完全不写 `commandControl`，默认也是**限制性**的：所有用户只能使用 `/status` `/new` `/reset` `/compact`，其他命令需要显式组规则才能放行。这是刻意的设计——先部署，再按需配权限，不会因为漏配而意外开放命令。

**飞书 open_id 的应用隔离：**

同一个人在不同飞书应用下有不同的 `open_id`。如果某个人需要在所有 agent（跨多个飞书应用）上都拥有管理员权限，必须把他在每个应用下的 `open_id` 都加进 `userGroups` 对应的条目里。

---

如果你是帮助人类快速落地这个插件的 AI agent，建议按这个顺序来：

1. 先确认宿主 OpenClaw 版本是否 `>= 2026.3.13`
2. 先判断是单账号部署，还是多账号部署
3. 创建飞书自建应用，收集 `appId`、`appSecret`，并确定连接方式是 `websocket` 还是 `webhook`
4. 如果是 `webhook`，再收集 `verificationToken` 和 `encryptKey`
5. 先写最小可运行的 `channels.feishu`，等 DM 和群聊基础收发通了，再补账号级覆写
6. 如果想要 streaming card，先开 `cardkit:card:write`，再去调 UX
7. 如果保留 `resolveSenderNames: true`，先开 `contact:user.base:readonly`
8. 给每个会使用 Feishu tools 的 agent 增加显式的 Feishu `accountId` binding
9. 如果启用 `milestoneContext`，创建一个 id 必须等于 `summarizer` 的 headless agent，并把 [`docs/summarizer/AGENTS.md`](./docs/summarizer/AGENTS.md) 和 [`docs/summarizer/BOOTSTRAP.md`](./docs/summarizer/BOOTSTRAP.md) 拷到它的 workspace
10. 先核对事件订阅，再排查消息收发问题
11. 最少做这些验证：
    - 私聊往返一次
    - 群里 `@bot` 一次
    - 一段带标题、列表、表格的长 Markdown
    - 如果开了 `streaming: true`，再测一次 streaming-card reply
    - 对已经共享给 bot 的 doc、wiki、drive、bitable 或 sheet 做一次读写验证

## Attribution

- 基于 [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu) 衍生
- 包含 [`openclaw/openclaw`](https://github.com/openclaw/openclaw) bundled Feishu 插件的回补
- 许可证见 [LICENSE](./LICENSE)
- 额外来源说明见 [NOTICE](./NOTICE)
