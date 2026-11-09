import type { AffectState, Appraisal, Goal, GoalRevision, SelfState } from './types.js';
export interface SubjectRepository {
  read(): SelfState | undefined;
  save(state: SelfState): void;
  recordAppraisal(appraisal: Appraisal, now: number): void;
  affectFor(target: string): AffectState | undefined;
}
export interface GoalRepository {
  get(id: string): Goal | undefined;
  save(goal: Goal): void;
  relevant(query: string, limit: number): Goal[];
  recordRevision(change: GoalRevision, now: number): void;
}
export interface EvidenceReader { assertExists(refs: number[]): void }
/** 供执行/上下文查询使用；没有任何写接口。 */
export interface SubjectView {
  read(): SelfState;
  goal(id: string): Goal | undefined;
  goals(query: string, limit: number): Goal[];
  requireActiveGoal(id?: string): Goal | undefined;
}
