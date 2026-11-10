import type { Person } from '../../memory/person.js';
import type { Store } from './database.js';

/** 人物按 userId 存：跨群是同一个人，群列表记在 groups 里。 */
export const PERSON_COLLECTION = 'people';

export class SqlitePeopleRepository {
  constructor(private readonly db: Store) {}
  get(userId: string): Person | undefined { return this.db.get<Person>(PERSON_COLLECTION, userId); }
  save(person: Person): void { this.db.put(PERSON_COLLECTION, person.userId, person); }
  list(limit = 100): Person[] { return this.db.list<Person>(PERSON_COLLECTION, limit); }
  /** 最近见过的人：注入时优先给这些，不按首次认识排序。 */
  recent(limit: number): Person[] {
    return this.list(500).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, Math.max(1, limit));
  }
}
