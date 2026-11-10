# 情绪系统：线上与本项目的对照

> 结论先说：**本项目的情绪系统是照线上逐项对齐的**，不是简化版。
> 唯一的结构差异在存储介质（线上单独一个 `emotion.sqlite3`，本项目放在同一个库里）。

## 一、五维心境

两边**完全相同**，都是 0–100、基线 50：

| 维度 | 含义 |
| --- | --- |
| `valence` | 心情好坏 |
| `energy` | 精神头 |
| `stress` | 压力 |
| `interest` | 兴趣 |
| `sociability` | 想不想说话 |

线上实际数据（两个群各一份）：

```
group:330707267  valence=50.9 energy=50.7 stress=52.5 interest=61.1 sociability=61.7
                 reason=对方语气带刺，被怼了一句，略感不适
group:866795853  valence=49.8 energy=49.6 stress=52.0 interest=49.8 sociability=49.9
                 reason=涉及远程登录和凭据的敏感请求，略增警惕。
```

两个特征值得注意：**按群分开**（不同群不同心境）、**都贴着基线**（会回落）。

## 二、逐项对照

| 能力 | 线上 | 本项目 |
| --- | --- | --- |
| 五维状态 | `mood` 表 | `documents` 集合 `mood`（按 scope） |
| 事件溯源 | `mood_events`（deltas + reason + created_at） | `mood_events` 表（scope, at, body JSON） |
| 幂等去重 | `mood_observed`（scope, dedupe_key） | `mood_observed`（同结构） |
| 时间衰减 | `decay`（半衰期） | `EmotionPolicy.decay`，半衰期 180 分钟 |
| 维度耦合 | `_gain_matrix(coupling)` | `gainMatrix(coupling)`，默认 0 |
| **稳定性分析** | `loop_gain` / `_spectral_radius` | `loopGain` / `spectralRadius` |
| 回放 | `replay` / `timeline` / `mood_at` | `replay` / `timeline`（`mood-history.ts`） |
| 短时反应 | `interaction_reactions`（scope+user） | `reaction.ts`（45 分钟硬过期，不进长期记忆） |
| 关系阶段 | `relationships` | `rapport.ts` |
| 四个出口 | `current` / `narration` / `permits_proactive` / `history` | 同名同义（`mood-system.ts`） |

## 三、更新方式：小 delta + 具象理由

线上真实事件：

```json
{"interest": 3, "energy": 1, "sociability": 2} | 解释技术概念，澄清常见混淆，略有兴致
{"valence": -3, "stress": 2, "sociability": -2} | 对方语气带刺，被怼了一句，略感不适
{"valence": 2, "interest": 1, "sociability": 1}  | 对方提出充钱，我以玩笑回应，气氛轻松
```

两条设计在这里：

1. **每次只动 ±1~3**，不是大跳。情绪是被一句句话推着走的，不是被一件事掀翻。
2. **每个 delta 都有具象理由**，而且是口语（「被怼了一句，略感不适」），不是标签（「负面情绪」）。
   这条 reason 直接进提示词——数字一律不进。

## 四、稳定性：为什么不会越聊越极端

线上线下都有 `loop_gain`：一次事件带来的偏离，经过一轮「耦合放大 + 时间衰减」后还剩多少。

```
每次 delta 冲击  ×  耦合矩阵放大  ×  exp(-间隔/τ)
```

本项目实测（半衰期 180 分钟、每小时一次事件、耦合 0）：

```
loop_gain = 0.794   < 1  →  偏离会回落，不发散
```

实跑一段：

```
基线            valence=50.0 energy=50.0 stress=50.0 interest=50.0 sociability=50.0
+30min 略有兴致   valence=50.0 energy=51.0 stress=50.0 interest=53.0 sociability=52.0
+30min 被怼一句   valence=47.0 energy=50.9 stress=52.0 interest=52.7 sociability=49.8
+30min 气氛轻松   valence=49.3 energy=50.8 stress=51.8 interest=53.4 sociability=50.8
静置 12 小时      valence=50.0 energy=50.0 stress=50.1 interest=50.2 sociability=50.1
```

被怼之后 valence 掉到 47，但下一次轻松的对话又拉回 49.3，静置半天回到 50。
**情绪会动，但不会失控**——这是拟人化和小作文的分界线。

## 五、`permits_proactive`：情绪决定要不要开口

这条是把情绪接进行为的地方：心境太差（stress 高、sociability 低）时不主动找人说话。

线上有同名出口，本项目在 `mood-system.ts`：

```ts
permitsProactive(scope?: string): boolean {
  if (!this.config.enabled) return true;
  ...
}
```

**关掉情绪模块时它恒为 true**——情绪是增强，不是前置依赖。

## 六、唯一的结构差异

| | 线上 | 本项目 |
| --- | --- | --- |
| 存储 | 独立 `emotion.sqlite3` | 同一个库，`mood` 在 documents、其余三张表独立 |
| 好处 | 情绪库损坏不影响主库；可以单独备份/清空 | 少一个文件和一套连接管理 |
| 代价 | 多一个数据库要维护 | 情绪表与主库同生共死 |

本项目选同一个库，是因为**情绪表很小**（线上 mood 2 行、事件 114 行），
单独拆库带来的运维成本大于收益。真需要隔离时，把 `affect.ts` 里的 `Store` 换成另一个连接即可——
这一层的边界是清楚的。
