# Feishu Plus

[English](./README.md) | 中文

OpenClaw 本身已经带有 bundled Feishu 插件。如果你的需求只是标准消息收发、基础 routing，以及默认那套 Feishu tools，那么直接用 bundled 插件通常就够了。`feishu-plus` 是为那些已经把这条基线跑到上限的部署准备的。

我们自己的实际部署需要四类 bundled 插件没有很好覆盖的能力：同一群里的多 agent 共享上下文、基于用户组的 slash command 权限控制、面向飞书的长 Markdown 稳定投递、以及更完整的 sheet / bitable 工作流。命令权限在企业多人使用飞书与 OpenClaw 交互的场景下尤为关键——管理层和研发团队可以自由切换模型使用 GPT、Claude，创作团队能使用自定义图像生成 skill，而初级员工只能使用默认模型和基础命令。这个仓库不是推倒重来，而是在保留上游 Feishu 基础能力的前提下，回补 [`openclaw/openclaw`](https://github.com/openclaw/openclaw) 较新的 bundled 更新，再把真正驱动这个 fork 出现的生产行为叠加上去。

这个 fork 有两项定义性的新增能力：

**GroupSense** 是面向多 agent 群聊的上下文增强层。用户可以 `@` 某个 agent，直接接着另一个 agent 刚才的观点、结论或承诺继续问，而不用手工复述整段群聊。插件会把里程碑摘要和最近原始群消息一起注回到后续 prompt 中。

**命令权限控制（Command Control）** 是面向企业多人部署的 slash command 分组授权系统。在实际企业场景里，不是所有人都应该能执行所有命令——`/model`、`/think` 这类操作应该只对管理员和高权限用户开放，普通员工只需要基础命令。Command Control 允许你定义可直接映射企业组织架构的用户组，为每个组分配白名单、黑名单或全放行策略，配置保存后立即热重载生效，无需重启 gateway。

这个仓库同样继承自 [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu)，这也是项目谱系中的明确上游来源。

这个发行版本是 **纯飞书** 的。代码里残留的一些 `Lark` 命名，主要来自官方 SDK 包名 `@larksuiteoapi/node-sdk` 以及上游继承，不代表这里承诺支持 Lark。

## 为什么不直接用 Bundled Feishu？

| 需求 | Bundled Feishu | `feishu-plus` |
| --- | --- | --- |
| 标准 Feishu 渠道接入 | 支持 | 支持 |
| 多 agent 各自独立飞书应用 | 不支持（单应用） | 支持 |
| 单 agent 跨飞书组织（多应用绑定） | 不支持 | 支持 |
| 同一群里多 agent 共享上下文 | 不支持 | 支持 |
| 群里程碑摘要 + 最近群记录注入 | 不支持 | 支持 |
| 面向飞书的长 Markdown 强化投递 | 基线能力 | 支持 |
| 把 sheet 当成一等工具面 | 不支持 | 支持 |
| 更完整的 bitable 字段 / 记录操作 | 部分支持 | 支持 |
| 基于用户组的 slash command 权限控制 | 不支持 | 支持 |

## Feishu Plus 具体补了什么

- **多账号架构**。Bundled 飞书插件只能为整个 OpenClaw 实例接入一个飞书应用。`feishu-plus` 支持两层多账号：（1）每个 agent 可以拥有独立的飞书应用，各自配置凭据、权限和行为；（2）单个 agent 可以绑定多个飞书应用，跨越不同飞书组织——同一个 agent 同时服务你的个人租户和企业租户。入站消息自动路由到正确的应用；出站工具调用通过显式的账号选择防止跨组织串台。
- **GroupSense**。多 agent 群聊会自然得多，因为后续 prompt 看到的不只是当前这次 `@mention`，还包括里程碑摘要和最近的原始群聊记录。
- **里程碑感知 prompt**。系统通过 LLM 定期整理群聊窗口，并把结果落到 `~/.openclaw/shared-knowledge/feishu-group-milestones`。Bot 出站消息也会被录入。群 session 在每次 dispatch 后 rollover，让每轮只用精炼的 GroupSense 上下文。
- **长文本回复链路**。围绕 `textChunkLimit`、卡片渲染、飞书回复路径做了更适合长 Markdown 的处理。
- **完整的 sheet 工具链**。不是把 spreadsheet 当附属能力，而是明确提供一整套 workflow。
- **扩展过的 bitable 工具面**。覆盖元数据、字段、记录、批量删除等真正会在生产里用到的操作。
- **上游 Feishu tools 继续保留**。doc、wiki、drive、chat、应用权限诊断等能力仍然在。
- **飞书 ID 索引**。`feishu_id` 提供 ID 互转、用户查询、群成员枚举等实时查询能力；`feishu_id_admin` 提供本地观测索引构建、跨账号可达性验证矩阵等诊断能力。多账号多租户环境下的 ID 定位不再靠猜。
- **基于用户组的命令权限控制**。Slash command 可以按用户组限制。每个组独立配置白名单、黑名单或全放行，用户组由部署者自定义，可直接映射现有企业组织架构。

## 环境要求

- OpenClaw `>= 2026.3.13`
- Node.js `>= 20`
- 一个或多个飞书自建应用
- 如果启用 `milestoneContext`：OpenClaw `>= 2026.3.24`（需要 `agent-runtime` 的 simple-completion API）

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

单账号部署很多时候到这里就能跑起来。多账号部署还应该给会使用 Feishu tools 的 agent 增加显式的 Feishu `accountId` 绑定。

## 把 Agent 绑定到 Feishu Account

多账号场景下，在 OpenClaw 顶层把每个 agent 绑定到对应的 Feishu `accountId`：

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

### 跨组织多绑定

一个 agent 可以绑定多个飞书应用，服务于不同的飞书组织。例如同一个 agent 同时服务个人租户和企业租户：

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

多绑定的路由机制：

- **收到消息 → 回复：** 插件知道消息是哪个飞书应用收到的，通过同一个应用回复。零歧义。
- **Agent 主动发起工具调用：** agent 必须通过工具参数 `accountId`（或 `asAccountId`）指定使用哪个飞书应用。如果未指定且存在多个绑定，工具会报明确的路由错误——不会静默回退，不会串台。
- **所有飞书工具**（`feishu_doc`、`feishu_wiki`、`feishu_drive`、`feishu_chat`、`feishu_perm`、`feishu_app_scopes`、bitable、sheet、task）均支持通过 `accountId` 或 `asAccountId` 参数显式选择账号。

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

它在运行上做了五件事：

1. 按 chat 记录最近群消息——包括 bot 主动发出的出站消息（通过 Message 工具等）。
2. 周期性通过 LLM 调用（plugin-sdk `agent-runtime` API）把一个讨论窗口总结成里程碑。
3. 把这些里程碑落到 `~/.openclaw/shared-knowledge/feishu-group-milestones`。
4. 在后续群聊里把里程碑摘要和最近原始群记录一起注回 prompt。
5. 每次 dispatch 完成后 rollover 群 session（stateless 模式），让每轮只有精炼的 GroupSense 上下文——不堆积 LLM 历史，不浪费 token。

用户层面的结果很直观：一个 agent 可以立即接住另一个 agent 刚才的观点、决策或承诺，群聊体验更像一支协同中的团队，而不是若干相互隔离的 bot。

### LLM 摘要

GroupSense 使用 OpenClaw plugin-sdk 的 `agent-runtime` API（`prepareSimpleCompletionModel` + `completeWithPreparedSimpleCompletionModel`）调用 LLM 进行里程碑提取。不需要单独的 summarizer agent，也不需要 gateway RPC。

默认使用 `openclaw.json` 中的全局 `agents.defaults.model.primary`。可以在账号级 `milestoneContext.model` 字段覆盖：

```json
"milestoneContext": {
  "enabled": true,
  "model": "zhipu-coding/GLM-5"
}
```

格式为 `provider/modelId`。如果 LLM 调用失败，插件会回退到正则摘要。功能还能跑，但摘要质量会明显下降。

## 回复链路与长 Markdown

- `textChunkLimit` 是保证长 Markdown 尽量维持在单条飞书消息 / 单张卡片中的主旋钮。
- `chunkMode` 只在超过 chunk limit 之后才生效。
- `renderMode: "raw"` 让回复走普通消息路径。
- `renderMode: "auto"` 是刻意保守的。当前实现里，主要是在内容明显像代码块或 markdown 表格时才升级成 card。
- `renderMode: "card"` 会始终使用 interactive markdown card，也是 streaming-card 观感最清晰的模式。
- `streaming: true` 是给这个账号打开 Feishu Card Kit streaming 路径。它**不等于**一定会有理想的打字机效果；最终观感还取决于上游 partial 文本到底多久来一次。
- 这个 fork 已经对 Feishu reply 明确设置了 `disableBlockStreaming: true`，避免 OpenClaw block flush 把 streaming card 提前关掉。
- **实时 reasoning 展示** —— `streaming: true` 时卡片会带一个可折叠的 "Reasoning" 面板，实时展示模型的思考内容；模型开始产出答案时面板会自动折叠。要真正点亮这个面板，需要**同时满足两个条件**：
  1. agent 使用的模型必须支持 reasoning（例如 Claude Opus/Sonnet 4.x、gpt-5.x、GLM-5）。可以在 config 里查 `models.providers[*].models[*].reasoning: true`。
  2. agent 需要在 `agents.list[]` 里配 `reasoningDefault: "stream"`。这是一个**逐个 agent** 的字段——当前 OpenClaw schema 不支持 `agents.defaults.reasoningDefault`，所以**没有真正的全局开关**，想开哪个 agent 就得在那个 agent 下加一行。

  配置示例（要开 reasoning 的每个 agent 都加一行）：

  ```json
  {
    "agents": {
      "list": [
        {
          "id": "main",
          "name": "…",
          "workspace": "…",
          "reasoningDefault": "stream"
        }
      ]
    }
  }
  ```

  三个取值：
  - `"off"` —— 不请求 reasoning。不设置时的默认值。
  - `"on"` —— 请求 reasoning，内容作为**独立的回复块**（格式是 `Reasoning:\n_line1_\n_line2_`）拼到主回复流里一起发出去。这个模式是给没有独立 reasoning 通道的渠道用的（纯文本渲染、Discord 等）。飞书卡片的 collapsible reasoning 面板**不会消费这个模式**，因为面板只监听 `onReasoningStream` 回调。
  - `"stream"` —— reasoning 通过 `onReasoningStream` 回调实时流到卡片的可折叠 "Reasoning" 面板里。**飞书卡片 UX 要用的就是这个。** 面板是懒插入的：只有当第一条 reasoning 真的流过来时才会出现，所以模型没产生 thinking tokens 的时候用户永远不会看到一个空的"Reasoning"框。

  关于 OpenAI 的 reasoning 模型（`openai-codex` provider 下的 `gpt-5.x`）有一个坑：OpenAI 把 reasoning 作为**加密 blob** 回传，用来在多次调用间做服务端侧 reasoning 复用，**不是**可流的明文思考 token。结果就是：即使你设了 `reasoningDefault: "stream"`、`onReasoningStream` callback 也接好了，OpenAI 模型这边 callback 几乎收不到什么内容——面板要么一闪而过要么根本不出现。**想要真正看到实时流 reasoning 的体验，请用 Anthropic Claude 系列**（Opus/Sonnet 4.x 开启 extended thinking）；Anthropic 会通过 `thinking_delta` 事件流出原始 reasoning token，直接映射到卡片的 reasoning 通道上。

  提示：如果某个 agent 的输出从来不直接给用户看（比如 `summarizer` 只是把结果写盘），开 `"stream"` 纯属浪费 token —— 保持默认就行。

  配置改完之后要**重启 gateway** 才能生效（`openclaw gateway restart`）。gateway 是在启动时读 `agents.list`，不会热加载。

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

默认情况下，所有用户只能使用一组安全命令（`/status`、`/new`、`/reset`、`/compact`）。如需开放更多命令，或按用户组精细控制权限，在 `channels.feishu` 下配置 `commandControl`。

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
      "admin":  ["admin_user_id_1", "admin_user_id_2"],
      "tech":   ["user_id_a", "user_id_b", "user_id_c"],
      "design": ["user_id_x", "user_id_y"]
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
- 飞书 `user_id`（租户级，跨所有应用一致）— **推荐**
- `ou_xxx` — 飞书 `open_id`（应用级，每个飞书应用不同）— 尽量避免
- `"*"` — 匹配所有人，通常放在最后一条兜底规则里

**始终优先使用 `user_id`。** 同一个人的 `user_id` 在企业内所有飞书应用中一致，每人只需配一条。`open_id` 则每个飞书应用不同——N 个 bot 就得为同一个人配 N 条。启用 `user_id` 解析所需的飞书权限见[飞书应用权限配置](#飞书应用权限配置)。

ID 标准化方式与 `allowFrom` 一致，`feishu:` 前缀会自动剥除。如果 `@groupName` 引用了一个在 `userGroups` 里不存在的键，运行时会输出 `console.warn`。

### 默认行为

如果 sender 不被任何组规则覆盖——或者完全没有配置 `commandControl`——兜底只允许 `/status`、`/new`、`/reset`。其他命令一律返回 `blockMessage`。

这是所有用户的默认状态。想给某个用户或用户组开放更多命令，必须显式配置覆盖他们的组规则。

### 按 Bot 覆盖

这里的"account"指的是**飞书 bot 账号**（即一个企业自建应用），不是人类用户的飞书账号。每个 bot 对应 `channels.feishu.accounts.<accountId>` 下的一条配置，通常映射到一个 OpenClaw agent。

`commandControl` 和 `userGroups` 可以配置在某个 bot account 下。Bot 级别有配置时，会**完整替换**顶层配置——不是合并，是替换。

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

在这个例子里，`sensitive-agent` 对非管理员只开放 `/status`，其他 agent 仍然走顶层规则（开放四个命令）。

**注意：** 如果某个 account 定义了自己的 `commandControl` 但没有定义自己的 `userGroups`，它仍然继承顶层的 `userGroups`——`@admin` 这样的引用依然能正常解析。如果 account 同时定义了自己的 `userGroups`，顶层的 `userGroups` 对这个 account 就不再可见。

### 拒绝通知的发送方式

命令被拒时，通知以**私信形式**发给 sender，而不是发到群里，避免在群内暴露用户尝试了受限命令这一信息。

### 热重载

`commandControl` 和 `userGroups` 改动保存后立即生效，不需要重启 gateway。

### 飞书应用权限配置

要让 `user_id` 匹配正常工作，每个飞书自建应用（bot）都需要在[飞书开放平台](https://open.feishu.cn/)上开通以下权限，权限类型选 **tenant_access_token**（应用身份，非用户身份）：

| 权限 | 用途 |
|------|------|
| `contact:user.base:readonly` | 读取用户基本信息（sender 名称解析） |
| `contact:user.employee_id:readonly` | 从 contact API 读取用户的 `user_id` 字段 |

添加权限后，必须在飞书开放平台上**发布新版本**才能生效。

**为什么两个都要开：** 飞书 webhook 事件里只可靠地包含 `open_id`（应用级）。插件在收到消息时调用 contact API 查询 sender 的 `user_id`（租户级）。如果缺少 `contact:user.employee_id:readonly`，API 返回的 `user_id` 为空，权限匹配只能靠 `open_id`——这意味着同一个人在 N 个 bot 下需要配 N 条记录。

**还需检查：** 应用的**通讯录权限范围**必须覆盖需要解析的用户。如果范围过窄（如"仅本部门"），API 不会返回范围外用户的数据。

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
- `feishu_get_message_file`
  - 通过 `message_id` + `file_key` 下载任意 image / file / audio / video 附件，把原始字节写到 agent 指定的本地路径。插件**不**做任何解析、抽取或解读——格式相关的事情全部交给 agent 自己的文件工具（Read、read_file 等）。配套的端到端工作流见 [群里发文件不 @bot 也能让 agent 读取](#群里发文件不-bot-也能让-agent-读取)。

敏感能力：

- `feishu_perm` 默认关闭，因为它会直接修改 ACL

运维层面的注意点：

- tool 执行优先从入站消息上下文解析飞书身份，其次从 agent/account binding 解析
- 绑定了多个飞书应用的 agent（跨组织场景），在非消息回复的上下文中（如 cron job、heartbeat）调用工具时必须指定 `accountId` 或 `asAccountId`。插件不会猜——歧义路由是显式错误

可用性补充：

- 创建文档时，如果希望发起请求的人立刻拿到访问权限，记得传 `owner_open_id`，否则新文档可能只对 bot app 可见

## 群里发文件不 @bot 也能让 Agent 读取

飞书移动端的 UI 不允许在发送文件的同时 `@mention` 任何人——文件消息只能单独发送。所以群里最自然的工作流是：

1. 用户先把 PDF（或图片、文档等）扔进群里，不 `@bot`
2. 再发一条 `@bot 帮我看看这个 PDF`

`feishu-plus` 通过两个配套改动让这个流程端到端打通，而且这两个改动都刻意做成与文件格式无关：

- **GroupSense pending history（以及 milestone summary）记录结构化的附件标记。** 群里没 mention bot 的消息原本只是被缓存为原始文本进 GroupSense。对于带附件的消息——顶层的 `file` / `image` / `audio` / `video` 消息**以及**带嵌入式 image_key / file_key 的富文本 `post` 消息——每一个附件都会被序列化成 `[feishu_attachment type=… message_id=… key=… name="…"]`，而不是 `{"file_key":"..."}` 的裸 JSON。同一份格式化结果同时喂给 milestone-context 摘要器，所以 LLM 在生成 milestone 时也能看到真实的附件引用，而不是看不懂的 JSON。当用户后面再 `@` bot 时，agent 在上下文里就有了一个可引用的"句柄"——并且**插件到此为止没有发起任何网络请求**。完全发生在人类之间的文件传输永远不会触发下载。
- **`feishu_get_message_file` 按需下载附件。** Agent 真的想看这个文件时，用标记里的 `message_id`、`file_key`，加一个绝对 `save_to` 路径，再加上（建议） `original_filename` 调这个 tool。插件通过飞书 `im.messageResource.get` 拉下字节、写到磁盘——就这些。**没有 PDF 解析、没有 OCR、没有文本解码、没有按 MIME 分支处理。** 调用返回路径之后，agent 自己用 Read / read_file（Claude Code、codex 等都自带）去读内容。

为什么是"落盘交路径"而不是"插件解析好喂回去"？两个原因：

1. **天然 universal。** Agent 的文件工具能读什么格式（PDF、图片、纯文本、Jupyter notebook……），这个 tool 就能交付什么格式。将来出新格式，只要 agent 自己的工具学会读就直接生效，不用动插件。
2. **持久化、可复用。** 文件落到磁盘后，agent 还可以 grep、转换、稍后再引用、传给下游 tool 调用。一次性 inline 解析的文本块只能用一次。

行为说明：

- `save_to` 必须是绝对路径。directory-vs-file 模式由 tool 自动判断：以分隔符结尾、或者已经是个目录、或者 basename 完全不带 `.`，都会被当作目录（这时把 `original_filename` 追加进去）。否则就把 `save_to` 当成完整的文件路径用。判断结果会写到 tool 的返回文本里，方便排查误判。父目录会自动创建。
- 这个 tool 走的是和其它 `feishu_*` tool 完全相同的 `withFeishuToolClient` 包装层，所以禁用账号、缺少凭据、`asAccountId` supervisor 委托等行为都和其它工具一致。
- 单文件硬上限 100 MB，超过直接拒绝。
- 多账号绑定的 agent 调用时可以传 `asAccountId` 指定走哪个飞书应用下载。
- Post 消息的注意事项：`[feishu_attachment ...]` 标记对富文本 post 中嵌入的 key 也会发出，但 `im.messageResource.get` 是否真的接受这种 embedded key 取决于飞书 API 的实现——下载失败时 agent 会原样看到底层错误信息。

## 给 AI Agents 的部署说明

### 命令权限模型详解

这一节完整说明命令权限系统的工作方式，因为这套分层设计有一定理解门槛。

**三个独立概念：**

1. **`userGroups`** — 用户组，就是一批飞书 ID 的命名集合。这里不承载任何权限，只是方便引用，避免到处重复写 ID。

2. **`commandControl.groups`** — 有序的权限规则列表。每条规则描述"哪些人（members）能用哪些命令（commands 或 except）"。规则从上到下匹配，第一条命中的规则生效。

3. **飞书 bot 账号** — 每个飞书自建应用（bot）对应一个 OpenClaw agent。这里说的"account"始终是指 **bot 账号**（即飞书自建应用），不是人类用户的飞书账号。`userGroups` 和 `commandControl` 配置在渠道层，不是 agent 层。命令权限没有"per-agent"的粒度，只有"per-bot-account（即 per 飞书应用）"的粒度。

**一条命令的完整判定流程：**

```
用户向 agent X 发送 /model
    ↓
这条消息是通过哪个飞书 bot 收到的？
    ↓
这个 bot 有自己的 commandControl 吗？
    ├─ 有 → 用这个 bot 的 commandControl
    │        userGroups 用 bot 自己的（没有则继承顶层）
    └─ 没有 → 用顶层全局的 commandControl + userGroups
    ↓
从上到下遍历 groups，找到第一条 members 覆盖该 sender 的规则
    ├─ 找到 → 按该规则的命令策略判断
    └─ 没找到 → 走内置兜底：只允许 /status /new /reset /compact
    ↓
通过 → 消息到达 agent
拒绝 → 以私信形式通知 sender；agent 感知不到这条消息
```

**按 Bot 覆盖的语义：**

Bot 级别配置做的是**完整替换**，不是合并：
- `accounts.X.commandControl` 有配置 → 顶层 commandControl 对 bot X 完全失效
- `accounts.X.commandControl` 没有配置 → bot X 完整继承顶层 commandControl
- `userGroups` 遵循同样的规则，独立判断
- 因此：如果只配了 `accounts.X.commandControl` 但没配 `accounts.X.userGroups`，bot X 的规则里仍然可以用 `@groupName` 引用顶层 `userGroups` 里定义的组

**没有任何配置时的默认行为：**

即使完全不写 `commandControl`，默认也是**限制性**的：所有用户只能使用 `/status` `/new` `/reset` `/compact`，其他命令需要显式组规则才能放行。这是刻意的设计——先部署，再按需配权限，不会因为漏配而意外开放命令。

**用户 ID 解析：**

`userGroups` 里应填飞书 `user_id`（租户级，跨所有应用一致），而不是 `open_id`（应用级，每个应用不同）。插件在收消息时自动调飞书 contact API 查询 sender 的 `user_id`。为此，每个飞书自建应用必须开通 `contact:user.employee_id:readonly` 和 `contact:user.base:readonly` 权限（**tenant_access_token** 类型）。如果缺少这些权限，只能回退到 `open_id` 匹配，每人每个 bot 需要单独配一条。

---

如果你是帮助人类快速落地这个插件的 AI agent，建议按这个顺序来：

1. 先确认宿主 OpenClaw 版本是否 `>= 2026.3.13`
2. 先判断是单账号部署，还是多账号部署
3. 创建飞书自建应用，收集 `appId`、`appSecret`，并确定连接方式是 `websocket` 还是 `webhook`
4. 如果是 `webhook`，再收集 `verificationToken` 和 `encryptKey`
5. **配置飞书应用权限。** 每个自建应用需要在飞书开放平台上开通以下权限（全部选 **tenant_access_token**，不是 user_access_token）：
   - `contact:user.base:readonly` — sender 名称解析必需
   - `contact:user.employee_id:readonly` — `user_id` 解析必需（命令权限匹配）
   - `cardkit:card:write` — 仅在需要 streaming card 时开通
   - 添加权限后，需要引导人类用户（或其飞书管理员）在飞书开放平台上**发布新版本**才能生效。操作路径：飞书开放平台 → 应用详情 → 版本管理与发布 → 创建版本 → 申请发布。
   - 还需确认应用的**通讯录权限范围**覆盖了所有会与 bot 交互的用户，默认范围可能过窄。
6. 先写最小可运行的 `channels.feishu`，等 DM 和群聊基础收发通了，再补账号级覆写
7. 给每个会使用 Feishu tools 的 agent 增加显式的 Feishu `accountId` binding
8. **配置命令权限。** 从飞书管理后台获取用户的 `user_id`（管理后台 → 成员管理中可查看每个员工的 `user_id`）。在 `userGroups` 中使用 `user_id`——不是 `open_id`——这样每人只需一条即可覆盖所有 bot。如果无法获取某用户的 `user_id`，让该用户给任意一个 bot 发一条消息，然后从 gateway 日志中读取。
9. 如果启用 `milestoneContext`，确保 OpenClaw 版本 `>= 2026.3.24`（需要 `agent-runtime` 的 simple-completion API）。可选设置 `milestoneContext.model` 控制摘要所用模型。
10. 先核对事件订阅，再排查消息收发问题
11. 最少做这些验证：
    - 私聊往返一次
    - 群里 `@bot` 一次
    - 一段带标题、列表、表格的长 Markdown
    - 如果开了 `streaming: true`，再测一次 streaming-card reply
    - 对已经共享给 bot 的 doc、wiki、drive、bitable 或 sheet 做一次读写验证
    - 用 admin 和非 admin 用户各测一次受限命令（如 `/model`），确认命令权限生效

## Attribution

- 基于 [`m1heng/clawdbot-feishu`](https://github.com/m1heng/clawdbot-feishu) 衍生
- 包含 [`openclaw/openclaw`](https://github.com/openclaw/openclaw) bundled Feishu 插件的回补
- 许可证见 [LICENSE](./LICENSE)
- 额外来源说明见 [NOTICE](./NOTICE)
