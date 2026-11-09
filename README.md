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

## 恢复与部署范围

构建会清理旧 dist，避免保留重构前的模块。SQLite 的已有主体、会话、目标、经验、操作记录和日程沿用原表和键；新增对象相关情绪与结构化反思使用独立 collection。

Worker 串行推进作业，所有模型/网络调用在事务外进行。本地状态、当前作业完成和后续作业在同一个事务提交。进程重启恢复运行中的作业。

写操作先记账。已经确认的操作复用回执；网络结果不明标记 uncertain 并暂停，不自动重发。仍需具体平台的对账能力，本版没有通用人工核销接口，也不保证平台级 exactly-once。

SQLite 租约用于防止意外双实例。本实现按单进程部署，不是分布式队列/多副本调度器。生产公开服务还需要部署层的 TLS、入口限制与平台连接配置。

## 代码门槛

结构约束用 [code-quality-gate](https://github.com/iceSheep2003/code-quality-gate) 执行，不靠人工评审：

```sh
npm run quality   # 静态门槛：圈/认知复杂度、嵌套、参数个数、语句数、依赖环
npm run audit     # 完整审计：tsc + 40 个验收用例（JUnit）+ 静态门槛
```

`quality.config.json` 固定扫描范围（`src`）与阈值。写法上因此有两条硬约定：协作者超过 4 个的类传依赖对象，参数超过 4 个的函数传请求对象。参数个数就是“这个函数需要知道多少东西”的度量。

## 验证与限制

`npm run check` 运行 TypeScript 编译、架构依赖检查、独立主体单元测试和行为/进程测试。详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 中的验收对应。

自动化测试使用脚本模型与本地 HTTP stub；没有调用收费模型或真实平台账号。测试证明机制和依赖边界，不证明长期自主行为质量。`test/autonomy.test.ts` 补上了长跑有界性、失败决策的整体回滚和载荷预算三条性质，但仍不能替代真实模型下的行为评估。

尚需按实际应用进一步完善：中文语义检索、能力目录大规模检索、精确上下文/金额预算、目标相关性排序、记忆归档、平台对账和管理前端。目标与活动增多后应改进检索和调度，不应把全量列表交给中央 self。
