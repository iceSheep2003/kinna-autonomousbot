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

`DreamService` 读取永久经验日志的一个不可变前缀和已有记忆，在**同一个整合会话里回放 R1..Rn 遍**（见下文「Dream 回放」），最后校验来源、输入记忆版本和游标，一次发布记忆版本、保留旧版本、推进游标、通知 self。处理中到达的新事件保留给下一批；失败不推进游标。

Dream 只拿 `MemoryRepository`、`ExperienceLog` 和反馈接口。不能调用 `SubjectService` 或执行服务；建议由后续 self 回合评估。

### Dream 回放：R1..Rn 的修订迭代

Claude Code 的 Auto Dream 是一个**带工具的子代理**：它先概览、再检索会话记录、再整合、再清理索引，中间会反复读。一次性「读完 → 一次性输出」少了这个过程——模型从没回头看过自己刚写了什么，于是同一批素材里会写出三条互相重复、互相矛盾的记忆。`DreamService` 用**同一批经验回放多遍**补上这一段：

| 遍 | 上下文 | 允许的产出 |
|---|---|---|
| R1 先写 | 本批 lived 经验 + 已有记忆 `workspace` | `memories`（新写）、`revisions`（改旧说法）、`retractions`（撤回旧记忆）、`failedApproaches`、`proposals` |
| R2..Rn 修订 | 同一批经验 + **上一次写下的 workspace** + `replay{round, episode, workspace}` | 只做增量：`revisions`（改内容/补证据/`mergeInto` 合并）、`retractions`、少量新 `memories` |

- **收敛**：某遍所有字段都留空 = 模型认为没有别的要改，立刻停止，不再付费回放；`DreamVersion.rounds / converged` 记录回放了几遍、是否收敛。
- **只改不重写**：R2 起不允许用同一个 id 换个内容重写（`Replay pass tried to rewrite an existing memory; use revisions`），已有记忆只能通过 `revisions` 修改。快照外（不在 `prior` 里）的记忆一个字段都不能改。
- **证据只会变多**：补证据做并集，回放给出更窄的证据不能抹掉已有证据；改完仍要过证据门槛（推论/策略 ≥2 条）。合并只搬证据，内容以被并入的那条为准；同一遍里修订与撤回同时出现时以撤回为准。
- **提交**：按最终工作副本与库的差异生成 `write / retract / merge`，在 worker 的事务里一次落库；撤回与合并不删历史，把状态改成 `superseded`，读取侧按状态过滤。
- **成本**：默认 `maxRounds = 3`（`DREAM_POLICY`，可注入覆盖）。R1 用 high 思考，R2 起降思考档并压低温度；`dreamBatch` 决定一批看多少经验，回放遍数决定这一批花几次模型调用。

### 机会：Dream 只翻出来，self 决定做不做

Dream 看不到目标、对方在不在线、今天开过几次口，所以它不产生任何动作，只把「想做但还没做的事」单独翻出来，作为素材进 self 的 inbox：

| kind | 含义 | 例 |
|---|---|---|
| `follow_up` | 答应过谁什么、约好过什么，还没做到 | 答应周末前帮小林看复习节奏 |
| `check_in` | 谁最近不太好，隔了几天还没有下文 | 小林连续两晚情绪低，没人再问过 |
| `share` | 看到/想到一件东西，适合拿给某个人看 | 读到一篇和他最近的事有关的文章 |
| `observe` | 值得继续留意，但现在还不用动 | 对方说想自己弄，先别主动问 |

每条带 `id / about / why / urgency(now|today|when_idle) / evidence`。投递前过一道纯函数筛子（`memory/opportunity.ts`）：

- **凭空**：evidence 指不到本批 lived 素材 → 挡；
- **越界**：`about` / `why` 里整句搬了素材原文（等于替 self 把话说了）→ 挡；
- **重复**：同一个人、同一件事已在列表里 → 留更急的那条；最近几次整合（`MemoryRepository.recentDreams`）报过的 → 挡；
- 最多 6 条，按紧急度排序；被挡的原因写进 `dream.opportunity.rejected` 经验，便于事后看 Dream 为什么总在瞎提。

投递路径：`DreamFeedback.completed(report)` → `inbox.notify('dream.opportunity', …)` → 下一次 self 醒来在 observations 里看到 → 由 self 用现有的 `act` / `schedules` 决定现在做、等一等还是不做。Dream 仍然拿不到 `SubjectService` 与执行服务；把 `dreamOpportunities` 设为 false 只关投递，整合照常发布记忆。

### 两级写入路径

写记忆分成两层，**任务 session 不经过 self**：

| 层级 | 谁写 | 内容 | 是否需要模型 |
|---|---|---|---|
| L1 原始层 | 任务/场景 session，或 `self.note` 能力 | append-only 的 `note.observation` / `note.result` 等结构化经验 | 否 |
| L2 提炼层 | `DreamService`，由门控触发 | 合并、矛盾裁决、裁剪，产出带 evidence 的记忆 | 是 |

这样拆的理由是延迟与可用性：如果任务要同步等 self 想完才能记笔记，self 就必须时刻醒着，而「空闲」恰恰是 dreaming 的前提。L1 不会失败（纯追加），L2 失败下次再来即可。

`self.note` 与 `group.say` 由 `integrations/builtin.ts` 注册，`allowedTools` 默认包含两者。记忆的**唯一写入者仍是 self 侧的角色**——L1 只是给这个角色一个不需思考的手，不是让场景 session 拥有记忆写入权。

`group.say` 让「主动交流」不只是提示词里的一句空话：没有发送通道时，模型看两轮就会判断自己无事可做而选择休息。说出去的话同样写进经验日志，Dream 才看得到「我说了什么 / 对方怎么回」的完整对话，而不是只看到别人的消息。纸条带可选的 `about` 字段（关于谁），让每张纸条都有社交锚点，同一个人的事才串得起来。

### 什么算「经历过的事」

`memory/lived.ts` 定义这个判定，门控与 `DreamService` 共用同一套素材，保证「为什么触发」和「看到什么」一致。

判定顺序是**先排除机器流水，再看来源**：`job.*` / `dream.*` / `schedule.*` / `tool.*` / `scene.*` 等无论 source 标成什么都不算经历；剩下的 `world` / `user` 来源、自己写下的 `note.*`、`reflection`、`affect.appraisal`、别人说的 `*.message`、以及 `memory.miss` 才算。白名单而非黑名单，是为了让以后新增的运行时流水默认不进主体记忆。

这条是实测逼出来的。早期版本把全部经验交给模型，结果 `job.error` 还被 `salience` 当成「失败」给了最高权重——系统一报错就触发整合，agent 于是反复琢磨门控为什么拦它、作业错误分几类，一个人都没记住。不是模型跑偏，是给它看错了东西。

Dream 仍按**全量**经验推进游标（否则系统流水会卡在同一批被反复读取），但只把 lived 那部分交给模型；一批全是流水时不调模型、不叫醒 self，只写一条空整合占掉这段游标。

### Dream 触发：门控级联，不是定时器

原先 `dreamIntervalMs` 到点就整合。现在周期只负责问一句「现在该不该整合」，由 `DreamGate` 按开销从低到高逐级淘汰：

| 门 | 判断 | 被挡时的含义 |
|---|---|---|
| G1 | 是否启用 | 配置关闭 |
| G2 | `minHours` 是否到了 | 距上次整合太近 |
| G3 | `scanThrottleMs` 是否到了 | **防止门控短路后重复扫描** |
| G4 | 新经验条数 / 显著性分数是否够 | 没有值得学的东西 |
| G5 | 锁是否可获取 | 已有整合在跑 |
| G6 | 今日次数 / 记忆压力预算 | 配额或索引压力上限 |

G3 专门补一个容易踩的坑：前几道通过、卡在后面时，若状态没前进，下一轮会重复同一轮扫描。所以每次扫描都写 `lastScanAt`，与「上次整合时间 `lastAt`」分开存。

**显著性（`memory/salience.ts`）** 是这套门控与 AutoDream 那类纯数量门控的主要区别。按预测误差密度排序：失败 > 矛盾/纠正 > 检索落空 > 新信息。全是「你好」「谢谢」的五个会话不该触发整合。`scoreSalience` 只认经验 `kind` 与 `source` 的保守归类，认不出的不计分。

**门控自己写的记账不是经验。** `snapshot()` 会过滤 `dream.gate` / `dream.gate.blocked` 等自身记录，否则门控每检查一次就给自己造一条「新经验」，最终自我触发。这属于写入通道的回灌问题，两层写入路径里必须显式切断。

**锁（`DreamLock`）** 在端口层声明接口，实现放 `infrastructure/locks/`。默认注入进程内互斥锁，跨进程由文件锁提供；`app` 不直接依赖基础设施。锁覆盖「读经验 + 调模型」这段真正耗时的部分，**提交是瞬时的，不占锁**；`finally` 里释放，作业失败或超时也不会把锁焊死。

### 保真度探针

`memory/probe.ts` 做 held-out 式校验：Dream 发布后，用原始经验里的具体事实去比对提炼结果，给出 `retention`（会不会丢事实）。目的是让「dream 之后变聪明了」这句话至少有一个可证伪的成本/效果指标，而不只上报 `hours_since`、`sessions_since` 这类成本数据。

配合一条硬规则：**每条提炼出的经验必须引用 ≥2 个具体 episode id，否则丢弃**；原始经验日志永不删，记忆只是带指针的物化视图。两者一起挡「整合漂移」——多轮摘要后长出「要注意代码质量」这种自信的废话。

方法与实测结果记录在 [EXPERIMENTS.md](./EXPERIMENTS.md)。

### 提示词：以人为对象，不是以系统为对象

`self/session.ts` 与 `memory/dream.ts` 的指令刻意用第一人称、以关系为对象：self 醒来想的是「谁最近不太好、答应过谁什么、上次哪句话没接好」，Dream 夜里回想的是「谁和谁有了变化、我对某个人的印象被哪两件事改变的」。工具说明也写成「给自己留张纸条」「翻回当时记下的原话」，而不是「追加经验日志」「按序号读取原始经验」。

原因很直接：**模型会照着提示词和工具说明的口气组织内容**。早期写的是「整理不可变经验片段，提炼观察、推测和策略」，模型便真的把自己当成一条数据管道，产出的记忆全是门控拦截原因和作业错误分类。三种 `Memory.kind` 没变，但提示词里把它们对应到人的三种回想：亲历的一件具体事、对一个人或一段关系的判断、以后相处的分寸。

所有机器约束（evidence 下限、稳定 ID、schedule 语义、授权边界、JSON schema）一条没少，只是挪到末尾并标明「这是记账要求，不是你思考的方式」。

主体默认值也收敛到社交场景：`identity` 是「群里一个记性不错、会替人留心的常驻伙伴」，`tendencies` 是「记住谁说过什么」「有来有往」「答应过别人的事要兑现」，第一次唤醒的触发文本从 `You can explore; no assigned task.` 换成了具体的群场景。评估脚本的场景同样改成带 `userId` / `name` 的多轮对话，含情绪变化、前后呼应和一个被搁置的约定——匿名素材下，模型就算想记人也没有对象。

### 只有一个主体，参数按场合而非按人格分

社交化之后又发现一个概念错误：把 `self` / `scene` / `execution` / `dream` 当成四个「角色」、各写一套「你是……」，模型就会表现成四个人。现在四种场合的指令开头统一是「还是你，同一个人」，只补「这会儿在做什么」，身份、记性、脾气不随 session 切换。唯一人格定义在 `shared/persona.ts`；`SOCIAL_LINES` 是从「为人处事」借来的待人口径（先接住人、五维量温、潜台词只给可能、冲动拦截、三基调、反操控、危机转介），self / scene 完整注入，dream 只取防漂移部分，execution 不带。

要区分三层：**身份唯一**；**personal 倾向按场合有强弱**（self / scene 强、dream 轻、execution 零，`AGENT_CONFIG.personal=false` 只关偏好不关身份）；**采样参数按场合分档**（认知负荷，与人格无关）。`shared/model.ts` 的 `ModelSampling` 是 port 层意图，`infrastructure/models/profiles.ts` 给四档默认值，`OpenAICompatibleModel` 只发送当前模式真正生效的字段——思考模式下温度类参数被静默忽略、非思考模式下 `top_p` 恒为 1.0，把无效参数发过去只会让配置看起来在起作用。`max_tokens` 与超时也按场合分：dream 16k / 180s，scene 1.5k / 25s；原先 `memory/dream.ts` 里硬编码的 `timeoutMs: 180_000` 已删除，否则会盖掉档位配置。

## 场景扩展

新增平台只需实现 `EnvironmentPlugin`：注册能力，接收平台事件并转换为 `IncomingEvent`。插件不拿 Repositories、数据库或主体写服务。QQ/B站/后续平台没有各自的常驻自主 Agent；跨平台行动由同一个主体形成意图，再由局部执行组合工具。

B 站的边界值得单独说：读（渲染 DASH 流截图看视频、读评论、读弹幕分布）是能力，写（评论、动态）是**公开动作**。所以写没有直接工具，只有 `bilibili.draft_*` 出草稿；批准走 owner 的 HTTP 接口，模型拿不到这个端口，`test/bilibili.test.ts` 里有一条专门验证「列出的响应里没有 cookie」。登录态与 csrf 只在 `infrastructure/bilibili/client.ts` 出现，集成层连 cookie 的概念都没有。

`integrations/builtin.ts` 展示记忆查询、原始证据读取、模拟环境与 Brave 搜索接入。`examples/local-environment.ts` 展示完整环境插件。生产插件还需实现认证、发送对象范围、平台限流、资源读取和业务回执语义。

## 代码门槛与结构约定

`quality.config.json` 与 `npm run quality` 使用 code-quality-gate 的内置检查约束结构：每函数圈复杂度 ≤10、认知复杂度 ≤15、控制流嵌套 ≤4、参数 ≤4、AST 语句 ≤40，每文件 ≤500 行，并检查相对导入的依赖环。

由此固定三条写法约定：

- 协作者超过 4 个的类接收单一依赖对象（`WorkerDependencies`、`SceneDependencies`、`RunnerDependencies` 等），字段在构造函数中显式赋值，不在签名里堆参数。
- 参数超过 4 个的函数接收请求对象（`InvocationRequest`、`SendInput`、`StepFrame`、`ChannelRequest`）。
- 长函数按“一次只做一件事”拆成有名字的私有方法；分支链改为分发表（QQ 消息片段解析、TTS 供应商请求、媒体类型嗅探）。

`npm run audit` 另外执行 tsc 与 76 个验收用例，并输出 `.quality/code-quality-gate/report.html`。审计用 `.code-quality-gate/run.lock` 保证单实例，收尾时删除该目录；若运行环境禁止 `rmdir`，会报 `Configuration ERROR: broker denied delete`，此时两项检查均已执行通过，应分别用 `npm run quality`、`tsc --noEmit`、`node scripts/junit.mjs` 复核，而不是改代码。

## 自动化验收

`test/architecture.test.ts` 使用 TypeScript AST 读取依赖并验证：

- 核心不能依赖基础设施、应用层或平台实现。
- 核心跨模块只能导入类型和 port，不能直接导入其他模块实现。
- subject 只依赖自身与 shared；memory 同样没有主体或执行写通道。
- 应用协调不依赖具体数据库；平台插件不引用领域实现。
- 核心文件中不出现 Store、数据库连接或 SQL prepare API。

`test/subject.test.ts` 使用内存实现验证主体、目标和情绪，完全不启动数据库或模型。

`test/runtime.test.ts` 与 `test/process.test.ts` 验证自主初始化、局部执行、直接动作、事件竞态、调度失效、原子回滚、Dream 增量发布、崩溃后复用写回执、预算、HTTP、插件以及真实进程启动/停止。

`test/autonomy.test.ts` 验证三件事：长跑 150 轮后每轮上下文仍不超过 `ContextLimits`（增长只发生在经验日志，不在上下文）；决策越权时目标、执行、日程整体回滚；入口载荷超过 `payloadBudget` 时被拒绝且不落库。

`test/opportunity.test.ts` 验证机会筛子：证据越界、内联原文、批内与跨批重复、排序与上限、坏 schema 不拖垮整合；`test/runtime.test.ts` 端到端验证「L1 纸条 → Dream 翻出机会 → 进 self inbox」，以及关掉开关后不投递。dream.test.ts 验证门控顺序（G1–G6 各自的拦截原因）、G3 节流确实阻止重复扫描、显著性权重排序（失败 > 纠正 > 新信息）、门控记账不回灌、锁在作业失败后能释放，以及「≥2 条证据」的校验规则；另覆盖回放：第 2 遍才拿到 `replay` 与上一遍的 workspace、收敛即停、撤回与合并的最终落库形态、回放修订同样受证据门槛约束、不能用新内容重写已有记忆、旧记忆能在回放里被改说法。

`scripts/evaluate.ts` 是接真实模型的长跑评估（压缩时间轴），产出 `.quality/eval/<label>/summary.json`。它需要 `.env` 里的 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`，默认不给写能力，可用 `ENABLE_NOTE` 切换。它不进 CI，也不计入验收用例数。

## 场景 session 与 self 的触发边界

`execution/scene.ts` 管理持续的场景会话，各自保留观察游标、近期决策和前情。场景自己处理消息、使用工具或等待，工具回执仍在本地。`reflect` 是明确的上报决策，需要触发类型、摘要和本场景证据；只有此时才创建 `scene.reflection_requested` 来唤醒 self。普通回复、欢迎、戳一戳及工具成功不会自动走 self。

QQ 插件按账号、群/私聊和对象生成 sessionId；其他环境可以使用同一通用 session 机制。场景工具调用由宿主传入 scope，平台适配器校验该 scope，模型不能通过改工具参数切换会话。场景没有主体、目标或情绪的写接口。
