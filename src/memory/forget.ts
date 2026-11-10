import type { Memory } from './types.js';

/**
 * 遗忘。
 *
 * 现在库里的记忆只增不减：compress 合并的是「重复」，可「不同的事」会一直累积
 * （真实数据 280 条里已经没什么可合并的了）。没有遗忘，注入预算会被稀释，
 * 检索也会被陈年旧事干扰。
 *
 * 但「遗忘」不等于删除。这里做的是**归档**：不再进默认上下文，主动回想时仍能找到。
 * 人也这样——一时想不起，给个提示就想起来了。
 *
 * 四条保护，宁可少归档：
 * 1. 通用层（owner）不归档——提上来的是判断，不是流水账；
 * 2. 重要的不归档（重要度高于阈值）；
 * 3. 有明确过期时间的走「过期」而不是「归档」（那是另一条路径）；
 * 4. 被反复用到的（accessCount 高）不归档——常用说明还有用。
 */
export interface ForgetPolicy {
  /** 多久没被访问算「冷」。 */
  coldAfterMs: number;
  /** 重要度在这个值及以下的才可能被归档。 */
  maxImportance: number;
  /** 被访问过这么多次的记忆不归档：常用说明还有用。 */
  keepAccessCount: number;
  /** 一次最多归档多少条，避免一次清掉半个库。 */
  maxPerRun: number;
}

export const DEFAULT_FORGET: ForgetPolicy = {
  coldAfterMs: 60 * 24 * 3600_000,
  maxImportance: 2,
  keepAccessCount: 3,
  maxPerRun: 20,
};

/**
 * 挑出该归档的记忆。
 *
 * 「冷」按最后一次被用到算；从没被用过就用创建时间。
 * 只看 active：candidate 本来就没确认，superseded 已经不在召回里。
 */
export function planForgetting(memories: readonly Memory[], now: number, policy: ForgetPolicy = DEFAULT_FORGET): Memory[] {
  const cold = memories
    .filter(memory => (memory.status ?? 'active') === 'active')
    .filter(memory => (memory.scope ?? 'owner') !== 'owner')
    .filter(memory => memory.expiresAt === undefined)
    .filter(memory => (memory.importance ?? 0) <= policy.maxImportance)
    .filter(memory => (memory.accessCount ?? 0) < policy.keepAccessCount)
    .filter(memory => now - lastTouched(memory) >= policy.coldAfterMs)
    .sort((a, b) => lastTouched(a) - lastTouched(b));
  return cold.slice(0, policy.maxPerRun);
}

/** 上次被用到是什么时候：访问优先，其次创建。都没有当 0（最老）。 */
function lastTouched(memory: Memory): number {
  return memory.lastAccessedAt ?? memory.createdAt ?? 0;
}

/** 归档一条：保留内容与证据，只是不再默认注入。 */
export function archive(memory: Memory, now: number): Memory {
  return { ...memory, status: 'archived', updatedAt: now };
}

/**
 * 被再次想起来：归档的记忆如果被主动搜索命中并真正用到，就恢复成 active。
 *
 * 这是「遗忘可逆」的关键——否则一次归档就等于永久丢失，
 * 而归档判断本来就可能出错（重要度标低了、那条恰好不常被问）。
 */
export function revive(memory: Memory, now: number): Memory {
  if ((memory.status ?? 'active') !== 'archived') return memory;
  return { ...memory, status: 'active', updatedAt: now, lastAccessedAt: now, accessCount: (memory.accessCount ?? 0) + 1 };
}
