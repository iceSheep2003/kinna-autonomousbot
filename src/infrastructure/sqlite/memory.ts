import type { DreamState, DreamStateRepository, ExperienceRepository, MemoryRepository, ReflectionRepository } from '../../memory/ports.js';
import type { DreamVersion, Memory, RecallRequest, Reflection } from '../../memory/types.js';
import type { Store } from './database.js';
import { searchTerms, matchSql } from './search.js';

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
  get(id: string) { return this.db.get<Memory>('memories', id); }
  recent(limit: number) { return this.db.list<Memory>('memories', limit); }
  search(query: string, limit: number) {
    const terms = searchTerms(query);
    return terms.length ? this.db.query<Memory>('memories', matchSql(terms), terms, limit) : this.recent(limit);
  }
  /** 硬过滤前的候选池；状态/过期/可见性由 memory/access.ts 在读取时重新验权。 */
  candidates(request: RecallRequest): Memory[] {
    return this.db.query<Memory>('memories', '1=1', [], Math.max(100, request.limit * 20));
  }
  /** 被注入过一次就记一次访问，不提升 revision：这不是内容变更。 */
  reinforce(ids: string[], now: number) {
    for (const id of ids) {
      const memory = this.get(id);
      if (!memory) continue;
      this.db.put('memories', id, { ...memory, accessCount: (memory.accessCount ?? 0) + 1, lastAccessedAt: now });
    }
  }
  publish(memory: Memory) {
    const prior = this.get(memory.id);
    if (prior) this.db.put('memory-history', `${memory.id}:${prior.revision}`, prior);
    this.db.put('memories', memory.id, withDefaults(memory));
  }
  cursor() { return this.db.get<number>('meta', 'dreamCursor') ?? 0; }
  count() { return Number(this.db.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection='memories'").get()!.n); }
  publishDream(version: DreamVersion) {
    this.db.put('dreams', version.id, version);
    this.db.put('meta', 'dreamCursor', version.cutoff);
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
