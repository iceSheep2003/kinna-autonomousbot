import type { DreamState, DreamStateRepository, ExperienceRepository, MemoryRepository, ReflectionRepository } from '../../memory/ports.js';
import type { DreamVersion, Memory, RecallRequest, Reflection } from '../../memory/types.js';
import type { Store } from './database.js';
import { searchTerms, matchSql } from './search.js';
import { readIndex, readIndexes, writeIndex } from './memory-index.js';
import { fromRow, upsertMemory, writeEvidence } from './memory-rows.js';

/** 生命周期默认值：旧记忆（Dream 旧版只有五个字段）与新写入的修订共用一张表。 */
function lifecycleDefaults(stamp: number): Pick<Memory,
  'createdAt' | 'updatedAt' | 'accessCount' | 'confidence' | 'importance' | 'status' | 'mentionPolicy' | 'factType'> {
  return {
    createdAt: stamp, updatedAt: stamp, accessCount: 0, confidence: 1, importance: 1,
    status: 'active', mentionPolicy: 'soft_echo', factType: 'fact',
  };
}

/**
 * 补齐 Dream 产出契约之外的字段，让旧记忆也能参与排序/过期判断。
 * 幂等：已带字段的记录不会被改写。
 */
function withDefaults(memory: Memory): Memory {
  const stamp = memory.updatedAt ?? memory.createdAt ?? Date.now();
  return { ...lifecycleDefaults(stamp), ...memory };
}
export class SqliteExperienceRepository implements ExperienceRepository {
  constructor(private readonly db: Store) {}
  append(source: string, kind: string, data: unknown, now: number) { return this.db.record(source, kind, data, now); }
  read(after: number, limit: number, source?: string) { return this.db.experiences(after, limit, source); }
  recent(source: string, limit: number) { return this.db.recentExperiences(source, limit); }
  exists(seq: number) { return this.db.hasEvidence(seq); }
  countAfter(source: string, after: number) { return Number(this.db.db.prepare('SELECT COUNT(*) AS n FROM experience WHERE source=? AND seq>?').get(source, after)!.n); }
}
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Store) {}

  get(id: string) { return fromRow(this.db.db.prepare('SELECT * FROM memories WHERE id=?').get(id)); }
  recent(limit: number) {
    return this.db.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit).map(row => fromRow(row)!);
  }

  /**
   * 检索：先在关系表上做子串匹配。
   *
   * 仍然是全表扫——但按真实规模（一年四千条）这只要几毫秒，
   * 加全文索引是给十几年后的量级做优化，不值得多一层维护成本。
   * 等真慢了再用 EXPLAIN QUERY PLAN 看瓶颈，而不是现在猜。
   */
  search(query: string, limit: number) {
    const terms = searchTerms(query);
    if (terms.length === 0) return this.recent(limit);
    const predicate = terms.map(() => 'instr(lower(content),?)>0').join(' OR ');
    return this.db.db.prepare(`SELECT * FROM memories WHERE ${predicate} ORDER BY updated_at DESC LIMIT ?`)
      .all(...terms, limit).map(row => fromRow(row)!);
  }

  /**
   * 候选池。**这里才用得上索引**：作用域 + 状态是第一道过滤，走 memories_scope。
   * 之前是 `'1=1'` 全表取一批，再把整批交给 access.ts 过滤。
   */
  candidates(request: RecallRequest): Memory[] {
    const cap = Math.max(100, request.limit * 20);
    const scope = request.scope ?? 'owner';
    // 归档的默认不进候选池，但**主动回想时要进**——否则「遗忘可逆」根本无从生效：
    // 这里过滤掉，后面 access.ts 的 includeArchived 就再也没机会看到它们。
    const statuses = request.includeArchived === true
      ? "'active','candidate','archived'"
      : "'active','candidate'";
    const rows = this.db.db.prepare(
      `SELECT * FROM memories WHERE status IN (${statuses}) AND scope IN ('owner', ?)
       ORDER BY updated_at DESC LIMIT ?`).all(scope, cap);
    return rows.map(row => fromRow(row)!);
  }

  /** 被注入过一次就记一次访问；不提升 revision，这不是内容变更。 */
  reinforce(ids: string[], now: number) {
    const update = this.db.db.prepare('UPDATE memories SET access_count=access_count+1, last_accessed_at=? WHERE id=?');
    for (const id of ids) update.run(now, id);
  }

  publish(memory: Memory) {
    const prior = this.get(memory.id);
    if (prior) this.db.put('memory-history', `${memory.id}:${prior.revision}`, prior);
    const row = withDefaults(memory);
    upsertMemory(this.db.db, row);
    writeEvidence(this.db.db, row);
  }

  /**
   * 按人取事实，走 memories_subject 索引。
   * 作用域同样遵守「owner + 当前场景」，不越界。
   */
  factsAbout(userId: string, scope: string, limit: number) {
    return this.db.db.prepare(
      `SELECT * FROM memories WHERE subject_user_id=? AND status='active' AND scope IN ('owner', ?)
       ORDER BY importance DESC, updated_at DESC LIMIT ?`).all(userId, scope, limit).map(row => fromRow(row)!);
  }

  cursor() { return this.db.get<number>('meta', 'dreamCursor') ?? 0; }
  index(scope = 'owner') { return readIndex(this.db, scope); }
  indexes() { return readIndexes(this.db); }
  publishIndex(index: import('../../memory/index-layer.js').MemoryIndex) { writeIndex(this.db, index); }
  count() { return Number(this.db.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n); }

  publishDream(version: DreamVersion) {
    this.db.put('dreams', version.id, version);
    this.db.put('meta', 'dreamCursor', version.cutoff);
  }
  /** 整合 id 是随机 UUID，文档表排序不可用；取一批再按 at 排，量级是有限的历史整合。 */
  recentDreams(limit: number): DreamVersion[] {
    return this.db.list<DreamVersion>('dreams', 500).sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit));
  }

}

/** 门控状态与记忆内容分开存，避免「整理记忆」顺手改掉「何时该整理」。 */
export class SqliteDreamStateRepository implements DreamStateRepository {
  constructor(private readonly db: Store) {}
  read(): DreamState {
    return this.db.get<DreamState>('meta', 'dreamState')
      ?? { lastAt: 0, lastScanAt: 0, runsToday: 0, runDay: -1, blocked: {} };
  }
  write(state: DreamState) { this.db.put('meta', 'dreamState', state); }
}
export class SqliteReflectionRepository implements ReflectionRepository {
  constructor(private readonly db: Store) {}
  save(reflection: Reflection) { this.db.put('reflections', reflection.id, reflection); }
  get(id: string) { return this.db.get<Reflection>('reflections', id); }
}
