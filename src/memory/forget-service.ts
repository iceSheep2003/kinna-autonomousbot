import type { MemoryRepository } from './ports.js';
import type { Memory } from './types.js';
import { DEFAULT_FORGET, archive, planForgetting, type ForgetPolicy } from './forget.js';

/**
 * 定期归档冷掉的记忆。
 *
 * 和压缩分开跑：压缩处理「重复」，归档处理「陈旧」。两者判断依据不同，
 * 混在一起会让逻辑难读，也不好在实验里分别度量。
 *
 * 归档**不是删除**：内容与证据原样保留，只是不再默认进上下文；
 * 主动回想（memory.search）仍能找到，找到就恢复。
 */
export interface ForgetDeps {
  repository: MemoryRepository;
  policy?: ForgetPolicy;
  now?: () => number;
  pool?: (limit: number) => Memory[];
  record?: (kind: string, data: unknown, now: number) => void;
}

export interface ForgetResult { archived: number; candidates: number }

export class MemoryForgetter {
  constructor(private readonly deps: ForgetDeps) {}

  run(): ForgetResult {
    const now = this.deps.now?.() ?? Date.now();
    const pool = this.deps.pool ?? ((limit: number) => this.deps.repository.recent(limit));
    const rows = pool(600);
    const picked = planForgetting(rows, now, this.deps.policy ?? DEFAULT_FORGET);
    for (const memory of picked) this.deps.repository.publish(archive(memory, now));
    const result = { archived: picked.length, candidates: rows.length };
    if (picked.length > 0) this.deps.record?.('memory.archived', result, now);
    return result;
  }
}
