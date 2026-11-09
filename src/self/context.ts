import type { Boundaries, ContextLimits } from '../shared/limits.js';
import type { SubjectView } from '../subject/ports.js';
import type { MemoryView } from '../memory/ports.js';
import type { ExecutionView } from '../execution/ports.js';
import type { CapabilityAccess } from '../capabilities/ports.js';
import type { Schedule } from '../runtime/types.js';
import type { SelfInbox, SelfSessionRepository } from './ports.js';

export class SelfContextBuilder {
  constructor(private readonly subject: SubjectView, private readonly memory: MemoryView,
    private readonly executions: ExecutionView, private readonly schedules: { pending(limit: number): Schedule[] },
    private readonly inbox: SelfInbox, private readonly session: SelfSessionRepository,
    private readonly capabilities: CapabilityAccess, private readonly boundaries: Boundaries, private readonly limits: ContextLimits) {}
  build(trigger: unknown, previousAttemptError: string | undefined, now: number) {
    const cursor = this.session.cursor();
    const observations = this.inbox.read(cursor, this.limits.observations);
    const query = JSON.stringify(observations).slice(0, 3000);
    return { cursor, now, trigger, previousAttemptError, subject: this.subject.read(),
      goals: this.subject.goals(query, this.limits.goals), memories: this.memory.recall(query, this.limits.memories),
      observations, recent: this.session.recentDecisions(this.limits.recentTurns),
      capabilities: this.capabilities.catalog(this.boundaries.allowedTools), boundaries: this.boundaries,
      schedules: this.schedules.pending(this.limits.schedules), executions: this.executions.ongoing(this.limits.executions) };
  }
}
