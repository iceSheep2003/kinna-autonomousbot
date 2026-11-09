import type { SelfCommitter } from '../self/ports.js';
import type { SelfDecision } from '../self/decision.js';
import type { SubjectService } from '../subject/service.js';
import type { ExecutionService } from '../execution/service.js';
import type { ReflectionService } from '../memory/reflection.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type { JobQueue } from '../runtime/ports.js';

export interface CommitterDependencies {
  subject: SubjectService;
  executions: ExecutionService;
  scheduler: Scheduler;
  reflections: ReflectionService;
  jobs: JobQueue;
  capacity: number;
}

/** 跨模块应用用例：只调用模块服务，不触及存储结构。由 worker 在一个事务里提交。 */
export class DecisionCommitter implements SelfCommitter {
  private readonly subject: SubjectService;
  private readonly executions: ExecutionService;
  private readonly scheduler: Scheduler;
  private readonly reflections: ReflectionService;
  private readonly jobs: JobQueue;
  private readonly capacity: number;
  constructor(deps: CommitterDependencies) {
    this.subject = deps.subject; this.executions = deps.executions; this.scheduler = deps.scheduler;
    this.reflections = deps.reflections; this.jobs = deps.jobs; this.capacity = deps.capacity;
  }
  apply(decision: SelfDecision, revision: number, evidence: number[], now: number): void {
    this.assertCapacity(decision);
    this.reviseGoals(decision, revision, now);
    this.cancel(decision, now);
    this.start(decision, now);
    this.reflections.record({ sourceRefs: evidence, summary: decision.reflection, conclusions: [], proposedChanges: [] }, now);
  }
  private assertCapacity(decision: SelfDecision): void {
    const added = decision.launch.length + decision.act.length + Number(decision.dream);
    if (this.jobs.count() + added > this.capacity) throw new Error('Pending job capacity exceeded');
  }
  /** 目标修订后旧日程与旧执行一起失效，避免用过期目标继续推进。 */
  private reviseGoals(decision: SelfDecision, revision: number, now: number): void {
    for (const change of this.subject.apply(decision, revision, now)) {
      this.scheduler.invalidateGoal(change.next.id);
      this.executions.invalidateGoal(change.next.id, now);
    }
  }
  private cancel(decision: SelfDecision, now: number): void {
    for (const id of decision.cancelExecutions) this.executions.pause(id, 'Self cancelled execution', now);
    for (const id of decision.cancelSchedules) this.scheduler.cancel(id);
  }
  private start(decision: SelfDecision, now: number): void {
    for (const intent of decision.launch) this.executions.launch(intent, now);
    for (const action of decision.act) this.executions.act(action, now);
    for (const schedule of decision.schedules) this.scheduler.schedule(schedule, now);
    if (decision.nextWakeAt !== undefined) this.scheduler.wakeAt(decision.nextWakeAt, now);
    if (decision.dream) this.jobs.enqueue('dream', 'dream', {}, now);
  }
}
