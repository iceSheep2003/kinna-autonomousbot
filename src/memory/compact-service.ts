import type { LanguageModel } from '../shared/model.js';
import type { MemoryRepository } from './ports.js';
import { DEFAULT_COMPACTION, buildMerged, clusterByText, groupsFromIds, retireMerged, type CompactionPolicy, type CompactionGroup } from './compact.js';
import { z } from 'zod';

/**
 * 记忆压缩的执行者。
 *
 * 分工很关键：**模型只负责「说什么」**（把这组记忆合成一句话），
 * **代码负责「怎么合」**（证据取并集、重要度取最大、原记录标 superseded 而非删除）。
 * 把这些语义交给模型，它会在某次压缩里悄悄丢掉一条证据，没人看得出来。
 */
const MergedSchema = z.object({ merged: z.string().min(1).max(300) });

/**
 * 第一步：让模型找出哪些记忆讲的是同一件事。
 *
 * 为什么不让代码靠字面相似度分：真实数据里 275 条只有 3 对相似度 ≥0.3，
 * 其中两对还是不同的事。措辞对不上不等于不是同一件事，这个判断只有读得懂内容的模型能做。
 */
const GroupSchema = z.object({
  groups: z.array(z.object({
    ids: z.array(z.string()).min(2).max(20),
    topic: z.string().max(60),
  })).max(8),
});

const GROUP_INSTRUCTIONS = `下面是你自己的记忆条目。找出哪些**讲的是同一件事**，可以合并成一条更准的说法。

只合并真正重复的，判断标准：
- 同一件事被记了多次（换个说法、补了细节）→ 合
- 同一个人的**不同**属性或不同经历（「自称只看一页纸」和「自称二次元」）→ 不合
- 同一话题下的**不同事实**（「26 英一简单」和「26 英一作文炸」）→ 不合
- 拿不准就不合：合并错了会丢掉一件本来记得的事。

每条记忆用 id 指代。没有可合并的就输出空数组。`;

/** 第二步：把一组合成一句话。 */
const MERGE_INSTRUCTIONS = `你在整理自己的记忆：下面几条讲的是同一件事，把它们合成一条更准的说法。

要求：
- 只保留**确定的**内容；几条之间有出入时，用更谨慎的说法，不要挑一条当全部。
- 不要补充原文没有的信息，不要拔高成结论。
- 一句话，不超过 80 字，像自己记得住的那种说法。
- 如果这几条其实不是同一件事（只是字面像），输出 empty。`;

export interface CompactionDeps {
  repository: MemoryRepository;
  model: LanguageModel;
  /** 从哪里取候选：默认全库最近的一批。 */
  pool?: (limit: number) => import('./types.js').Memory[];
  policy?: CompactionPolicy;
  now?: () => number;
  /** 压了什么，写进经验流水便于事后核对。 */
  record?: (kind: string, data: unknown, now: number) => void;
}

export interface CompactionResult { groups: number; merged: number; retired: number; skipped: number }

export class MemoryCompactor {
  constructor(private readonly deps: CompactionDeps) {}
  private policy(): CompactionPolicy { return this.deps.policy ?? DEFAULT_COMPACTION; }

  /** 跑一次压缩。没有需要压的就直接返回，不调模型。 */
  async run(): Promise<CompactionResult> {
    const now = this.deps.now?.() ?? Date.now();
    const pool = this.deps.pool ?? ((limit: number) => this.deps.repository.recent(limit));
    const pool40 = pool(400);
    const groups = await this.plan(pool40, now);
    const result: CompactionResult = { groups: groups.length, merged: 0, retired: 0, skipped: 0 };
    for (const group of groups) {
      const merged = await this.mergeGroup(group, now);
      if (merged === undefined) { result.skipped += 1; continue; }
      result.merged += 1;
      result.retired += group.members.length;
    }
    if (result.merged > 0) this.deps.record?.('memory.compacted', result, now);
    return result;
  }

  /**
   * 找可压缩的组：模型判断优先；模型不可用才退回字面兜底（阈值已调到只吃逐字重复）。
   * 条数没超阈值的 scope 直接跳过，不花一次模型调用。
   */
  private async plan(rows: import('./types.js').Memory[], now: number): Promise<CompactionGroup[]> {
    const policy = this.policy();
    const byScope = new Map<string, import('./types.js').Memory[]>();
    for (const row of rows) {
      if ((row.status ?? 'active') !== 'active') continue;
      const scope = row.scope ?? 'owner';
      byScope.set(scope, [...(byScope.get(scope) ?? []), row]);
    }
    const out: CompactionGroup[] = [];
    for (const [scope, members] of byScope) {
      if (members.length < policy.maxPerScope) continue;
      const grouped = (await this.askModel(members, scope, policy)) ?? clusterByText(members, scope, policy);
      out.push(...grouped);
      if (out.length >= policy.maxGroups) break;
    }
    void now;
    return out.slice(0, policy.maxGroups);
  }

  /**
   * 让模型分组。**必须分批**：275 条一次灌进去它会直接放弃分组（实测 0 组），
   * 每批 40 条时能稳定找出 3-4 组。批间不重叠，已入组的 id 不再参与后续批次。
   */
  private async askModel(rows: readonly import('./types.js').Memory[], scope: string, policy: CompactionPolicy): Promise<CompactionGroup[] | undefined> {
    const found: CompactionGroup[] = [];
    const claimed = new Set<string>();
    let anySuccess = false;
    for (let start = 0; start < rows.length && found.length < policy.maxGroups; start += policy.batchSize) {
      const batch = rows.slice(start, start + policy.batchSize).filter(row => !claimed.has(row.id));
      if (batch.length < policy.minGroupSize) continue;
      try {
        const decision = await this.deps.model.decide({
          role: 'execution', schema: GroupSchema, instructions: GROUP_INSTRUCTIONS,
          context: { memories: batch.map(row => ({ id: row.id, content: row.content.slice(0, 120) })) },
        });
        anySuccess = true;
        for (const group of groupsFromIds(batch, scope, decision.groups)) {
          // 跨批次不重复使用同一条记忆：一条只能被合并一次。
          if (group.members.some(member => claimed.has(member.id))) continue;
          for (const member of group.members) claimed.add(member.id);
          found.push(group);
          if (found.length >= policy.maxGroups) break;
        }
      } catch {
        continue;
      }
    }
    return anySuccess ? found : undefined;
  }

  private async mergeGroup(group: CompactionGroup, now: number): Promise<string | undefined> {
    let text: string;
    try {
      const decision = await this.deps.model.decide({
        role: 'execution', schema: MergedSchema, instructions: MERGE_INSTRUCTIONS,
        context: { memories: group.members.map(member => member.content) },
      });
      text = decision.merged;
    } catch {
      // 一次压缩失败不该影响别的组；下次再试。
      return undefined;
    }
    if (text.trim().toLowerCase() === 'empty') return undefined;
    const merged = buildMerged(group, text, now);
    if (!merged) return undefined;
    this.deps.repository.publish(merged);
    for (const member of group.members) this.deps.repository.publish(retireMerged(member, merged.id));
    return merged.id;
  }
}
