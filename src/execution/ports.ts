import type { Execution, ExecutionDecision } from './types.js';
export interface ExecutionRepository {
  get(id: string): Execution | undefined;
  save(execution: Execution): void;
  ongoing(limit: number): Execution[];
  activeForGoal(goalId: string): Execution[];
  decision(stepId: string): ExecutionDecision | undefined;
  saveDecision(stepId: string, decision: ExecutionDecision): void;
  recentDecisions(id: string, limit: number): unknown[];
  appendTurn(id: string, turn: { at: number; context: unknown; decision: unknown }): void;
}
export interface ExecutionRequests {
  continue(id: string, now: number): void;
  report(id: string, status: Execution['status'], result: string, now: number): void;
}
export interface GoalAuthority { requireActiveGoal(id?: string): unknown }
export interface ExecutionView { ongoing(limit: number): Execution[]; acceptsEvents(id: string): boolean }

export interface SceneSessionRepository {
  get(id: string): import('./scene-types.js').SceneSessionState | undefined;
  save(session: import('./scene-types.js').SceneSessionState): void;
  step(id: string): import('./scene-types.js').SceneStep | undefined;
  saveStep(id: string, step: import('./scene-types.js').SceneStep): void;
  recentDecisions(id: string, limit: number): unknown[];
  appendTurn(id: string, turn: { at: number; context: unknown; decision: unknown }): void;
}
export interface SceneRequests {
  continue(id: string, now: number): void;
  reflect(id: string, trigger: string, summary: string, evidence: number[], now: number): void;
}
