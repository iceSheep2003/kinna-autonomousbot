import type { SelfCommitter } from '../self/ports.js';
import type { SelfDecision } from '../self/decision.js';
import type { SubjectService } from '../subject/service.js';
import type { ExecutionService } from '../execution/service.js';
import type { ReflectionService } from '../memory/reflection.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type { JobQueue } from '../runtime/ports.js';

/** 跨模块应用用例：只调用模块服务，不触及存储结构。由 worker 在一个事务里提交。 */
export class DecisionCommitter implements SelfCommitter {
  constructor(private readonly subject: SubjectService, private readonly executions: ExecutionService,
    private readonly scheduler: Scheduler, private readonly reflections: ReflectionService,
    private readonly jobs: JobQueue, private readonly capacity: number) {}
  apply(decision: SelfDecision, revision: number, evidence: number[], now: number): void {
    if (this.jobs.count() + decision.launch.length + decision.act.length + Number(decision.dream) > this.capacity) throw new Error('Pending job capacity exceeded');
    const changes = this.subject.apply(decision, revision, now);
    for (const change of changes) {
      this.scheduler.invalidateGoal(change.next.id);
      this.executions.invalidateGoal(change.next.id, now);
    }
    for (const id of decision.cancelExecutions) this.executions.pause(id, 'Self cancelled execution', now);
    for (const id of decision.cancelSchedules) this.scheduler.cancel(id);
    for (const intent of decision.launch) this.executions.launch(intent, now);
    for (const action of decision.act) this.executions.act(action, now);
    for (const schedule of decision.schedules) this.scheduler.schedule(schedule, now);
    if (decision.nextWakeAt !== undefined) this.scheduler.wakeAt(decision.nextWakeAt, now);
    if (decision.dream) this.jobs.enqueue('dream', 'dream', {}, now);
    this.reflections.record({ sourceRefs: evidence, summary: decision.reflection, conclusions: [], proposedChanges: [] }, now);
  }
}
