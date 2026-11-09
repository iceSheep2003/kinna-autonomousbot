import type { SelfSessionRepository } from '../../self/ports.js';
import type { SelfDecision } from '../../self/decision.js';
import type { Store } from './database.js';
export function recentDecisions(db: Store, session: string, limit: number): unknown[] {
  return db.turns(session, limit).map(turn => { const t = turn as { at: number; decision: unknown }; return { at: t.at, decision: t.decision }; });
}
export class SqliteSelfSessionRepository implements SelfSessionRepository {
  constructor(private readonly db: Store) {}
  cursor() { return this.db.get<number>('meta', 'selfCursor') ?? 0; }
  advanceCursor(seq: number) { this.db.put('meta', 'selfCursor', seq); }
  append(turn: { at: number; context: unknown; decision: SelfDecision }) { this.db.appendTurn('self', turn); }
  recentDecisions(limit: number) { return recentDecisions(this.db, 'self', limit); }
}
