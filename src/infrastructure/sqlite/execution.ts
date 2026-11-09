import type { ExecutionRepository } from '../../execution/ports.js';
import type { Execution, ExecutionDecision } from '../../execution/types.js';
import type { Store } from './database.js';
import { recentDecisions } from './sessions.js';
export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: Store) {}
  get(id: string) { return this.db.get<Execution>('executions', id); }
  save(execution: Execution) { this.db.put('executions', execution.id, execution); }
  ongoing(limit: number) { return this.db.query<Execution>('executions', "json_extract(body,'$.status') IN ('active','paused')", [], limit); }
  activeForGoal(goalId: string) {
    return this.db.db.prepare("SELECT body FROM documents WHERE collection='executions' AND json_extract(body,'$.status')='active' AND json_extract(body,'$.goalId')=?")
      .all(goalId).map(row => JSON.parse(row.body as string) as Execution);
  }
  decision(stepId: string) { return this.db.get<ExecutionDecision>('execution-decisions', stepId); }
  saveDecision(stepId: string, decision: ExecutionDecision) { this.db.put('execution-decisions', stepId, decision); }
  recentDecisions(id: string, limit: number) { return recentDecisions(this.db, `execution:${id}`, limit); }
  appendTurn(id: string, turn: { at: number; context: unknown; decision: unknown }) { this.db.appendTurn(`execution:${id}`, turn); }
}
