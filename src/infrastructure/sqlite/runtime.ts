import type { JobQueue, RuntimeRepository, BudgetRepository, ScheduleRepository } from '../../runtime/ports.js';
import type { Job, Schedule } from '../../runtime/types.js';
import type { Store } from './database.js';
export class SqliteJobQueue implements JobQueue {
  constructor(private readonly db: Store) {}
  enqueue(kind: string, key: string, payload: Record<string, unknown>, now: number) { return this.db.enqueue(kind, key, payload, now); }
  count() { return this.db.pendingCount(); }
  claim(now: number) { return this.db.claim(now); }
  finish(id: string) { this.db.finish(id); }
  retry(job: Job, error: string, now: number) { this.db.retry(job, error, now); }
  defer(job: Job, until: number) { this.db.db.prepare("UPDATE jobs SET status='pending',attempts=attempts-1,dueAt=? WHERE id=?").run(until, job.id); }
  recover() { this.db.recover(); }
}
export class SqliteRuntimeRepository implements RuntimeRepository {
  constructor(private readonly db: Store) {}
  acquire(owner: string, now: number) { return this.db.acquireLease(owner, now); }
  release(owner: string) { this.db.releaseLease(owner); }
  nextPeriodic(kind: string) { return this.db.get<number>('meta', `next.${kind}`); }
  setNextPeriodic(kind: string, at: number) { this.db.put('meta', `next.${kind}`, at); }
  seen(key: string) { return !!this.db.db.prepare('SELECT 1 FROM seen_events WHERE id=?').get(key); }
  markSeen(key: string) { this.db.db.prepare('INSERT INTO seen_events VALUES (?)').run(key); }
}
export class SqliteBudgetRepository implements BudgetRepository {
  constructor(private readonly db: Store) {}
  reserve(now: number, max: number) { return this.db.reserveCall(now, max); }
}
export class SqliteScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Store) {}
  get(id: string) { return this.db.get<Schedule>('schedules', id); }
  save(schedule: Schedule) { this.db.put('schedules', schedule.id, schedule); }
  pending(limit: number) { return this.db.query<Schedule>('schedules', "json_extract(body,'$.status')='pending' ORDER BY json_extract(body,'$.dueAt')", [], limit); }
  due(now: number, limit: number) { return this.db.query<Schedule>('schedules', "json_extract(body,'$.status')='pending' AND json_extract(body,'$.dueAt')<=? ORDER BY json_extract(body,'$.dueAt')", [now], limit); }
  cancelForGoal(id: string) { this.db.db.prepare("UPDATE documents SET body=json_set(body,'$.status','cancelled') WHERE collection='schedules' AND json_extract(body,'$.goalId')=? AND json_extract(body,'$.status')='pending'").run(id); }
}
