import type { Job, Schedule, ScheduleInput } from './types.js';
import type { Commit } from '../shared/transaction.js';
export interface JobQueue {
  enqueue(kind: string, key: string, payload: Record<string, unknown>, now: number): string;
  count(): number; claim(now: number): Job | undefined; finish(id: string): void;
  retry(job: Job, error: string, now: number): void; defer(job: Job, until: number): void; recover(): void;
}
export interface RuntimeRepository {
  acquire(owner: string, now: number): boolean; release(owner: string): void;
  nextPeriodic(kind: string): number | undefined; setNextPeriodic(kind: string, at: number): void;
  seen(key: string): boolean; markSeen(key: string): void;
}
export interface BudgetRepository { reserve(now: number, max: number): boolean }
export interface ScheduleRepository {
  get(id: string): Schedule | undefined; save(schedule: Schedule): void;
  pending(limit: number): Schedule[]; due(now: number, limit: number): Schedule[]; cancelForGoal(goalId: string): void;
}
/** 调度器只落实何时发生；目标有效性和启动执行由装配的应用策略负责。 */
export interface SchedulePolicy {
  goalRevision(id?: string): number | undefined;
  stillValid(schedule: Schedule): boolean;
  validate(action: ScheduleInput['action']): void;
  execute(schedule: Schedule, now: number): void;
}
export interface JobHandler { prepare(job: Job, now: number): Promise<Commit>; failed?(job: Job, error: string, now: number): void }
export interface PeriodicAction { key: string; intervalMs: number; fire(now: number): void }
