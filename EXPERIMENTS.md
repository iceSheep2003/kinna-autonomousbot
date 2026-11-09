# 实验记录

这份文件记录每次评估「怎么跑的、结果是什么、读出了什么」。追加写，不覆盖历史，
方便对比不同设计的效果。数字全部来自 `.quality/eval/<label>/summary.json` 与同目录的 `decisions.jsonl`。

---

## 0. 怎么读这些数字

| 指标 | 含义 | 期望方向 |
| --- | --- | --- |
| `self轮次.空转率` | 一次 self 决策既没有 launch/act/goals/schedules 的比例 | 越低越好，但 0 也可疑（可能在瞎忙） |
| `写通道.total` | agent 主动写入经验日志的条数 | 越高说明越把「留痕」当成习惯 |
| `Dream.次数` | 真正提交成功的整合次数 | 与 `拦截分布` 一起看，不是越多越好 |
| `Dream.拦截分布` | 各门控拦下的累计次数 | 用来看门控是不是过紧或过松 |
| `Dream.明细[].retention.rate` | 本批输入的关键词有多少留在产出记忆里 | 太低说明压缩丢事实，太高说明只是抄写 |
| `Dream.整体保留率` | 全量经验 → 全量记忆的关键词保留率 | 同上 |
| `记忆.unreferenced` | 只有 1 条证据的记忆数 | 越低越好；推论/策略应 ≥2 条 |

判读顺序建议：先看 `写通道` 与 `空转率`（自主性），再看 `Dream.拦截分布`（触发是否合理），
最后看 `retention`（整合是否有损）。

---

## 1. 实验环境

- 模型：`deepseek-flash`（DeepSeek-V4.1-Flash），`max_tokens=16000`
- 时间轴：压缩模拟。`START = 1800000000000`，每 `STEP_MINUTES` 分钟一拍，全部用逻辑时钟
- 外部事件：7 条（群消息 + 新闻），其余时间**没有任何人给指令**
- 场景文本固定，见 `scripts/evaluate.ts` 的 `scenario()`
- 每次运行前删除同名数据库（`KEEP_DB=1` 可保留），保证从空状态开始

复现方式：

```bash
cd outputs/autonomous-agent
DAYS=1 LABEL=day1-note ENABLE_NOTE=1 MAX_CALLS=120 GATE_MIN_EPISODES=8 npx tsx scripts/evaluate.ts
DAYS=1 LABEL=day1-baseline ENABLE_NOTE=0 MAX_CALLS=120 GATE_MIN_EPISODES=8 npx tsx scripts/evaluate.ts
```

---

## 2. 实验 0：冒烟轮（验证管线，数据不作结论）

**目的**：确认门控真的会触发、`self.note` 真的会被调用、指标真的能落盘。

**配置**：`DAYS=1 STEP_MINUTES=30 REFLECTION_HOURS=4 GATE_MIN_EPISODES=6 MAX_CALLS=70`

**结果**（中途停止，未跑满 24 小时）：

| 指标 | 值 |
| --- | --- |
| 经验日志 | 86 条 |
| 记忆 | 22 条 |
| 门控放行 / 提交成功 / 落库版本 | 7 / 4 / 2 |
| 写入的笔记 | 4 条（intent 1、observation 2、result 1） |
| 墙钟耗时 | 9 分 16 秒（被超时重试拖慢） |

**这一轮抓到 4 个缺陷，全部已修**：

1. **Dream 调用 60 秒超时，失败后重试三次。** `job.error` 里有 4 条
   `TimeoutError: The operation was aborted due to timeout`。原因是一批要读 80 条经验
   加 40 条旧记忆，输出上限 16000 token，60 秒不够。修法：`ModelRequest` 增加可选
   `timeoutMs`，Dream 单独放宽到 180 秒；其它角色仍是 60 秒。
   这也是单日运行被拖到 9 分钟的直接原因。

2. **门控在「入队到被领取」的空档里占着锁。** `g5.lock` 被挡了 13 次。
   门控通过后把作业塞进队列，但队列里可能排着别的作业，锁就一直被占，
   下一拍检查又看到锁被占，于是刷出一堆无意义的拦截记录。
   修法：锁移到执行侧（`gate.tryLock()` 在 `dream` 作业的 `prepare` 里取），
   门控只做决策。锁的语义回到「保护真正耗时的整合」，而不是「标记我要整合」。

3. **门控自己的记账会被算成新经验，形成自我触发。** 门控拦下时会写一条
   `dream.gate.blocked`，这条记录落进经验日志，下一拍就被 `episodes` 数进去，
   于是「拦得越多 → 越容易触发」。修法：`snapshot()` 里过滤 `dream.gate*` 与
   `dream.completed`，只统计真实信息。

4. **体积门控数的是系统噪音。** 原始实现把 `execution.finished`、`tool.result`、
   `goal.revised` 全算成「未整合经验」，这些是运行时流水，不是新信息。
   短期表现为门控过于灵敏（`GATE_MIN_EPISODES=6` 几乎每拍都满足）。
   已通过第 3 条同样的过滤缓解；更彻底的做法是按 source 分层计数，见「待办」。

**质量观察（本轮最有价值的部分）**：Dream 产出的记忆不是流水账，而是真的在做交叉核对。
原文摘录：

> seq16 记录 g1-initial-exploration 为 active，而 seq37 的 self 作业报"Goal is not active"，
> 说明目标记录与运行时状态存在不一致。

> 应把"环境返回的内容"和"自身记录链路"分开判断：环境内容可能整体是模拟的（因此不可当作知识），
> 而工具回执与我写下的意图记录是在本地可核验的痕迹，可用于检验链路可靠性。

前者是**矛盾检测**（我给 salience 设计的第三类信号），后者是**策略提炼**。
两者的 evidence 分别有 7 条和 4 条引用，符合「推论需 ≥2 条独立证据」的约束。

---

## 3. 实验 1：写通道对照（一天）

**假设**：给 agent 一个 append-only 的写通道（`self.note`），空转率会显著下降。

**变量**：只改 `ENABLE_NOTE`，其余全部相同（同一场景、同一门控参数、同一模型）。
对照组没有 `self.note`，工具面与上一版评估一致。

**配置**：`DAYS=1 STEP_MINUTES=30 REFLECTION_HOURS=4 GATE_MIN_EPISODES=8 GATE_MIN_HOURS=1 GATE_SALIENCE=3`

### 结果：跑了四个样本（两组各两次）

| 指标 | note-1 | baseline-1 | note-2 | baseline-2 |
|---|---|---|---|---|
| 空转率 | 43% | 29% | 0% | 0% |
| self 决策数 | 14 | 14 | 4 | 5 |
| 笔记条数 | 7 | 0 | 4 | 0 |
| 目标数 / 活跃 | 2 / 1 | 4 / 3 | 3 / 2 | 3 / 1 |
| 执行数 | 11 | 3 | 11 | 5 |
| 记忆条数 | 31 | 33 | 22 | 15 |
| 仅单证据记忆 | 1 | 0 | 0 | 1 |
| Dream 次数 | 6 | 6 | 2 | 2 |
| Dream 保留率 | 0.867 | 0.85 | 0.583 | 0.517 |
| 模型调用 | 21 | 21 | 38 | 40 |

### 结论：这个对照**不成立**，不能说写通道降低了空转率

第一对样本看起来是反的（43% vs 29%），第二对看起来是 0% vs 0%。真正的解释不是「写通道没用」，而是**样本量不可控**：

`self` 自己决定 `nextWakeAt`。写通道那一组倾向把下次唤醒设得近（因为有东西想记），于是醒得多、决策多（14 次）；没有写通道的那组醒得少（4~5 次）。**决策数从 4 到 14 不等，空转率的分母本身就在漂**，两组不构成可比样本。四个样本里空转率的跨度（0%~43%）大于组间差，说明这个指标在当前设计下测不出效应。

要修的是实验设计，不是代码：应固定 `self` 的唤醒时刻（或在评估脚本里强制每 N 拍醒一次），让两组的决策次数相同，空转率才有意义。

### 三个仍然成立的观察

这些不依赖空转率，四个样本方向一致：

**1. 写通道确实被使用，而且用得有内容。** note 组 7 条 / 4 条，baseline 组 0 / 0。不是空写——记忆里能看到它对「门控为什么拦我」「job.error 有几类」做了归纳。

**2. 有写通道时执行数明显更高：11 / 11 对 3 / 5。** 这个差异比空转率稳定得多。合理解释是：能记下结果，才敢启动一个要跨多轮才完成的事；记不住就不值得开始。这与「记忆是自主性的前提」一致，但**仍是相关不是因果**——也可能是写通道那组恰好更活跃。

**3. 证据约束在生效。** 四个样本里「仅单证据记忆」都只有 0~1 条，说明「推论需 ≥2 条独立证据」这条硬规则挡住了绝大部分凭空生成的概括。

### Dream 的表现

- 触发次数与经验量相关（note-1 六次，note-2 两次），门控没有空转。
- 保留率从 0.85 降到 0.52 跨度很大，**说明这个指标受批次大小影响**：批次小（note-2）时更容易丢事实。当前批次是 80 条经验，实际很少跑满，这个阈值需要按真实批次重新定标。
- 没有出现「整合出漂亮废话」的情况，但也可能只是因为样本太少。

### 一个暴露出来的真问题

记忆内容显示，agent 反复研究的是**自己的运行时**（门控拦截原因、作业错误分类），而不是场景里的世界。原因是经验日志里 `source=runtime` 的流水占比过高，它看到的信息大部分关于自己。

这不是模型的问题，是**信号配比**的问题：门控的记账记录、作业生命周期、调度心跳全进了同一个经验流，而真正来自外部的事件很少。待办里那条「体积门控按 source 分层」应该升级为必做项——否则 agent 会越来越内省，越来越不关心外面发生了什么。

---

## 4. 实验 2：提示词拟人化与社交信号分层

### 触发

用户反馈：「你的提示词设计有问题，我更希望他是社交相关的功能，所以你让他做 note、以及做 dream，更多是用一个拟人的角度去做这件事」。

回头看实验 1 那条「agent 主要在研究自己的运行时」，和这条反馈是同一件事的两面。当时我归因于「信号配比」，但更上游的问题是**提示词里根本没有出现人**。

### 诊断：三层，缺一不可

1. **self 的指令是调度器语言**：「形成并调整自己的方向」「使用稳定 ID 更新目标」「wake/execute/tool schedule」，通篇没有一个「谁」。模型于是只调度、不交往。
2. **Dream 的指令是数据管道语言**：「整理不可变经验片段，提炼观察、推测和策略」。模型便真的把自己当成一条管道，产出「门控拦截原因」「作业错误分类」这种记忆。工具说明也一样（「追加到不可变经验日志」「按序号读取原始经验」）。**模型会照着提示词和工具说明的口气组织内容**。
3. **给它的素材大部分不是经历**：`job.error` 还被 `salience` 当成「失败」给了最高权重，系统一报错就触发整合。不是模型跑偏，是给它看错了东西。

只改第 1、2 层不够——素材还是流水，拟人提示词只会让它用人话复述系统日志。

### 改了什么

| 位置 | 改动 |
|---|---|
| `memory/lived.ts`（新） | 白名单定义「什么算经历过的事」；**先排除机器流水，再看来源**。门控与 Dream 共用 |
| `memory/dream.ts` | 指令改「夜里把最近发生的事捋一遍，你要记住的是人」；三种 `Memory.kind` 映射到亲历的事 / 对人的判断 / 相处的分寸；只把 lived 经验交给模型；全流水批次不调模型、不叫醒 self，但仍按全量推进游标 |
| `memory/dream-gate.ts` | 门控只数 lived 经验，`job.error` 不再触发「反思人生」 |
| `self/session.ts` | 第一人称、以关系为对象；机器约束全部保留，挪到末尾标明「这是记账要求，不是你思考的方式」 |
| `integrations/builtin.ts` | `self.note` 加 `about`（关于谁）与 `promise` 类型，说明写成「给自己留张纸条」；新增 `group.say`，让「主动交流」不是空话；`memory.search` / `experience.read` 说明改成人话 |
| `app/config.ts` | 默认 identity / tendencies 改成社交向；`allowedTools` 默认含 `group.say` |
| `app/agent.ts` | 第一次唤醒的触发文本从 `You can explore; no assigned task.` 换成具体的群场景 |
| `scripts/evaluate.ts` | 场景从 7 条匿名素材改成 17 条带 `userId`/`name` 的多轮对话，含情绪线、前后呼应、一个被搁置的约定；去掉 `sandbox.observe`（它诱导模型研究系统） |
| `test/dream.test.ts` | 补 3 例：lived 分层判定、Dream 上下文只有经历但游标按全量推进、全流水批次不调模型不通知 |

### 验证方式（按用户要求省 token，没有跑长程对照）

- `tsc --noEmit` 干净；**58/58** 验收用例通过；`cqg check` PASS（80 文件 604 函数 0 违规）。
- 只跑了一次极小烟测，命令：

```sh
DAYS=1 LABEL=smoke-social STEP_MINUTES=60 REFLECTION_HOURS=24 \
MAX_CALLS=6 GATE_MIN_EPISODES=200 GATE_SALIENCE=999 npx tsx scripts/evaluate.ts
```

  刻意把门控阈值调高以**不触发 Dream**，所以这次只验证 self 侧；Dream 的拟人提示词**尚未经真实模型验证**。

### 结果：内容层面变化非常明确

19 次 self 决策、5 张纸条、2 次主动发言，对象是「小林」「阿泽」，空转率 5%。摘录：

> `note.observation | about=小林` 小林今天在群里问 408 怎么排复习节奏，说感觉来不及、很焦虑。我回的是：先别加时长，花二十分钟把四门各剩多少、真题动过没有列出来；并问他现在是四门都还在推还是有哪门放下了。**还没回。这人焦虑的点像是「心里没数」，不是真的懒或拖。**

> `group.say | to=阿泽` 四点才睡、白天发飘，这真不是意志力的事。想先问一句：是躺下睡不着，还是明明困了却不想睡？这两种差得挺远，弄混了怎么调都不对。

> `note.observation | about=群` 之后五个多小时群里没见回音。**别催、别重问一遍一样的，等他们自己接。**

对比实验 1 里的「门控为什么拦我」「job.error 有几类」，主体确实从「系统运维」转成了「惦记几个人」。尤其最后一条是自发形成的相处分寸，提示词里没有写。

### 但这次**不能做归因**，也不做数值对比

实验 1 刚被「样本量漂移」教育过，这次更要说清楚：以上同时改了 **7 类变量**（identity、tendencies、self 提示词、Dream 提示词、工具面、场景素材、信号分层），且只跑了一次、单次样本。5% 的空转率**不能**归功于「提示词拟人化」，也不能说比实验 1 的 29%~43% 变好了——分母、场景、唤醒节奏全都不同。

这一轮只能得出一个定性结论：**给定具名的社交素材 + 一个能开口的工具，模型会按人的方式记事和说话**。要拆出每个变量的贡献，得逐个做单变量对照，成本远高于当前预算，未做。

### 数据污染与已修的问题

烟测报告 `模型调用 20 次 / 失败 15 次`，其中大部分**是我自己造成的**：`LoggedModel` 在超过 `MAX_CALLS=6` 时直接抛错，作业随即重试，把「预算用尽」伪装成「模型失败」，还让调用数一路涨到 20。已改成在主循环里收口并 `break`，`summary` 增加 `提前结束` 标记。**烟测那组失败率不可用于判断模型质量。**

另有 1 次真实 schema 校验失败：`act[1]` 只给了 `name`，漏了 `input` 和 `reason`，`previousAttemptError` 回传后重试自愈。没有为此放宽 `DirectActionSchema`——`reason` 是审计字段，给默认值会削弱约束。

### 未验证项（下次最小成本的做法）

- Dream 的拟人提示词在真实模型下的产出质量。最小验证：`DAYS=1 GATE_MIN_HOURS=0 GATE_MIN_EPISODES=2 GATE_SALIENCE=1 MAX_CALLS=10`，只求触发一次 dream，看 `memories` 里是不是「谁 / 什么事」，而不是「观察到一条消息」。
- `group.say` 目前只把话写进经验日志，没有真的发出去；评估里看不到对方的回应链。生产要接 QQ 发送通道才有完整对话。
- 「记住被搁置的约定」这条场景线（e13/e14）在 1 天烟测里还没走到，需要至少 5 天才能检验 Dream 会不会提炼出「我答应过小林却没做」。

---

## 5. 实验 3：单一主体 + personal 倾向 + 按场合微调模型参数（静态验证，未跑真实模型）

### 触发

用户两点纠正：

1. 「有些地方需要有 personal 的倾向」「有些地方的模型其实不必要开思考，参数上有讲究，需要微调」；
2. 「只有一个角色啊其实，就是这个 agent 本体」——`self` / `scene` / `execution` / `dream`
   不是四个角色，是同一个人在不同场合，身份、记性、脾气必须连续。

第 2 点推翻了我一度采用的设计：给四种 session 各写一套「你是……」的提示词、
按「角色」分配四套采样参数。那样模型会表现成四个人。

### 改了什么（三类变量，同时改）

| 层 | 改动 | 文件 |
|---|---|---|
| 身份（唯一） | 新建 `shared/persona.ts`，集中定义 `Personality`（性子 / 在意什么 / 红线 / 默认基调）与共享分寸 `SOCIAL_LINES`；四处提示词开头统一「还是你，同一个人」，只补「这会儿在做什么」 | `shared/persona.ts`（新）、`self/session.ts`、`execution/scene.ts`、`execution/runner.ts`、`memory/dream.ts` |
| personal 倾向（按场合强弱） | self / scene 注入同一份 `personaText`；dream 只保留「对谁的印象变了」并加防漂移；execution 明确「办事不发挥偏好」。`AGENT_CONFIG.personal=false` 可关掉偏好段落（供 A/B 对照），身份与底线不变 | `app/config.ts`、`app/agent.ts` |
| 模型参数（按场合，不是按人格） | `ModelSampling` 作为 port 层意图；`defaultProfiles` 四档；`OpenAICompatibleModel` 只发当前模式真正生效的字段 | `shared/model.ts`、`infrastructure/models/profiles.ts`、`infrastructure/models/openai-compatible.ts`、`main.ts`、`scripts/evaluate.ts` |

参数表（DeepSeek 官方《思考模式》约束：思考模式下 `temperature` / `presence_penalty` 静默失效，
非思考模式下 `top_p` 恒为 1.0，所以这两类字段在不同档位互斥发送）：

| 场合 | thinking | effort | temperature | presence_penalty | top_p | max_tokens | timeout |
|---|---|---|---|---|---|---|---|
| self 自己想事情 | on | low | — | — | 0.95 | 8 000 | 90 s |
| dream 夜里回想 | on | high | — | — | 0.95 | 16 000 | 180 s |
| execution 办事 | off | — | 0.3 | 0.2 | — | 2 000 | 30 s |
| scene 群里接话 | off | — | 0.85 | 0.4 | — | 1 500 | 25 s |

理由：日常接话不该「先写 1800 token 思维链再回一句哈哈」（思维链计入 `max_tokens`，
既贵又会把聊天腔调带成书面报告）；整合几十条经验要交叉印证、裁决矛盾，才值得满格推理。
`LLM_THINKING=off|on` 可整体切换（换非推理模型 / 省思维链 token），更细的覆盖走
`new OpenAICompatibleModel({ profiles })` 或单请求 `sampling`。
`memory/dream.ts` 里原先硬编码的 `timeoutMs: 180_000` 已删除，否则会盖掉配置里的档位。

### 为人处事 skill 怎么落进提示词

借的是「分寸」，不是情感咨询流程，写成第一人称的待人方式：先接住人再谈事；
开口前量五维（回应温度 / 信号确定性 / 情绪走向 / 冲动度 / 事件性质）；
潜台词只给「可能」不给「一定」；深夜、连发、质问、自我贬低先缓一缓；
回复三基调挑一版、不用群发套话；不替谁做决定、不操控、不把拒绝读成欲擒故纵；
出现自伤 / 危险信号先给求助渠道。Dream 侧补了对应的防漂移：一次没回不算关系变冷，
印象变化要说清是哪两件事。

### 验证方式（按用户要求省 token，**没有调用收费模型**）

- `npx tsc -p tsconfig.json --noEmit`：干净。
- `npm test`：**76/76** 通过（原 58 + 新增 18：`test/profiles.test.ts` 11 例、`test/persona.test.ts` 7 例）。
  覆盖档位互斥、body 字段、覆盖优先级、环境变量、截断报错、单一人格一致性、personal 开关。
- `npm run quality`：PASS（82 文件 615 函数 0 违规）。第一次跑报
  `openai-compatible.ts:35 cyclomatic 11 exceeds 10`，原因是
  `sampling?.timeoutMs ?? timeoutMs ?? profile.timeoutMs` 把分支塞进了 `decide`；
  抽出 `timeoutOf()` 后通过。
- `node scripts/junit.mjs`：JUnit 76 用例、0 失败、0 跳过。
- 2026-11-10 Dream 新增「机会」：回放里额外产出 follow_up / check_in / share / observe 四类「想做但还没做的事」，过纯函数筛子（证据越界、内联原文、批内与跨批重复、排序上限）后经 `dream.opportunity` 事件进 self 的 inbox，由 self 决定做不做；`dreamOpportunities: false` 可关。**未调用真实收费模型**，机会的实际质量（会不会提得太频繁、提得对人）还没有真实对话数据。`tsc --noEmit` 干净；**99/99** 验收用例通过；`cqg check` PASS（98 文件 797 函数 0 违规）。
- 2026-11-10 对齐 Claude 的 dream 过程：一次整合改为同一批经验回放 R1..Rn（R2 起带上一遍的 workspace，只做 revisions/retractions），收敛即停、最多 3 遍；提交按最终差异生成 write/retract/merge，`DreamVersion` 记录 `rounds / converged`。`tsc --noEmit` 干净；**84/84** 验收用例通过；`cqg check` PASS（94 文件 769 函数 0 违规）。**未调用真实收费模型**，所以「多轮回放是否真的提高保留率」尚无实测数据，保留率仍靠 `scripts/evaluate.ts` 离线跑。
- `npm run audit`：**未能在本地完整跑完**，不是代码问题。沙箱的 safe-delete 拦截了 cqg
  收尾删除 `.code-quality-gate/run.lock`，报 `broker denied delete`；README / ARCHITECTURE
  已记录该降级路径，三项检查分别复核如上。

### 结果 / 不能归因

这一轮**只有静态结论**：参数确实按场合发出去了、四种场合确实共用同一份人格、
personal 开关确实只关偏好不关身份。**没有任何行为层面的结论**——提示词变长后
模型是否更自然、关思考会不会让接话变笨、`temperature=0.85` 是否合适，全都没测。
本轮同时改了身份组织方式、personal 配置、采样参数三类变量，即使之后跑真实模型对比，
也**不能**把差异归因到其中任何一项。

### 下一轮最便宜的三个单变量对照

1. `LLM_THINKING=off` vs 默认：只动思考开关，比较 scene 回复质量与 token 消耗。
2. `AGENT_CONFIG='{"personal":false}'` vs 默认：只动偏好段落，验证 personal 倾向的贡献。
3. `profiles: { scene: { temperature: 0.3 } }` vs 0.85：只动一个采样值。

仍沿用实验 2 的纪律：固定 `FORCE_WAKE_EVERY`，否则 `nextWakeAt` 自定会造成样本量漂移，
空转率不可比。

---

## 6. 待办 / 下一轮想验证的

- **【待做，实验 3】三个单变量对照**：见上一节末尾。提示词长度本身也是一个变量
  （本轮 self / scene 每轮输入都变长了），若要比较成本，得单独记 `prompt_tokens`。
- **【已完成，实验 2】信号配比：把运行时流水与外部事件分开。** 最终没有按原计划
  改存储（拆 `runtime-log`），而是在消费端加 `memory/lived.ts` 白名单：流水照写、
  照推进游标，只是不进模型上下文。改动面更小，`evidence` 序号也保持连续。
- **【必做】固定唤醒节奏，否则空转率测不出来。** 实验 1 的对照失效，
  根因是 `nextWakeAt` 由 agent 自定导致样本量漂移。评估脚本应支持
  `FORCE_WAKE_EVERY=N`，让两组决策次数对齐后再比较。
- **【必做】把实验 2 的 7 个变量拆成单变量对照。** 目前只有定性结论
  「给定社交素材 + 能开口的工具，模型会按人的方式记事和说话」，还不能说清
  到底是提示词、场景还是 `group.say` 起了作用。优先级：`ENABLE_SAY=0`
  与 `SCENARIO=anonymous` 两个开关最便宜，先做这两个。
- **Dream 的收益需要 held-out 探针**：现在只有 `retention`（会不会丢事实），
  还缺「整合后是否更容易检索到正确答案」。可加一组固定查询，
  比较整合前后 `memory.search` 的命中率。
- **retention 的判读阈值**未知：多低算「压缩丢事实」，多高算「只是抄写」，
  需要跨多轮实验才能定标。已知它受批次大小影响（批次小则保留率低），
  应先固定批次再谈阈值。
