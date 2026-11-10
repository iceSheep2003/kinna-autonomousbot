# 主动性现状分析

> 结论：**能开口，但不知道该跟谁说、什么时候说、说了有没有回音。**
> 属于「有手脚，没社会关系」。

## 一、现在能做什么

### 醒来

self 有 7 个触发源 + 自己设的时间：

| 触发 | 来源 |
| --- | --- |
| `initialized` | 初始化 |
| `reflection.due` | 定时反思 |
| `scene.reflection_requested` | 场景要求反思 |
| `execution.finished` | 派出去办的事回来了 |
| `schedule.due` | 日程到点 |
| `job.failed` / `schedule.rejected` | 失败 |
| `nextWakeAt` | **自己定下次什么时候醒** |

### 决策

`SelfDecisionSchema` 有 10 个出口：

```
reflection / direction / focus / goals / launch / act /
schedules / cancelSchedules / cancelExecutions / dream / nextWakeAt
```

其中 `act` 是**直接行动**（不用起执行，一步到位调工具）。

### 工具（16 个）

```
记忆   memory.search / expand / promote / experience.read / self.note
待办   self.todo_add / todo_list / todo_close
外面   web.search / web.fetch
B站    discover / search / video / comments / quotas / todo* / draft_comment / draft_dynamic / delete_post
QQ     send_message / get_message / history / group_members / group_info
```

**所以技术上它已经能主动发消息了**：`act: [{ name: 'qq.send_message', input: {...} }]`。

## 二、三个真实缺口

### ① 有电话，没通讯录

self 的 context 里**没有 `people`**（`grep -c people src/self/context.ts` = 0）。

它知道怎么发消息，但：
- 不知道群里有哪些人
- 不知道和谁熟（`rapport` 分数）
- 不知道谁最近说过什么（那在 scene 的 transcript 里）

scene 有全部这些（`speaker`、`factsAbout`、`people` 卡片），self 一个都没有。

### ② 不知道自己的社交圈

self 的工具里**没有 `qq.environment`**（那是 scene 的）。

所以它不知道：
- 有哪些群可以说话（`allowedGroups` 在 config 里，但不在 context 里）
- 有哪些表情可用

想发消息时 `target` 从哪来？只能从 `observations` 里最近一条消息推。**如果最近没人说话，它就不知道群号。**

### ③ 心情不门控主动行为

`permitsProactive()` 在 `mood-system.ts` 里实现好了，**但没有任何调用方**。

所以「心情太差就不主动开口」这条设计还没有生效——目前无论如何都会主动。

## 三、还缺的两个东西

### 主动发起没有回执

发了消息，然后呢？对方回没回、有没有人接话——**self 不知道**。

`execution.finished` 会回来，但那是「工具调用成功」，不是「他真的理我了」。

### 没有「想找谁」的意图表达

现在的决策是「我现在要做什么」。没有「我想找 X 聊聊」这种以人为对象的意图。

`act` 只接受工具名和参数，语义上是「执行一个动作」，不是「跟某个人建立联系」。

## 四、建议：四个工具 + 三处注入

### 注入（不加工具，只给上下文）

**① self 的 context 加 `people`**

```ts
people: {
  roster: [{ userId, name, portrait, rapportStage, lastSeenAt }],   // 最近 5 个
  strangers: number,                                                 // 还没认识的有几个
}
```

有了这个，self 才知道「可以找谁」。

**② self 的 context 加 `social`**

```ts
social: {
  groups: [{ id, name, memberCount, lastActiveAt }],   // 我能说话的群
  privateAllowed: ['3485823460'],                      // 能私聊的人
  proactivePermitted: boolean,                          // 心情允许吗
}
```

这就是「社交圈」，替代它现在靠猜群号。

**③ 接上 `permitsProactive`**

在 `social.proactivePermitted` 里给结果。心情差时它是 false，self 就该知道「今天不想说话」。

### 新增工具（4 个）

| 工具 | 作用 | 为什么需要 |
| --- | --- | --- |
| `self.contact_plan` | 记一条「打算找谁、什么时候、为什么」 | 让意图变成可追踪的数据，而不是一次性动作 |
| `self.contact_done` | 标记已联系 + 结果（有回应/没回应/被无视） | 主动发起要有回执，否则永远不知道有没有用 |
| `self.roster` | 查我认识谁、和谁什么关系 | 替代直接读 `people`，让 self 主动查询而不是被动接收 |
| `qq.environment`（已存在，放开给 self） | 有哪些群/表情 | 一行配置的事 |

### 「设置人物」怎么做

用户说的「他可以主动去设置人物」，我理解是 **self 能给某个人打标签、改关系**。

现在 `people` 的画像由 Dream 整体替换写入，self 没有写入口。

建议加：

```
self.remember_person(userId, { aliases?, note?, impression? })
```

但要谨慎：**self 对一个人的印象应该是「互动积累出来的」，不是它自己随便写的**。
否则它会给自己编人设（「这个人对我很好」），和事实脱节。

所以我的建议是：**不给 self 直接写画像的权限，但给它「写一条关于这个人的记忆」**——
`memory.observe` 已经能做（带 `subjectUserId`），情绪事件走的就是这条路。

这样「设置人物」= 通过记忆累积，而不是直接改画像。

## 五、实施顺序

| 步骤 | 内容 | 风险 |
| --- | --- | --- |
| 1 | self 的 context 加 `people` + `social` | 低，只是注入 |
| 2 | 接上 `permitsProactive` | 低，一个布尔 |
| 3 | 放开 `qq.environment` 给 self | 低 |
| 4 | 加 `self.roster` / `contact_plan` / `contact_done` | 中，要设计数据 |
| 5 | 主动发起的结果回流（对方回没回） | 中，要跨场景关联 |

## 六、一个必须想清楚的问题

**主动找人聊天，成功的标准是什么？**

如果没有标准，这段代码会变成「每天定时发一句在吗」，然后被踢出群。

我认为标准应该是：
- 有由头（看到什么、想起什么、有人提过）
- 挑对人（熟的人、爱聊的人、最近提过相关话题的人）
- 有分寸（心情允许、频率受控、被无视就收敛）

这三条恰好对应三个工具：`contact_plan`（由头）、`roster`（挑人）、`permitsProactive`（分寸）。

**没有由头的主动搭话，不该做。**
