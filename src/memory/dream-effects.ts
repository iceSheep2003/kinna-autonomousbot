import type { ExperienceLog, MemoryRepository } from './ports.js';
import { buildPromotion, refusePromotion } from './promote.js';
import { fitIndex, pruneDangling, type IndexEntry } from './index-layer.js';

/**
 * Dream 提交之后的两个副作用：提升到通用层、写索引。
 *
 * 抽出来不只是为了行数：这两件事和「回放整合」是不同性质的工作。
 * 回放决定「记什么」，这里决定「记的东西怎么组织」——后者失败不该影响前者。
 */
export interface EffectDeps {
  repository: MemoryRepository;
  experience: ExperienceLog;
}

export type DreamPromotion = { id: string; why: string };

/**
 * 执行模型判断的提升：复制到 owner 层，不动原记录。
 *
 * 没有人工审核这一环，所以这里只拦**结构上说不通**的（过期、非 active、已经在通用层、
 * bot 自有状态、已经提过）。判断该不该通用由模型负责——它是唯一读到上下文的角色。
 */
export function promoteMemories(deps: EffectDeps, promotions: readonly DreamPromotion[], now: number): void {
  for (const item of promotions) {
    const memory = deps.repository.get(item.id);
    const refusal = refusePromotion(memory, now);
    if (refusal !== undefined || !memory) {
      deps.experience.record('dream', 'dream.promotion.refused', { id: item.id, reason: refusal ?? '没有这条' }, now);
      continue;
    }
    // 已经提过就不要再提：否则每次整合都复制一份 owner 副本，越堆越多。
    if (deps.repository.get(`${item.id}@owner`)) {
      deps.experience.record('dream', 'dream.promotion.refused', { id: item.id, reason: '已经提升过' }, now);
      continue;
    }
    deps.repository.publish(buildPromotion(memory, item.why, now));
    deps.experience.record('dream', 'dream.promotion.applied', { id: item.id, from: memory.scope, why: item.why }, now);
  }
}

/**
 * 落库索引：每个作用域全量替换，先裁到合法大小、并丢掉指向空处的条目。
 *
 * 没给的 scope 表示「这份不动」——不是清空。想清空要显式给空 entries。
 */
export function writeMemoryIndexes(deps: EffectDeps, indexes: readonly { scope: string; entries: readonly IndexEntry[] }[] | undefined, now: number): void {
  if (indexes === undefined || !deps.repository.publishIndex) return;
  for (const { scope, entries } of indexes) {
    const prior = deps.repository.index?.(scope);
    const fitted = fitIndex(entries, prior?.version ?? 0, now, scope);
    const { index, dropped } = pruneDangling(fitted, id => deps.repository.get(id) !== undefined);
    deps.repository.publishIndex({ ...index, version: index.version + 1 });
    if (dropped > 0) deps.experience.record('dream', 'memory.index.pruned', { scope, dropped }, now);
    deps.experience.record('dream', 'memory.index.written', { scope, entries: index.entries.length }, now);
  }
}
