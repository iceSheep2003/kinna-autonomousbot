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

- `bilibili.video`：取 **playurl 的 DASH 流**，在本地最小页面里用无头浏览器 seek 到选好的时间点并截图；选点来自**弹幕的时间分布**（观众在哪些秒有反应），在每个热点**前 4 秒**取帧，弹幕太少（<20 条）时退回均匀采样。截图直接作为图片交给 DeepSeek 看（本地未配公网地址时内联 data URL，配了就给 URL 让它自己下载）；图片只进 user 消息。
- 为什么不在 B 站播放页截图：播放页有广告、弹幕层、风控，选择器一变就挂，本机实测无头打开播放页还会卡死。自己渲染 `playurl` 的流更稳、画面干净（没有弹幕遮挡）。
- `bilibili.comments`：读一个视频的评论区（按热度或时间），包括别人对你视频的评论。配置 `BILIBILI_MID` 后还会轮询自己视频下的新评论，送进对应视频的场景会话。
- `bilibili.draft_comment` / `bilibili.draft_dynamic`：回复评论、发纯文本动态。**已实测可用**：真实发出过一条评论（rpid `319757565265`）和一条动态（id `1268939446139486217`），验证后已删除。
- `commentPolicy` / `dynamicPolicy`：`off` 不发；`draft`（默认）先出草稿等人批准；`direct` 校验通过后直接发出。两条路都要过正文规则（长度、空白、个人信息）与每日额度。
- 批准与撤回：`POST /v1/bilibili/drafts/:id/approve` 只有持 `API_TOKEN` 的人能调；`bilibili.delete_post` 可撤回自己发过的评论/动态。
- 已实测的写接口：`dynamic_svr/v1/dynamic_svr/create`（发动态）、`x/v2/reply/add`（发评论）、`x/v2/reply/del` 与 `rm_dynamic`（删除）。

### 找什么看：先翻自己的记忆

「今天看什么」不由平台推荐决定。self 先翻记忆（谁说过什么、哪件事还没弄明白、最近反复想到的话题），
拿这些关键词用 `bilibili.search` 去找；`bilibili.discover`（推荐/热门/排行）只用来补充，
实在想不起来时才退回推荐。工具描述里也写明了「不要用泛泛的词（比如『视频』『好看』）」。

### 记忆怎么存

按数据特征分，不是一刀切：

| 集合 | 存储 | 为什么 |
| --- | --- | --- |
| `memories` | **关系表** + 索引 | 数据量最大（约 12 条/天）、过滤条件最多（scope/status/时间/主体） |
| `memory_evidence` | **关系表** | 要能按原话反查「哪些记忆引用了它」 |
| `people` / `memory.index` / `goals` / `scenes` / … | 文档存储（JSON） | 量小、永远按 id 取整条 |

**不做全文索引**：真实一年才 4 千条，全表扫几毫秒；FTS 的多一层维护成本不划算。

- **存储实录（先看这个）**：[docs/memory-storage.html](docs/memory-storage.html) · [PNG](docs/memory-storage.png)
  —— 从真实生成的库里 `sqlite3` dump 出来的表结构、数据行、查询计划
- 设计取舍：[docs/memory-storage.md](docs/memory-storage.md)

### 记忆机制文档

两份，分工不同：

| 文档 | 讲什么 | 适合 |
| --- | --- | --- |
| **[memory-design.html](docs/memory-design.html)** · [PNG](docs/memory-design.png) | **总体设计 + 五层产物的真实形状**：经验流水 / 记忆 / 索引 / 人物 / 场景现场，每层给出完整 JSON 和「每个字段在挡什么错误」 | 想搞清楚这套东西到底存了什么 |
| **[memory-map.html](docs/memory-map.html)** · [PNG](docs/memory-map.png) | **流程图**：一条记忆的一生、分层规则、Dream 四项、读取链路 | 想知道数据怎么流动 |

### 记忆分层

记忆分两层（`src/memory/scope.ts`）：

```
owner                     ← 所有场景共享：用户偏好、跨场景的长期事实、bot 自己的稳定性格
  └ group:<群号> / feature:<功能名> / project:<项目>   ← 只在各自场合可见
```

**向下看得到，向上看不到**：在 `group:A` 能读 `owner` + `group:A`，读不到 `group:B`。
过滤在**检索之前**完成——模型根本看不到它无权读的内容，不靠提示词要求它忽略。

两层各留预算（通用 ~40%、场景 ~60%），否则更"贴题"的场景记忆会把通用偏好挤光。
渲染时也分 `general` / `scoped` 两块，让模型知道哪条换个场合就不能提。

**对话压缩**：场景只读最近 20 条经验，更早的会被压成「现场状态」（聊到哪、哪些话没接住、
能接的梗、我说过什么），而不是直接丢弃。产物是能接着说下去的现场，不是摘要。

**人物层**：人不是事实的集合，是事实的收敛。一个人能有 63 条散落的事实，但没有任何地方拼出
「他是谁」——每次注入只捞到几条，永远拼不出一个人。所以单独立一层：一句话画像 + 几条近况
+ 指向证据的指针，由 Dream 看到全部事实后写。称呼只增不减（群名片会变），且跳过「群友3460」
这类系统占位名。实测 63 条真实记忆收敛成一句能直接用的人话。

**索引层**（Dream 的核心产出，对齐 Claude 的 `MEMORY.md`）：Dream 每次整合生成一份索引
（≤40 条、≤4000 字符），每条是「主题 + 一句话 + 指向的记忆 id」。注入时先给索引，
细节用 `memory.expand` 按需展开。索引**按场景各一份**（`owner` / `group:<群号>` / `feature:<功能>`），
注入时给 owner + 当前场景两份，各自的标题不同——合并成一份模型就分不清哪条能搬到别处说。索引指向不存在的记忆会被丢掉——一条指向空处的索引
比没有更糟。实测 275 条真实记忆压成 20 条索引、1798 字符。

**遗忘**：冷掉（60 天没用到）、不重要、不常用的旧记忆会被归档——不进默认上下文，
但 `memory.search` 主动回想时仍能找到，找到就恢复。归档不是删除，遗忘必须可逆。

**召回质量**：用 IDF 按语料区分度加权，不再让「的」「什么」这类泛词主导相关性。
真实数据上同一个查询，第二名从「只沾一个词」变成真正相关的那条。

**记忆压缩**：同一件事被记多遍会合并成一条更准的说法，证据一条不丢，原记录标 `superseded`
（对齐 Claude 的做法：不是删旧，是合成更准的）。模型负责找组和措辞，代码负责证据并集、
重要度取最大、时间取最早。实测线上 287 条真实记忆：287 → 280 条，证据 287 → 287 一条没少。

**提升是 AI 自己判断的，没有人工审核**：判据写进 Dream 的指令，模型决定哪条该提到通用层
（`promotions` 字段或 `memory.promote` 工具），代码只拦结构上说不通的（已在通用层、bot 状态、
过期、非 active、重复提升）。提升是复制而非移动，判断错了能退回原场景。

细节与取舍见 [MEMORY-DESIGN.md](./MEMORY-DESIGN.md)。

### 场景与工具

工具不是「一堆全塞给模型」，而是**按场景固化**（`src/capabilities/scenarios.ts`）：

| 场景 | 拿到的工具 |
| --- | --- |
| 自己待着 | 记忆、note、todo、各平台读接口，以及真正能开口的发送工具 |
| 群里说话 | 只有 `qq.*` |
| 视频下接话 | 只有 `bilibili.*` |
| 办事 | 任务自己声明的那几个 |

清单与部署白名单取交集，没装的能力自动不出现。**没有 skill 这一层**：线上 kinna 用
「内核工具 + skill 动态加载指令」扩展行为，多一层「声明→加载→引用」，排查要追三层；
这里直接按场景列清单，加能力就是加一行。

### 热点分享（复刻自线上 kinna）

`src/features/hot-share/`：定时轮换一个关键词去搜，挑一条没分享过的，**交给 self 判断要不要说**。

- **模型是过滤器**：不写热度公式、不做关键词打分、不做定时播报。搜到的东西没意思就不说话。
- 默认 `dryRun` + 每日 1 条 + 未配置即关闭，半配置的部署发不出东西。
- 过滤比线上更严：剥掉 `utm_*` 等追踪参数后去重、剔除招聘/报名页、整站剔除就业网与招聘平台。

配置见 `.env.example` 的 `BOT_HOT_SHARE_*`。复刻范围与分期见 [KINNA-PORT.md](./KINNA-PORT.md)。

### 自己记的待办

除了每日配额，self 还会在看到/听到什么之后**自己记待办**（`self.todo_add`）：
刷到个视频想弄清楚、群里有人提到个东西想去查、读到一段想转给谁看。
这类事没人要求它做，所以要写清由头；醒来时这几条会出现在上下文里（最多 5 条）。
做完要写结果、不做要写原因（`self.todo_close`），空着不算完成。

配套的读网页能力 `web.fetch` 只允许公网 http(s)，并拒绝内网/本机地址——
网页内容是外部数据，不能变成访问宿主内网的跳板。

### 每日任务（todo）

目标不是「偶尔发一条」，而是**每天稳定地看三条、评论三条**。

- 看板：`GET /v1/bilibili/todo` 显示今天做了几条、还差几条、最近 7 天记录；`POST /v1/bilibili/todo/remind` 让 self 立刻收到提醒。
- 每日配额由 `bilibili.dailyVideos` 决定（默认 3）。**每小时检查一次**，只把「今天还差几条」放进 self 的 inbox，不催命、不重复刷。
- 跨日自动结算：昨天没做完的记为 `missed`（不是失败），主动决定不做的记为 `skipped`（要写理由）。
- 完成必须带真实回执：`bilibili.todo_done` 要求评论的 `rpid`，没发出去的不能自己记成完成。
- 工具的产出是**素材**：self 自己挑视频 → 看（截图）→ 写评论 → 登记。像真人一样评论的提示写在工具描述里（说具体感受或疑问，不复述标题、不写「我是 AI」、不机器腔）。
- `dailyVideos: 0` 关掉日常；不配置看板时 todo 工具不注册。

### 登录与托管

不需要在服务器上存账号密码：用**扫码登录**拿会话。

```sh
# 1. 生成二维码（返回 url 与 qrcode_key，180 秒有效）
POST /v1/bilibili/auth/qr
# 2. 手机 B 站扫码后，轮询状态：waiting / scanned / ok / expired
GET  /v1/bilibili/auth/qr/:key
# 3. 登录成功后 cookie 存库，带 refresh_token；每天自动检查并续期，无需再扫
GET  /v1/bilibili/auth          # 登录状态
POST /v1/bilibili/auth/refresh  # 手动触发刷新
POST /v1/bilibili/auth/logout
```

- 会话存在本地库（`bilibili.session`），不进配置文件、不进模型上下文，任何接口都不回传 `SESSDATA`/`bili_jct`。
- 续期用 B 站的 `refresh_token` + `correspondPath` 流程；**刷新失败保留旧会话**，不会让账号突然下线。
- 续期结果分三种，不再混为一谈：`refreshed`（真的换了 Cookie）、`not-needed`（B 站认为还不用刷，**最常态**）、`unavailable`/`failed`（这次续不了或出错，会话仍可用）。
- 关键点：`refresh_csrf` 是**按需发放**的——`cookie/info` 返回 `refresh:false` 时，`/correspond` 不给有效页面。2026-11-10 我一度把这种正常情况误判成「接口失效」，现已改正：只有 `cookie/info` 说需要刷新时才走续期。
- 加密前的 `ij()` 预处理（每个字符转十六进制）按 B 站前端打包产物对齐，`preprocess()` 有单测。
- 也支持环境变量注入（`BILIBILI_SESSDATA` / `BILIBILI_BILI_JCT`，可选 `BILIBILI_REFRESH_TOKEN`），适合把凭证放在密钥管理里、不经过扫码。
- 不支持账号密码登录：密码登录要过风控验证码，在服务器上存密码本身也是风险。

写请求的 `csrf` 由传输层自动补上，调用方看不到 cookie。配置示例见 `agent.bilibili.example.json`。

读视频不需要本地模型，也不需要 ffmpeg，只需要一个无头浏览器：

```sh
npm i -D playwright && npx playwright install chromium   # 服务器上装一次即可
# 或者复用已装好的浏览器
BILIBILI_CHROME_PATH=/path/to/chrome
```

- 本机：不配 `publicBaseUrl`，截图以内联 data URL 进请求，不需要公网地址。
- 服务器：建议配 `bilibili.publicBaseUrl`（指向 `BILIBILI_SHOT_DIR` 可公网访问的地址）+ 静态文件服务，DeepSeek 自己下载图片，请求体只带 URL。
- 弹幕与取流接口都走浏览器头；截图不依赖 B 站播放页 DOM，部署后不会因为页面改版失效。
- 本地真实验证脚本：`npx tsx scripts/verify-bilibili-local.mjs BV1GJ411x7h7`（会真实访问 B 站并截图，不属于验收用例）。

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
