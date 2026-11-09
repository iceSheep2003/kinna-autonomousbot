import type { ExperienceRepository, MemoryRepository, ReflectionRepository } from '../../memory/ports.js';
import type { DreamVersion, Memory, Reflection } from '../../memory/types.js';
import type { Store } from './database.js';
import { searchTerms, matchSql } from './search.js';
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
  publish(memory: Memory) {
    const prior = this.get(memory.id);
    if (prior) this.db.put('memory-history', `${memory.id}:${prior.revision}`, prior);
    this.db.put('memories', memory.id, memory);
  }
  cursor() { return this.db.get<number>('meta', 'dreamCursor') ?? 0; }
  publishDream(version: DreamVersion) {
    this.db.put('dreams', version.id, version);
    this.db.put('meta', 'dreamCursor', version.cutoff);
  }
}
export class SqliteReflectionRepository implements ReflectionRepository {
  constructor(private readonly db: Store) {}
  save(reflection: Reflection) { this.db.put('reflections', reflection.id, reflection); }
  get(id: string) { return this.db.get<Reflection>('reflections', id); }
}
