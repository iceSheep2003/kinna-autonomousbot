import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../shared/transaction.js';
import type { JobHandler, JobQueue, PeriodicAction, RuntimeRepository } from './ports.js';
import type { Job } from './types.js';
import { BudgetExceeded } from './budget.js';

export interface WorkerDependencies {
  transaction: UnitOfWork;
  repository: RuntimeRepository;
  jobs: JobQueue;
  initialize: (now: number) => void;
  due: (now: number) => void;
  periodic: PeriodicAction[];
  reportError: (data: unknown, now: number) => void;
}

/** 通用执行机制：不知道主体、目标、Dream 或具体执行状态的结构。 */
export class Worker {
  private readonly owner = randomUUID();
  private busy = false;
  private started = false;
  private readonly handlers = new Map<string, JobHandler>();
  private currentTime = 0;
  private readonly transaction: UnitOfWork;
  private readonly repository: RuntimeRepository;
  private readonly jobs: JobQueue;
  private readonly initialize: (now: number) => void;
  private readonly due: (now: number) => void;
  private readonly periodic: PeriodicAction[];
  private readonly reportError: (data: unknown, now: number) => void;
  constructor(deps: WorkerDependencies) {
    this.transaction = deps.transaction; this.repository = deps.repository; this.jobs = deps.jobs;
    this.initialize = deps.initialize; this.due = deps.due; this.periodic = deps.periodic; this.reportError = deps.reportError;
  }
  clock = () => this.currentTime;
  register(kind: string, handler: JobHandler) {
    if (this.handlers.has(kind)) throw new Error(`Duplicate job handler: ${kind}`);
    this.handlers.set(kind, handler);
  }
  start(now = Date.now()): void {
    if (this.started) return;
    if (!this.repository.acquire(this.owner, now)) throw new Error('Another runtime owns this database');
    try {
      this.jobs.recover();
      this.transaction.run(() => {
        this.initialize(now);
        for (const action of this.periodic) if (this.repository.nextPeriodic(action.key) === undefined) this.repository.setNextPeriodic(action.key, now + action.intervalMs);
      });
      this.started = true;
    } catch (error) { this.repository.release(this.owner); throw error; }
  }
  async tick(now = Date.now()): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true; this.currentTime = now;
    try {
      this.start(now);
      if (!this.repository.acquire(this.owner, now)) throw new Error('Runtime lease lost');
      this.transaction.run(() => this.firePeriodic(now));
      const job = this.jobs.claim(now);
      if (!job) return false;
      return await this.runJob(job, now);
    } finally { this.busy = false; }
  }
  private firePeriodic(now: number): void {
    for (const action of this.periodic) {
      if (now < this.repository.nextPeriodic(action.key)!) continue;
      action.fire(now); this.repository.setNextPeriodic(action.key, now + action.intervalMs);
    }
    this.due(now);
  }
  private async runJob(job: Job, now: number): Promise<boolean> {
    const handler = this.handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`Unknown job kind: ${job.kind}`);
      const commit = await handler.prepare(job, now);
      // finish 与全部状态提交原子化；先 finish，允许本轮创建同 key 的下一作业。
      this.transaction.run(() => { this.jobs.finish(job.id); commit(); });
    } catch (error) {
      if (error instanceof BudgetExceeded) { this.jobs.defer(job, now + 60000); return false; }
      this.transaction.run(() => {
        this.jobs.retry(job, String(error), now);
        this.reportError({ jobId: job.id, kind: job.kind, error: String(error), terminal: job.attempts >= 3 }, now);
        if (job.attempts >= 3) handler?.failed?.(job, String(error), now);
      });
    }
    return true;
  }
  stop(): void {
    if (this.busy) throw new Error('Wait for in-flight tick before stopping');
    this.repository.release(this.owner); this.started = false;
  }
}
