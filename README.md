# Persistent Self Agent — TypeScript

基于持久主体和长期 `self` 会话的自主 Agent 后端。操作者配置身份、初始倾向、环境能力和资源边界；Agent 自己决定探索、目标、行动、反思或休息。

使用 TypeScript、Fastify、SQLite，单主体、单进程。长期 self、局部执行、Dream 和运行时有独立接口与状态所有权。详细设计与代码逐项对应见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 启动

要求 Node.js 24+。内置 `node:sqlite` 可能打印实验性 API 提示。

```bash
npm ci
npm run check
npm run demo
```

`demo` 使用内存数据库、脚本模型和模拟环境，不访问网络或发送消息。它展示无用户任务的初始化、目标形成、局部执行、反馈、Dream 和未来唤醒，不代表真实模型的自主决策质量。

真实模型运行：

```bash
cp .env.example .env
# 编辑 LLM_API_KEY、LLM_MODEL、API_TOKEN（至少 24 字符）
npm run build
node --env-file=.env dist/src/main.js
```

开发运行：

```bash
node --env-file=.env --import tsx src/main.ts
```

`npm run dev` 使用进程环境，不自动加载 `.env`。默认监听 `127.0.0.1:3100`；数据库默认 `data/agent.sqlite`。

生产入口需要真实模型配置，不会自动回退到 demo。模型服务应兼容 `/chat/completions` 和 `response_format: json_object`，响应另经 Zod 校验。其他协议实现 `shared/LanguageModel` 后在入口装配。

## 代码定位

| 路径 | 职责 |
| --- | --- |
| `src/subject` | 身份、方向、目标及版本、心境和对象相关情绪 |
| `src/self` | 长期会话、上下文构建、主体决策 |
| `src/execution` | 直接动作、任务执行上下文、长期场景 session、局部进度和反馈 |
| `src/memory` | 原始经验、反思记录、记忆检索、Dream 发布 |
| `src/runtime` | Inbox、作业运行、调度、预算、恢复 |
| `src/capabilities` | 能力契约、授权、调用与副作用账本 |
| `src/integrations` | 插件入口、记忆查询、环境与搜索工具 |
| `src/infrastructure` | SQLite port 实现、LLM/HTTP 适配器 |
| `src/app` | 依赖装配、跨模块决策提交、配置与管理接口契约 |
| `src/shared` | 模型、事务、资源和校验的共用契约 |

查看一轮自主决策的主要路径：`main.ts` → `app/agent.ts` 装配 → `runtime/worker.ts` 唤醒 → `self/session.ts` 思考 → `app/decision-committer.ts` 协调提交 → 各模块处理自己拥有的状态。

新增能力不需要修改 self、执行器或主体模块。替换数据库需要实现各模块的仓库 port；业务模块不包含 SQL。

## 环境与能力

默认只有 `memory.search` 和 `experience.read`。没有环境能力时 Agent 可以反思，但不能凭空浏览网络。

联网搜索：在 `.env` 中设置 `BRAVE_API_KEY` 和 `AGENT_CONFIG=agent.config.example.json`，其 `allowedTools` 显式包含 `web.search`。工具返回标题、URL 和摘要，未包含通用网页正文抓取。

本地插件演示：用 `AGENT_CONFIG=examples/local.config.json` 配合 TS 开发入口；编译运行时把插件路径改为 `./dist/examples/local-environment.js`。

插件实现 `EnvironmentPlugin`：

- `setup` 只获得能力注册接口；工具声明名称、说明、Zod schema、read/write 类型和执行函数。
- `start` 只获得事件投递口。
- `stop` 释放连接或停止订阅。

工具收到 operationId 和超时 signal。平台凭证保存在插件内部；大文件、视频、正文应返回可读取的资源引用。插件必须在自己的平台 API 中落实对象范围、限流、回执和业务前置条件。

QQ/NapCat 平台能力已迁入，配置和线上核对清单见 [QQ-MIGRATION.md](./QQ-MIGRATION.md)。普通 QQ 消息进入各自的场景 session，只有明确反思事件才通知 self。新后端尚未接管线上账号；B站与 QQ 空间发动态尚未接入。

## 行为与资源配置

`agent.config.example.json` 包含身份、倾向、允许工具、模型调用额度、执行步骤上限、待处理作业上限、反思周期与 Dream 周期。

初始化身份只在新数据库中生效，重启不会重置已有主体。能力边界和资源额度由部署配置控制，模型不能自行增加权限。

`self` 可选择：

- 修改方向、焦点、情绪评价、短期/长期目标。
- `act` 直接调用参数已确定的工具。
- `launch` 创建需要局部自主决策的执行上下文。
- 用 `wake` 日程安排未来思考，`execute` 安排未来意图，`tool` 安排确定工具调用。
- 取消行动或日程、请求 Dream、指定 `nextWakeAt`，也可以休息。

目标变更的应用用例会取消旧日程并暂停旧执行；日程执行前再校验目标版本。执行步骤耗尽、结果不确定或失败时向 self 汇报。局部工具结果无需逐步唤醒 self。

当前小时预算统计真正发生的模型请求；直接工具动作和复用已保存工具选择不会额外扣模型额度。尚无精确 token/金额预算。

上下文数量上限可用可选 `contextLimits` 配置：observations、recentTurns、goals、memories、executions、schedules、dreamBatch。它们控制窗口，不代表要把所有历史放进 prompt。上限不能替代模型 token 预算；长文本/媒体仍应以资源引用提供。

## HTTP 接口

除 `/health` 外均需要 `Authorization: Bearer <API_TOKEN>`。这是可信适配器与管理接口，令牌不应提供给普通聊天用户。

| 接口 | 内容 |
| --- | --- |
| `GET /health` | 进程存活 |
| `GET /v1/self` | 主体快照 |
| `GET /v1/goals` | 目标及版本 |
| `GET /v1/executions` | 直接动作与局部执行 |
| `GET /v1/scenes` | 各场景 session 的游标、前情和状态 |
| `GET /v1/schedules` | 待执行/已触发/已取消日程 |
| `GET /v1/memories` | 已发布记忆 |
| `GET /v1/dreams` | 已发布 Dream 及输入截断位置 |
| `GET /v1/reflections` | 带来源的总结与反思 |
| `GET /v1/affect` | 人物/主题相关感受；整体心境在 self 中 |
| `GET /v1/operations` | 真实工具调用记录与不确定结果 |
| `GET /v1/jobs` | 最近作业及失败原因 |
| `GET /v1/capabilities` | 当前授权能力和参数 schema |
| `GET /v1/experiences?after=0&limit=30` | 原始经验，可附加 source |
| `GET /v1/sessions/self/turns` | 最近 self 回合与当时上下文 |
| `POST /v1/events` | 投递环境事件 |
| `GET /v1/bilibili/drafts` | 待批准的 B 站评论/动态草稿（未配置 B 站时 404） |
| `POST /v1/bilibili/drafts/:id/approve` | 批准并发出；成功 200，不可批准（已用/过期/重复）409 |
| `POST /v1/bilibili/drafts/:id/reject` | 拒绝草稿，可带 `{"note":"..."}` |

集合接口支持 `limit` 和 `offset`，每页上限 100。事件示例：

```json
{
  "id": "platform-event-123",
  "source": "qq",
  "kind": "message.received",
  "data": { "conversationId": "room-1", "senderId": "person-1", "text": "最近在看什么？" },
  "route": { "type": "session", "sessionId": "qq:99:group:room-1", "environment": "qq", "scope": { "type": "group", "id": "room-1" } }
}
```

重复的 `(source, id)` 不再次触发。场景消息使用 session 路由，并携带稳定 sessionId、environment 和 scope。只有主体反思事件使用 self 路由。局部执行事件使用 `{"type":"execution","executionId":"..."}`；仅留档的经验使用 `{"type":"experience"}`。

这些接口不提供绕过 self 直接重写身份和目标的入口。API 只拿读模型与事件投递口，不拿领域写仓库。

## B 站接入

B 站是三件事拼起来的：**看得懂视频**、**读得懂评论**、**说得出口**。前两件是读，最后一件是公开写，所以两者的门槛不一样。

- `bilibili.video`：按时间轴抽帧（避开片头片尾），交给视觉模型描述画面，再结合标题/简介写成观看笔记。画面里没出现过的细节会被丢掉——读视频最容易犯的错就是看图说话。帧是临时文件，理解完即删。
- `bilibili.comments`：读一个视频的评论区（按热度或时间），包括别人对你视频的评论。配置 `BILIBILI_MID` 后还会轮询自己视频下的新评论，送进对应视频的场景会话。
- `bilibili.draft_comment` / `bilibili.draft_dynamic`：**只出草稿**。模型没有任何路径能自己把内容发到公开平台上；草稿存在本地库，带过期时间（默认 24h）。
- 批准：只有持 `API_TOKEN` 的人能调 `POST /v1/bilibili/drafts/:id/approve`。真正发出还要过当天额度（`maxPostsPerDay`），失败不扣额度、不自动重发。
- `commentPolicy` / `dynamicPolicy`：`off` 连草稿都不建，`draft`（默认）出草稿等人批，`on` 同样要显式批准请求。

登录态只从环境读（`BILIBILI_SESSDATA` + `BILIBILI_BILI_JCT`），不落配置文件、不进模型上下文；写请求的 `csrf` 由传输层自动补上，调用方看不到 cookie。配置示例见 `agent.bilibili.example.json`。抽帧依赖本机 `ffmpeg`，画面理解需要一个 OpenAI 兼容的视觉模型（`BILIBILI_VISION_*`）。

## 恢复与部署范围

构建会清理旧 dist，避免保留重构前的模块。SQLite 的已有主体、会话、目标、经验、操作记录和日程沿用原表和键；新增对象相关情绪与结构化反思使用独立 collection。

Worker 串行推进作业，所有模型/网络调用在事务外进行。本地状态、当前作业完成和后续作业在同一个事务提交。进程重启恢复运行中的作业。

写操作先记账。已经确认的操作复用回执；网络结果不明标记 uncertain 并暂停，不自动重发。仍需具体平台的对账能力，本版没有通用人工核销接口，也不保证平台级 exactly-once。

SQLite 租约用于防止意外双实例。本实现按单进程部署，不是分布式队列/多副本调度器。生产公开服务还需要部署层的 TLS、入口限制与平台连接配置。

## 一个主体，不是四个角色

`self` / `scene` / `execution` / `dream` 是同一个人在四种场合：自己想事情、在群里接话、办一件具体事、夜里回想。身份、记性、脾气在这四种场合连续，提示词开头统一是「还是你，同一个人」，只补「这会儿在做什么」，不再各自定义「你是谁」。唯一一份人格定义在 `shared/persona.ts`（`Personality`：性子、在意什么、红线、默认基调）；`AGENT_CONFIG.personal=false` 只关掉偏好段落用于对照，身份和相处底线不变。

借「为人处事」的分寸写成待人口径，而不是情感咨询流程：先接住人再谈事、开口前量五维（回应温度 / 信号确定性 / 情绪走向 / 冲动度 / 事件性质）、潜台词只给「可能」不给「一定」、深夜或连发质问先缓一缓、回复三基调挑一版且不用群发套话、不替谁做决定、不操控、危机信号先给求助渠道。personal 倾向按场合有强弱：self / scene 充分发挥，dream 只保留「对谁的印象变了」并防漂移，execution 明确不把偏好带进工具参数。

模型参数同样按**场合**分档，但那是认知预算，不是人格配置，见 `infrastructure/models/profiles.ts`：self / dream 开思考（low / high），execution / scene 关思考（低温度求稳、稍高温度求自然）。DeepSeek 思考模式下 `temperature` / `presence_penalty` 静默失效、非思考模式下 `top_p` 恒为 1.0，适配器只发当前模式真正生效的字段。`LLM_THINKING=off|on` 可整体切换，更细的覆盖用构造参数 `profiles` 或单请求 `sampling`。

## 记忆与自主唤醒

这个主体是「群里一个记性不错、会替人留心的常驻伙伴」。提示词和工具说明都用第一人称、以关系为对象：self 醒来想的是谁最近不太好、答应过谁什么、上次哪句话没接好；Dream 夜里回想的是谁和谁有了变化、对某个人的印象被哪两件事改变的。`self.note` 带「关于谁」，`group.say` 让它真的能在群里开口。机器约束（证据下限、稳定 ID、授权边界）一条没少，只是标明「这是记账要求，不是你思考的方式」。

写记忆分两级：任务/场景 session 只做 **L1 append-only 记录**（`self.note` 写结构化经验，不需要模型、不会失败），`DreamService` 周期性做 **L2 提炼**（合并、矛盾裁决、裁剪）。任务不等 self，self 也不必时刻醒着。

**Dream 还会翻出「想做但还没做的事」。** 答应过谁什么、谁最近不太好、有什么值得拿给某个人看——这些是机会（`kind / about / why / urgency / evidence`），不是命令：Dream 把它们经一次筛选交到 self 手里，由 self 决定现在开口、等一等还是不做。凭空编的、把原文整句搬出来当说法的、重复报过的都会被挡掉；`dreamOpportunities: false` 可整体关闭。

**L2 是回放的，不是一次性的。** 同一个整合会话里先把这批经验写一遍（R1），之后每遍都带着同一批经验和「上一遍自己写下的记忆」再看一遍（R2..Rn）：改说法、补证据、把重复的并成一条、把不成立的撤回，直到某遍模型明确说没别的要改（收敛）或到达 `maxRounds`。已有记忆只能通过 `revisions` 修改，不能换个内容重写；证据只会并集，不会因为回放而变少；所有改动按最终差异一次原子提交，`rounds / converged` 记在发布版本上。

`memory/lived.ts` 定义「什么算经历过的事」：门控记账、作业报错、调度心跳这类机器流水一律不进模型上下文，只有外部世界、自己写下的纸条、反思与感受、别人说过的话才算。早期版本没做这层分离，结果 agent 把研究自己的运行时当成了生活——一个人都没记住。

Dream 不再「到点就整合」，而是每周期过一道 **G1–G6 门控级联**：启用 → 最小间隔 → 扫描节流 → 新经验数量与**显著性** → 互斥锁 → 每日配额/记忆压力。显著性按预测误差密度排序（失败 > 矛盾与纠正 > 检索落空 > 新信息），所以全是寒暄的会话不会触发整合。记忆保留旧版本，提炼出的每条经验必须引用 ≥2 个 episode id，原始经验日志永不删。

设计依据、门控顺序与实测结果见 [ARCHITECTURE.md](./ARCHITECTURE.md) 与 [EXPERIMENTS.md](./EXPERIMENTS.md)。

## 代码门槛

结构约束用 [code-quality-gate](https://github.com/iceSheep2003/code-quality-gate) 执行，不靠人工评审：

```sh
npm run quality   # 静态门槛：圈/认知复杂度、嵌套、参数个数、语句数、依赖环
npm run audit     # 完整审计：tsc + 76 个验收用例（JUnit）+ 静态门槛
npm test          # 直接跑全部 76 个用例
```

`quality.config.json` 固定扫描范围（`src`）与阈值。写法上因此有两条硬约定：协作者超过 4 个的类传依赖对象，参数超过 4 个的函数传请求对象。参数个数就是“这个函数需要知道多少东西”的度量。

`cqg audit` 用 `.code-quality-gate/run.lock` 做单实例互斥，结束时删除该目录。若运行环境禁止 `rmdir`（例如受限沙箱），审计会在收尾阶段报 `Configuration ERROR: broker denied delete` —— 此时两项检查其实都已执行并通过，可用 `npm run quality`、`tsc --noEmit` 和 `node scripts/junit.mjs` 分别验证，或在 CI 中运行 `npm run audit`。不要因为这条错误去改代码。若上一轮被中断留下 `.code-quality-gate/run.lock` 空目录，确认无活跃进程后 `rmdir` 即可；受限沙箱连这一步也可能拒绝，同样按上面的降级路径分别复核。

## 验证与限制

`npm run check` 运行 TypeScript 编译、架构依赖检查、独立主体单元测试和行为/进程测试。详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 中的验收对应。

**自动化验收**（`npm test`，99 个用例）使用脚本模型与本地 HTTP stub，**不调用收费模型、不进网络、不依赖真实平台账号**，因此 CI 可复现。它证明机制与依赖边界，包括长跑上下文有界、失败决策整体回滚、载荷预算、Dream 门控顺序与锁释放，以及「系统流水不进记忆上下文」。

**真实模型评估**是独立的 `scripts/evaluate.ts`，需要 `.env` 里的 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`，不计入验收用例、也不进 CI。它曾暴露 `max_tokens` 对推理模型过小导致 JSON 被截断的问题。方法与四个对照样本的结果（包括一个**未支持假设**的结论）全部记在 [EXPERIMENTS.md](./EXPERIMENTS.md)。即便如此，长期自主行为质量仍未被充分验证。

尚需按实际应用进一步完善：中文语义检索、能力目录大规模检索、精确上下文/金额预算、目标相关性排序、记忆归档、平台对账和管理前端。目标与活动增多后应改进检索和调度，不应把全量列表交给中央 self。
