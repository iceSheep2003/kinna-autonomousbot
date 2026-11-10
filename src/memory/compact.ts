import type { Memory } from './types.js';
import { similarity } from './text.js';

/**
 * 记忆压缩：把同一件事的多条记录合成一条。
 *
 * 为什么需要它：记得越多不等于越有用。真实库里 275 条记忆里，光「不喜欢炫技式
 * 编程题」就散在三四条里——每次注入都占预算，模型还要自己看出它们说的是同一件事。
 * 更麻烦的是通用层（owner）：它没有上限，膨胀起来会把场景记忆的预算挤光。
 *
 * 和 Claude 的做法一致：不是「删掉旧的」，是**合并成一条更准的**，并保留全部证据，
 * 想追原话还能沿着 evidence 找回去。原记录标 superseded，不硬删。
 */
export interface CompactionPolicy {
  /** 一个 scope 里超过这么多条才值得压。 */
  maxPerScope: number;
  /** 字面兜底路径的相似度阈值；只吃「几乎逐字重复」。正常路径靠模型找组。 */
  groupThreshold: number;
  /** 一次最多压几组，避免一次调用就改掉半个库。 */
  maxGroups: number;
  /** 每次给模型看多少条。太多了它会看花——真实数据上，275 条一次灌进去它就放弃分组了。 */
  batchSize: number;
  /** 每组至少几条才压——两条合成一条，省得不多，还可能丢细节。 */
  minGroupSize: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = {
  maxPerScope: 40,
  groupThreshold: 0.8,
  maxGroups: 6,
  batchSize: 40,
  minGroupSize: 3,
};

export interface CompactionGroup {
  scope: string;
  members: Memory[];
  /** 这一组大概在讲什么，给模型当提示。 */
  topic: string;
}

/**
 * 需要压缩的 scope 与其中的分组。
 *
 * 只按条数判断，不按时间：时间久了自然会累积，条数超了才说明它已经开始挤预算。
 */
export function planCompaction(memories: readonly Memory[], policy: CompactionPolicy = DEFAULT_COMPACTION): CompactionGroup[] {
  const byScope = new Map<string, Memory[]>();
  for (const memory of memories) {
    if ((memory.status ?? 'active') !== 'active') continue;
    const scope = memory.scope ?? 'owner';
    byScope.set(scope, [...(byScope.get(scope) ?? []), memory]);
  }
  const groups: CompactionGroup[] = [];
  for (const [scope, rows] of byScope) {
    if (rows.length < policy.maxPerScope) continue;
    groups.push(...clusterByText(rows, scope, policy));
    if (groups.length >= policy.maxGroups) break;
  }
  return groups.slice(0, policy.maxGroups);
}

/**
 * 按字面相似度聚组——**只在没有模型可用时兜底**。
 *
 * 真实数据（线上 275 条群记忆）证明它基本不管用：只有 3 对相似度 ≥0.3，
 * 而且那 3 对里有两对是**不同的事**（「26 英一简单」vs「26 英一作文炸」、
 * 同一个人「只看一页纸」vs「是二次元」），真正该合并的只有 0.29 那一对。
 * 记忆是人说的具体事，措辞天然发散；字面对得上不等于讲同一件事。
 *
 * 所以正常路径让模型找组（见 compaction 服务），这个函数留作离线/无模型场景的兜底，
 * 阈值调高到只吃「几乎逐字重复」的情况。
 */
export function clusterByText(rows: readonly Memory[], scope: string, policy: CompactionPolicy): CompactionGroup[] {
  const used = new Set<string>();
  const groups: CompactionGroup[] = [];
  for (const seed of rows) {
    if (used.has(seed.id)) continue;
    const members = rows.filter(other => !used.has(other.id) && similarity(seed.content, other.content) >= policy.groupThreshold);
    if (members.length < policy.minGroupSize) continue;
    for (const member of members) used.add(member.id);
    groups.push({ scope, members, topic: seed.content.slice(0, 40) });
  }
  return groups;
}

/** 按模型给的分组装填成员：只认库里真有的 id，忽略模型编的。 */
export function groupsFromIds(rows: readonly Memory[], scope: string, groups: readonly { ids: readonly string[]; topic: string }[]): CompactionGroup[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return groups
    .map(group => ({ scope, topic: group.topic.slice(0, 40), members: group.ids.map(id => byId.get(id)).filter((m): m is Memory => m !== undefined) }))
    .filter(group => group.members.length >= 2);
}

/**
 * 合并一组记忆后应该长什么样。
 *
 * - 内容由模型给（`merged` 参数），因为「把这四句合成一句」需要理解；
 * - 证据取并集：任何一条的出处都留着，事后能沿它找回原话；
 * - 重要度/置信度取最大：组里最重要那条不该因为被合并而变轻；
 * - 时间取最早：这条记忆说的是「一直以来」，不是「最近」。
 * 这些不是模型的判断，是合并本身的语义，所以写在代码里而不是提示词里。
 */
export function buildMerged(group: CompactionGroup, merged: string, now: number): Memory | undefined {
  const text = merged.trim();
  if (text === '') return undefined;
  const first = group.members[0];
  if (!first) return undefined;
  const evidence = [...new Set(group.members.flatMap(member => member.evidence))].sort((a, b) => a - b);
  const earliest = Math.min(...group.members.map(member => member.createdAt ?? now));
  return {
    ...first,
    id: `${first.id}~merged`,
    content: text.slice(0, 300),
    evidence,
    revision: Math.max(...group.members.map(member => member.revision)) + 1,
    importance: Math.max(...group.members.map(member => member.importance ?? 0)) || undefined,
    confidence: Math.max(...group.members.map(member => member.confidence ?? 0)) || undefined,
    createdAt: earliest,
    updatedAt: now,
  };
}

/** 被合并掉的原记录：标 superseded 并指向新记录，不硬删。 */
export function retireMerged(member: Memory, intoId: string): Memory {
  return { ...member, status: 'superseded', mergedInto: intoId };
}
