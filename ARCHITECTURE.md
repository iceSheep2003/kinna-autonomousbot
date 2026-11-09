# 设计与代码对应

此实现沿用已经确定的主体、长期 self、局部执行、运行机制四个层次，并把各层的状态所有权落实为 TypeScript 模块与仓库接口。它们属于同一个后端项目，共用事务提交；不拆成独立微服务，也不为每个平台创建一个自主主体。

## 模块所有权

| 模块 | 拥有的状态/规则 | 对外接口 | 不承担的职责 |
| --- | --- | --- | --- |
| `subject` | 身份、倾向、方向、整体心境、人物/主题感受、目标与版本、目标父链规则 | `SubjectView`；应用层使用 `SubjectService.apply`、`GoalService`、`AffectService` | 模型调用、会话、日程、执行、平台调用 |
| `self` | 唯一长期 self 会话、已处理观察游标、本轮上下文与结构化决策 | `SelfSession.prepare`；`SelfSessionRepository`；`SelfCommitter` | 直接写目标/情绪/任务存储，执行平台 API |
| `execution` | 具体行动、长期场景 session、局部进度和对话、步骤预算、执行结果 | `ExecutionService.launch/act/pause/invalidateGoal`；`ExecutionRunner.prepare`；`ExecutionView` | 修改主体身份、方向、总体目标 |
| `memory` | 原始经验、总结/反思记录、检索、Dream 游标、记忆版本 | `ExperienceService`、`ReflectionService`、`MemoryService`、`DreamService` | 直接修改主体、创建目标、启动行动 |
| `runtime` | Inbox、事件去重、作业生命周期、持久定时器、周期唤醒、资源预算、恢复 | `Inbox`、`Scheduler`、`Worker`；`JobHandler`、`SchedulePolicy` | 决定想做什么，判断人格、兴趣或情绪 |
| `capabilities` | 工具注册、schema、授权校验、调用账本、结果不确定性 | `CapabilityRegistrar`、`CapabilityAccess`、`OperationRepository` | 平台登录、主体规划 |
| `integrations` | 环境接入、消息/资源转换、具体工具实现 | `EnvironmentPlugin.setup/start/stop` | 读取全库或调用领域写服务 |
| `infrastructure` | SQLite 仓库实现、模型供应商协议、HTTP 适配 | 实现各模块声明的 port | 把存储/API 细节带进核心模块 |
| `app` | 依赖装配与跨模块用例，连接目标变更、执行失效、日程失效 | `composeAgent`、`DecisionCommitter`、`AdminApi` | 具体 SQL、SQLite 驱动、平台业务 |
| `shared` | 模型、事务、限额和基础校验契约 | 小型通用接口 | 集中所有领域类型或全能 Store |

每个核心模块的仓库接口定义在自己的 `ports.ts`。SQLite 的通用文档读写仅存在于 `infrastructure/sqlite/database.ts` 及适配器中。核心模块既拿不到数据库连接，也不能任意指定 collection 访问别人的状态。

## 永久主体与永久 self

`subject/self` 的数据独立持久化；self 会话中不存放主体的唯一真相。`SubjectService` 可在没有 LLM、会话或数据库实现的情况下独立运行。

`self/session.ts` 每次被唤醒，使用 `SelfContextBuilder` 构造有界输入：主体快照、相关目标、相关记忆、当前观察、近期决策、有限执行/日程视图和可用能力。原始 turn 继续追加到稳定的 `self` 会话。会话永久存在不意味着一个无限上下文，也不意味着每个事件都要进入 self。

self 的写权限仅表现为 `SelfCommitter.apply` 契约。应用层实现该契约，调用主体、执行、调度与反思服务；self 模块自身没有目标仓库或 SQLite Store。

## 自主性如何进入 loop

初始化只给身份、倾向和可接触的能力边界，投递一次 `initialized`。周期反思提供没有外部消息时的思考机会。模型自行形成方向、选择是否行动和形成目标；运行时不会为它预填“每天必须做”的任务清单。

一轮 self 决策可以同时包含：

- `direction`、`focus`：调整方向或当前关注。
- `affect`：带经验引用和解释的情绪评价，可选 `target`。
- `goals`：建立/修订短期或长期目标，或者暂停、完成、放弃已有目标。
- `act`：参数已确定的即时工具调用。
- `launch`：需要探索与局部决策的意图，创建独立执行上下文。
- `schedules`：安排未来重新思考、启动意图或直接调用工具。
- `cancelExecutions`、`cancelSchedules`：撤销已有投入。
- `dream`：请求离线经验整理。
- `nextWakeAt`：明确安排下次思考。

可以只反思并选择休息。自主决策的质量依赖模型及环境反馈；架构不保证生成的兴趣、计划一定有价值。

## 三种行动与调度

`act` 进入持久执行记录与工具账本，但不创建局部 LLM 对话，不消耗额外模型轮次。它仍需要边界校验和实际平台回执。

`launch` 创建一个有限的执行上下文。它知道自己的 `intent`、关联目标、已选工具范围、`progress`、观察和近期决策，可以自行搜索和改变局部策略。局部工具结果回到自己，完成或无法继续时才反馈 self。

日程支持三种动作：

| 类型 | 到时发生什么 |
| --- | --- |
| `wake` | 把复查原因写入 self inbox，重新思考 |
| `execute` | 启动预先记录的意图，由局部上下文继续判断步骤 |
| `tool` | 使用已记录参数直接调用工具，无需再开一轮 LLM |

目标关联的日程保存目标版本。应用层在主体目标修订后调用 Scheduler 与 ExecutionService，使旧日程取消、旧执行暂停。Scheduler 通过 `SchedulePolicy` 查询有效性，不知道目标具体存储在哪里。

较长计划通过目标、具体执行和复查日程连接，不靠中央认知每次扫描全部活动。初版相关性检索简单，目标规模扩大时应改进检索，而不是不断增加 prompt 中的活动数量。

## 事件与事务

`Inbox.ingest` 负责统一事件接入。普通环境消息路由到其持续场景 session，具体执行结果路由到发起它的执行；只有主体反思触发事件路由到 self，也可仅追加经验。外部结果默认应返回发起它的执行上下文；显著发现、方向冲突、完成反馈、定时反思再唤醒 self。

Worker 对每个作业分两个阶段：

1. `prepare` 在事务外构建上下文、调用 LLM/工具，生成提交函数。
2. 在一个事务内完成当前作业并调用提交函数，保存状态、会话、游标和后续作业。

先在同一事务中标记当前作业完成，才允许创建同 key 的后续作业；事务失败时两者一起回滚。因此不会出现“状态已提交但作业仍待重放”的中间状态。

外部副作用无法纳入数据库事务。工具选择和 operationId 在调用前持久化；已确认完成的调用复用回执，结果未知时暂停并反馈，不盲目重发。平台不支持幂等键/查询回执时，不宣称 exactly-once。

## 情绪、总结、记忆和 Dream

整体心境保存在主体；人物/主题感受按 target 保存。每次 appraisal 的来源与当时解释追加到经验日志。后续解释可以改变当前感受，不删除过去的评价。

`ReflectionService.record` 保存带来源的 summary、conclusions 和 proposedChanges。self 每轮反思使用此接口；它本身不修改主体目标。

`DreamService` 读取永久经验日志的一个不可变前缀和已有记忆，生成候选。校验来源、输入记忆版本和游标后，一起发布记忆版本、保留旧版本、推进游标、通知 self。处理中到达的新事件保留给下一批；失败不推进游标。

Dream 只拿 `MemoryRepository`、`ExperienceLog` 和反馈接口。不能调用 `SubjectService` 或执行服务；建议由后续 self 回合评估。

## 场景扩展

新增平台只需实现 `EnvironmentPlugin`：注册能力，接收平台事件并转换为 `IncomingEvent`。插件不拿 Repositories、数据库或主体写服务。QQ/B站/后续平台没有各自的常驻自主 Agent；跨平台行动由同一个主体形成意图，再由局部执行组合工具。

`integrations/builtin.ts` 展示记忆查询、原始证据读取、模拟环境与 Brave 搜索接入。`examples/local-environment.ts` 展示完整环境插件。生产插件还需实现认证、发送对象范围、平台限流、资源读取和业务回执语义。

## 代码门槛与结构约定

`quality.config.json` 与 `npm run quality` 使用 code-quality-gate 的内置检查约束结构：每函数圈复杂度 ≤10、认知复杂度 ≤15、控制流嵌套 ≤4、参数 ≤4、AST 语句 ≤40，每文件 ≤500 行，并检查相对导入的依赖环。

由此固定三条写法约定：

- 协作者超过 4 个的类接收单一依赖对象（`WorkerDependencies`、`SceneDependencies`、`RunnerDependencies` 等），字段在构造函数中显式赋值，不在签名里堆参数。
- 参数超过 4 个的函数接收请求对象（`InvocationRequest`、`SendInput`、`StepFrame`、`ChannelRequest`）。
- 长函数按“一次只做一件事”拆成有名字的私有方法；分支链改为分发表（QQ 消息片段解析、TTS 供应商请求、媒体类型嗅探）。

`npm run audit` 另外执行 tsc 与 40 个验收用例，并输出 `.quality/code-quality-gate/report.html`。

## 自动化验收

`test/architecture.test.ts` 使用 TypeScript AST 读取依赖并验证：

- 核心不能依赖基础设施、应用层或平台实现。
- 核心跨模块只能导入类型和 port，不能直接导入其他模块实现。
- subject 只依赖自身与 shared；memory 同样没有主体或执行写通道。
- 应用协调不依赖具体数据库；平台插件不引用领域实现。
- 核心文件中不出现 Store、数据库连接或 SQL prepare API。

`test/subject.test.ts` 使用内存实现验证主体、目标和情绪，完全不启动数据库或模型。

`test/runtime.test.ts` 与 `test/process.test.ts` 验证自主初始化、局部执行、直接动作、事件竞态、调度失效、原子回滚、Dream 增量发布、崩溃后复用写回执、预算、HTTP、插件以及真实进程启动/停止。

## 场景 session 与 self 的触发边界

`execution/scene.ts` 管理持续的场景会话，各自保留观察游标、近期决策和前情。场景自己处理消息、使用工具或等待，工具回执仍在本地。`reflect` 是明确的上报决策，需要触发类型、摘要和本场景证据；只有此时才创建 `scene.reflection_requested` 来唤醒 self。普通回复、欢迎、戳一戳及工具成功不会自动走 self。

QQ 插件按账号、群/私聊和对象生成 sessionId；其他环境可以使用同一通用 session 机制。场景工具调用由宿主传入 scope，平台适配器校验该 scope，模型不能通过改工具参数切换会话。场景没有主体、目标或情绪的写接口。
