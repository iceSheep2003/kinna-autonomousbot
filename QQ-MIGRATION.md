# QQ 功能迁移与场景 session

## 线上核对依据

2026-11-09，通过 Workbench CLI 只读检查阿里云实例 `i-2ze884ngsym9cm66sul2`。运行服务是 `qq-companion-bot.service`，其实际工作目录和 PYTHONPATH 指向 `/opt/kinna-releases/20261108-133650-memory-identity-final`。`/opt/qq-companion-bot` 中仍有较早的 qunbot 版本，不能用它代表当前运行代码。

核对了当前 release 的 QQ adapter、事件入口、群管理、官方频道、语音、素材目录及启用配置。只下载代码快照用于比对；未下载私聊数据库或凭证，也未修改线上服务或发送真实 QQ 消息。

线上启用的模块包括 scheduled_chat、exam_poster、memes、mood、persona、slang、style_echo、voice、reply_policy、proactive_chat、qq_admin、qq_channel、webui、world_brief、world_digest、world_context、hot_share、wiki_memory。配置还确认开启私聊、room 接话模式、戳一戳、贴表情、入群审核、欢迎、头衔提案及 CosyVoice 语音。启用配置不等于每项都取得了真实平台成功回执。

## 会话职责

QQ 的普通消息和场景事件直接进入长期场景 session：

- 群聊：`qq:<selfId>:group:<groupId>`。
- 私聊：`qq:<selfId>:private:<userId>`。
- 每个 session 有自己的观察游标、历史、前情摘要和工具调用记录。
- 场景会话可自己回复、读取群历史、理解媒体、使用群工具，完成后等待下一条观察。
- 工具结果回到调用它的场景会话。普通回复、戳一戳、欢迎事件和成功回执不自动通知 self。
- 场景只有明确产生 `reflect` 决策才提交主体反思事件，包含触发类型、具体发现和本场景原始证据。
- self 仍负责身份方向、全局目标、定时反思、Dream 建议的评估。场景会话没有这些状态的修改接口。

反思触发类型包括目标冲突、重要发现、方向复查、关系变化和持续失败。它们需要具体依据，不能把每条消息都解释为一次反思机会。

场景上下文和工具调用绑定宿主提供的 scope。模型不能把当前群的回复目标改成其他群，也不能引用其他会话的 operator 事件或媒体资源。

旧 bot 的回复概率、主动发言、自动回戳、复读决策不作为另一套常驻认知循环搬进 QQ 插件。对应行动能力和事件已接入；参与时机由场景 session 决定，跨场景方向由 self 决定。

## 本轮迁入的 QQ 能力

- NapCat / OneBot v11 反向 WebSocket；token、账号校验、echo 回执、断线失败、请求超时、有限事件队列、连接替换。
- 群聊与私聊入站，白名单，忽略自身消息，@、引用、QQ 表情、图片、贴纸、语音资源。
- 群聊和主动私聊发送，结构化 @/引用/图片/语音/QQ 表情，长文字拆条与分条回执。
- 真实消息读取、三层引用、群信息、成员列表、群历史、根目录及一级子目录文件查询。
- 贴表情、取消贴表情、戳一戳、原生骰子/猜拳。
- 受控禁言/解禁、精华设置/取消；授权来自近期真实 operator 事件，不能由模型传入一个 operatorId 伪造。
- 入群申请事件、显式 operator 审核、本地关键词自动审核；拒绝规则优先，没有匹配规则时保留待审核。
- 新成员事件和欢迎机会进入场景 session。
- 头衔提案、本人同意/拒绝、去重投票、过期规则、授予前核对成员和实际回执。
- 图片获取和理解、语音获取和转写的可选 adapter。媒体引用绑定会话；签名 URL 和申请 flag 不放入模型事件。
- OpenAI、Qwen、CosyVoice、Qwen Audio TTS adapter；合成失败时可回退文字，已经尝试发送后结果不明则不再补发文字。
- 兼容旧 `catalog.json` 的本地表情包目录与素材包标签。
- QQ 官方频道查询，以及论坛帖、评论、公告、频道日程的受控写接口；token 缓存、操作路径和资源白名单。

QQ 空间发动态不在当前线上 QQ adapter 的实现集合中，本轮没有声称迁入 Qzone 接口。QQ 视频可以记录资源存在，尚未实现视频理解 provider。

旧版记忆数据库、关系数据、黑话、人格、海报素材和定时业务配置没有自动导入。原来的 mood/Wiki/计划实现也没有作为 QQ 专属认知模块复制进来；新后端的主体、记忆和调度保持通用职责。

## 代码位置

- `src/integrations/qq`：平台事件和能力、场景 scope、群管理、频道协议策略；无数据库或模型供应商依赖。
- `src/infrastructure/qq`：OneBot 网络、媒体获取、模型/TTS HTTP、表情包文件读取、官方频道客户端与装配。
- `src/infrastructure/sqlite/qq.ts`：QQ 专属事件、媒体、提案和回执仓库。
- `src/execution/scene.ts`：与平台无关的持续场景 session。
- `src/infrastructure/sqlite/scenes.ts`：场景历史、观察游标和本地状态。
- `src/runtime/inbox.ts`：统一事件路由到场景、具体执行、self 或纯经验。

## 本地配置

复制 `agent.qq.example.json`，填写 `qq.selfId`、群白名单和需要允许的私聊用户。`privateEnabled=false` 时不接收或发送私聊。operator 与频道 operator 分别配置，不从聊天正文读取。

在 `.env` 中设置：

```dotenv
AGENT_CONFIG=agent.qq.example.json
QQ_ONEBOT_TOKEN=替换为至少24字符的随机值
```

模型参数沿用主后端的 LLM 配置。NapCat 连接 `ws://127.0.0.1:6199/ws`，Token 与 QQ_ONEBOT_TOKEN 一致，消息格式为数组。新后端默认绑定本机；容器环境按已有隔离方式配置可达地址。

图片/语音理解、TTS、表情包及官方频道分别按 `.env.example` 配置，再把相应能力加入 `boundaries.allowedTools`。没有供应商配置时不注册可选工具，不做虚假成功回退。

`qq.ambientMessages` 默认 `session`；设为 `experience` 时，普通未 @ 群消息只留档，@、私聊及其他场景事件仍进入其场景 session。这里没有“普通消息默认先调用 self”的配置。

可以用 `GET /v1/scenes` 查看本地会话状态；`GET /v1/sessions/scene:qq:<selfId>:group:<groupId>/turns` 查看其近期回合。self 的回合仍在 `GET /v1/sessions/self/turns`。

## 验证与上线状态

自动化测试验证了本地 OneBot WebSocket、消息与权限、重复事件、投票/入群流程、局部发送账本，以及完整的 QQ 事件→场景思考→发送→局部回执链路。另有测试证明普通聊天不增加 self 调用，只有明确反思事件才唤醒 self。

测试没有向真实 QQ 群发送消息，没有调用付费媒体/语音服务。图片与语音 adapter、频道权限和素材路径仍需部署时按实际账号联调。新后端尚未替换线上旧 bot 的进程或 NapCat 连接。

平台写操作在发送前记账；结果未知时保留 uncertain 状态，不自动重发。本地分条发送账本可保留已确认部分；没有平台查询能力时不能保证 exactly-once。现场 cutover 应使用独立测试连接或明确切换，不能把同一个 NapCat 事件同时交给两个自动回复进程。
