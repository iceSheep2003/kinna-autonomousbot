# 记忆存储设计

> 这份文档只回答一个问题：**记忆最后存在哪里、为什么是那里。**
> 上层设计（分层、索引、人物）见 `MEMORY-DESIGN.md` 和 `docs/memory-design.html`。

## 先看真实规模

从线上库（跑了 48 天）实测：

| 数据 | 量 | 增速 | 一年后 | 十年后 |
| --- | --- | --- | --- | --- |
| 记忆 | 287 条 | 12 条/天 | ~4,400 条 | ~44,000 条 |
| 消息 | 7,907 条 | 161 条/天 | ~59,000 条 | ~590,000 条 |

**这个数字决定了整个设计。** 之前我用 5 万条记忆做性能测试，得出「罕见词查询 46ms、需要全文索引」的结论——
但 5 万条是**十几年后**的量。在真实规模下（几千条），SQLite 单表全表扫也只要几毫秒。

所以判断要反过来：**性能不是当前的主要矛盾，结构清晰和可维护性才是。**

## 三个候选方案

### A. 文档存储（现状）

```sql
CREATE TABLE documents (collection TEXT, id TEXT, body TEXT, PRIMARY KEY(collection, id))
```

所有东西 JSON 塞进 `body`。

- **优点**：一个 `Store` 服务所有集合；加新集合零成本；领域对象原样存取，不用写映射
- **缺点**：字段躺在 JSON 里，`scope` / `status` / `created_at` 都建不了索引；统计要全表扫 + JSON 提取；没法用约束防脏数据；`sqlite3` 命令行看到的是转义后的 JSON，不好读
- **适合**：数据量小、只按 id 取整条的

### B. 关系表（建议改用）

```sql
CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, scope TEXT NOT NULL, ...);
CREATE INDEX memories_scope ON memories(scope, status);
```

- **优点**：过滤条件走索引；能直接 `sqlite3` 查、能写 SQL 统计；`NOT NULL` / 类型由 schema 保证；迁移和备份都是常规操作
- **缺点**：要写字段映射（领域对象 ↔ 行）；加字段要改 schema
- **适合**：数据量大、过滤条件多、需要审计的

### C. 文件系统（Claude Code 的做法）

Claude Code 的记忆是 `MEMORY.md` 索引 + 主题 `.md` 文件，没有数据库。

- **优点**：人类可读、可 git diff、可直接编辑、索引有硬上限强迫收敛
- **缺点**：并发写、事务、跨文件查询都得自己处理
- **适合**：**人工维护的少量文档**（几十条）。Claude Code 的记忆规模正是这个量级

## 结论：分而治之

不是「全换成关系表」，也不是「照抄 Claude Code」。按数据特征分：

| 集合 | 存储 | 理由 |
| --- | --- | --- |
| `memories` | **关系表** | 数据量最大（4 千/年）、过滤条件最多（scope/status/时间/主体）、需要审计 |
| `memory_evidence` | **关系表** | 证据要能反查「哪些记忆引用了这条原话」 |
| `people` | 文档 | 200 人量级，按 userId 取整条 |
| `memory.index` | 文档 | 每作用域一份，按 scope 取整条 |
| `goals` / `scenes` / `schedules` / `sessions` | 文档 | 按 id 取整条，从不按字段过滤 |
| `experience` | **已有独立表** | 本来就是 append-only，已经是对的 |

**不学 Claude Code 的文件系统**：它的记忆是人工维护的几十条文档，我们的是自动生成、每年数千条的数据。
文件系统在并发写、事务、查询上都要自己造轮子，而 SQLite 这些是现成的。

**不改其他集合**：为了「统一」给 `goals`（几十条、只按 id 取）也建表，只会多出一堆没人查的列。

## 不做全文索引（当前）

我一度加了 FTS5 + 二元字组索引，理由是「5 万条时罕见词查询 46ms」。但：

- 真实规模是 4 千条/年，**全表扫只要几毫秒**
- FTS 带来额外维护成本：每次 `publish` 要同步索引、迁移要重建、切分方式一变就要重跑
- 而且还踩到坑：FTS5 的 `trigram` 分词对**两个汉字**的词完全无效（「考研」「国企」匹配 0 条），
  必须自己切二元字组再存 —— 这已经是在给一个不需要的东西打补丁

**判断**：先不做。等真实数据到 5 万条（十几年）或响应变慢时再加，那时用 `EXPLAIN QUERY PLAN` 看真实瓶颈，而不是猜。

如果将来要加，正确的做法是：
```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61');
```
用 external content 模式（不重复存正文），并在 `publish` 的同一个事务里同步。

## 迁移怎么做

老数据在 `documents` 里（collection='memories'）。迁移要满足：

1. **幂等**：跑多次结果一样
2. **不删旧数据**：迁移后 `documents` 里的记录保留一段时间，出问题能回退
3. **一次性事务**：几千条也要避免逐条提交
4. **自动触发**：打开老库时如果新表是空的、旧集合非空，就迁一次

## 实施结果

- [x] `memory-schema.ts`：建表 + 索引（`memories` / `memory_evidence`）
- [x] `memory-rows.ts`：行映射与 upsert 语句，正常写入与迁移**共用一份**
- [x] `memory.ts`：仓储改用关系表，接口签名不变（上层无感知）
- [x] `memory-migrate.ts`：打开老库时自动迁移一次，幂等、一个事务、不删旧数据
- [x] 276 个测试全过（其中 4 个原本直接查 `documents`，已改成走仓储接口）
- [x] 线上真实数据验证：287 条 → 287 条，抽查 60 条字段全一致，证据表 287 行

**查询计划**：候选池走到 `SEARCH memories USING INDEX memories_scope (scope=? AND status=?)`。

**一个已知限制**：`ORDER BY updated_at` 仍然 `USE TEMP B-TREE`——因为 `status IN (...)` 是多值，
SQLite 用不上索引里后续列的排序。要消掉得拆成 UNION 或改成单值 status，
在几千条的规模下不值得。真慢了再说，判断依据是 `EXPLAIN QUERY PLAN` 而不是猜。

## 迁移时踩到的一个真 bug

我把状态过滤写进了 `candidates()` 的 SQL（只取 active/candidate），结果**归档记忆永远无法被回想起来**——
`includeArchived` 根本到不了 `access.ts` 那一层，因为候选池已经把它们滤掉了。
测试抓到了：`shift` 后 `includeArchived: true` 仍然返回 0 条。

修法是让 SQL 知道请求的意图：`request.includeArchived === true` 时把 `archived` 也算进候选。
这也说明一件事——**过滤下沉到 SQL 是有代价的**：原本集中在 `access.ts` 的一处判断，
下沉后散成了两处，容易漏。所以下沉只做「性能相关的粗过滤」，最终验权仍然在 `access.ts`。
