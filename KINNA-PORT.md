# 从线上 kinna 复刻：范围与映射

线上实际在跑的是 `/opt/kinna-releases/20261108-133650-memory-identity-final`（进程 `qqbot`，端口 6199），
`src/qqbot` 共 298 个 Python 文件、45207 行。本文记录复刻范围、架构映射与分期。

## 范围

**做**：agent（认知/对话编排）、contracts（契约）、features（18 个功能）、actions、infrastructure、interfaces/qq。
**不做**：`interfaces/webui`（18 个文件 4517 行）——用户明确不要 WebUI。

## 架构映射

线上的分层比本项目更细，但职责能对上，复刻时**保留本项目已有骨架**，把 kinna 的东西填进对应位置：

| 线上 (Python) | 本项目 (TypeScript) | 说明 |
| --- | --- | --- |
| `contracts/kernel_v1.py` | `src/capabilities/` | 模型可见工具封闭为 12 个，新行为只经 Skill 扩展 |
| `contracts/schema.py`、`models.py` | `src/shared/` | 校验原语与领域模型 |
| `agent/conversation_agent.py` | `src/self/` + `src/execution/scene.ts` | 建消息、稳定前缀、技能目录 |
| `agent/cognition`、`pipeline` | `src/self/context.ts` | 上下文组装 |
| `features/*` (18 个) | `src/features/`（新建） | 每个 feature 一个目录，manifest 声明 |
| `actions/replies`、`scheduling` | `src/runtime/scheduler.ts`、`src/execution/` | 回复与调度 |
| `interfaces/qq` | `src/integrations/qq/` | 已存在，对齐能力即可 |
| `infrastructure/storage` | `src/infrastructure/sqlite/` | 已存在 |
| `bootstrap/app.py` | `src/main.ts` + `src/app/agent.ts` | 装配 |

## 设计原则（本版本已取舍）

1. **继承：封闭内核**。模型能调的工具是固定集合，不允许外部目录或运行时协议新增。
2. **继承：模型即过滤器**。不写"热度公式""关键词打分""定时播报"。搜到东西交给模型判断，它不写就不发。
3. **不继承：Skill 机制**。线上用「内核 12 工具 + `skill_load` 动态加载指令」来扩展行为，
   代价是多一层间接：工具先被 skill 声明、再被加载、再被引用，排查要追三层。
   **本版本按场景直接固化工具清单**（`src/capabilities/scenarios.ts`）：
   群聊只给 `qq.*`、看视频只给 `bilibili.*`、自己待着给跨平台的读写组合。
   要加能力就往清单加一行，不再需要声明-加载-引用三段式。
4. **不继承：manifest allowlist**。它解决的问题是「目录里丢个模块就自动生效」，
   但本版本的工具都要显式注册进 `CapabilityRegistry`，本身就不会被目录扫描进来，
   再加一层 manifest 是重复防护。

### 场景工具怎么固化

| 场景 | 工具来源 |
| --- | --- |
| self（自己待着） | `SCENARIO_TOOLS.self` 显式清单：记忆、note、todo、各平台读接口、以及"真的开口"的发送工具 |
| scene:qq（群里说话） | `allowedTools` 里以 `qq.` 开头的 |
| scene:bilibili（视频下接话） | `allowedTools` 里以 `bilibili.` 开头的 |
| execution（办事） | 任务自己在 `intent.tools` 里声明的 |

清单与部署白名单**取交集**：清单写「这个场景可以有什么」，`allowedTools` 写「这台机器允许什么」，
两者都满足才会出现在模型面前；没装的能力自动消失，不报错。

## 分期

| 期 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 契约与工具内核（schema 校验原语、12 个工具定义、fail-closed） | 待做 |
| P1 | feature 框架（manifest、loader、kind=JOB/BACKGROUND、贡献声明） | 待做 |
| P2 | 内容类 feature：hot_share、world_brief、world_digest、wiki_memory | hot_share 已完成；其余待做 |
| P3 | 表达类 feature：persona、reply_policy、slang、style_echo、memes、voice | 待做 |
| P4 | 节奏类 feature：scheduled_chat、proactive_chat、mood、exam_poster | 待做 |
| P5 | 平台类：qq_admin、qq_channel | 待做 |

## 与现有架构的融合点

线上 `hot_share` 是一个独立 worker：定时 → 搜关键词 → 模型判断 → 发群。
本项目已有 **opportunity（机会）+ inbox + self 决策** 这条链，所以复刻时不另建 worker：

```
定时器（scheduler）
  → 关键词轮换 + 去重 + 每日上限
  → web.search / web.fetch
  → 作为一个 opportunity 投进 self 的 inbox
  → self 决定：说一句 / 不说
```

这样既保留了"模型即过滤器"，又不让 feature 绕过主体做决定。

## P2 第一篇：hot_share（已完成）

`src/features/hot-share/`：config / search / state / prompt / worker。

与线上的差异（有意为之）：

- **不直接发群**。线上 worker 自己调模型、自己发；本项目把候选投进 self 的 inbox，
  由 self 决定说还是不说。理由：主体是唯一决策者，feature 不该绕过它开口。
- **dryRun 默认开、每日上限默认 1、未配置即关闭**——半配置好的部署不该能发东西。
- 搜索用 DeepSeek 官方接口（线上同款），过滤规则比线上更严：
  去追踪参数后去重、剔除招聘/报名/表单页、整站剔除高校就业网与招聘平台。
  这些是实测「408 考研」搜出来全是招生门户后补的。

已实测：真实搜索两次，分别命中「2026 年 408 真题解析」与「计算机就业分析」，
过滤前后对比明显；dryRun 只写日志不发。
