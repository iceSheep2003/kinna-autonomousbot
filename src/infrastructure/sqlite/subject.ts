import type { GoalRepository, SubjectRepository } from '../../subject/ports.js';
import type { AffectState, Appraisal, Goal, GoalRevision, SelfState } from '../../subject/types.js';
import type { Store } from './database.js';
import { searchTerms, matchSql } from './search.js';

export class SqliteSubjectRepository implements SubjectRepository {
  constructor(private readonly db: Store) {}
  read() { return this.db.get<SelfState>('subject', 'self'); }
  save(state: SelfState) { this.db.put('subject', 'self', state); }
  recordAppraisal(appraisal: Appraisal, now: number) {
    this.db.record('self', 'affect.appraisal', appraisal, now);
    if (appraisal.target) this.db.put('affect', appraisal.target, { valence: appraisal.valence, arousal: appraisal.arousal, description: appraisal.description, updatedAt: now });
  }
  affectFor(target: string) { return this.db.get<AffectState>('affect', target); }
}
export class SqliteGoalRepository implements GoalRepository {
  constructor(private readonly db: Store) {}
  get(id: string) { return this.db.get<Goal>('goals', id); }
  save(goal: Goal) { this.db.put('goals', goal.id, goal); }
  relevant(query: string, limit: number): Goal[] {
    const terms = searchTerms(query);
    const matches = terms.length ? this.db.query<Goal>('goals', `json_extract(body,'$.status')='active' AND (${matchSql(terms)})`, terms, limit) : [];
    const ids = new Set(matches.map(g => g.id));
    const recent = this.db.query<Goal>('goals', "json_extract(body,'$.status')='active' ORDER BY json_extract(body,'$.updatedAt') DESC", [], limit);
    return [...matches, ...recent.filter(g => !ids.has(g.id))].slice(0, limit);
  }
  recordRevision(change: GoalRevision, now: number) { this.db.record('self', 'goal.revised', change, now); }
}
