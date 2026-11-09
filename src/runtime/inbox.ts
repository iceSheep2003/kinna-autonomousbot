import type { UnitOfWork } from '../shared/transaction.js';
import type { ExperienceRepository } from '../memory/ports.js';
import type { SelfInbox } from '../self/ports.js';
import type { JobQueue, RuntimeRepository } from './ports.js';
import { EventSchema, type IncomingEvent } from './types.js';

export class Inbox implements SelfInbox {
  constructor(private readonly transaction: UnitOfWork, private readonly runtime: RuntimeRepository,
    private readonly experience: ExperienceRepository, private readonly jobs: JobQueue,
    private readonly selfCursor: () => number, private readonly acceptsExecution: (id: string) => boolean, private readonly capacity: number,
    private readonly receiveSession: (scene: { id: string; environment: string; scope: Record<string, string> }, kind: string, data: unknown, now: number) => void) {}
  notify(kind: string, data: unknown, now: number): void {
    this.experience.append('self.inbox', kind, data, now);
    this.jobs.enqueue('self', 'self', { reason: kind }, now);
  }
  read(after: number, limit: number) { return this.experience.read(after, limit, 'self.inbox'); }
  continueIfUnread(after: number, now: number) {
    if (this.read(after, 1).length) this.jobs.enqueue('self', 'self', { reason: 'remaining observations' }, now);
  }
  ingest(raw: IncomingEvent, now = Date.now()): { duplicate: boolean } {
    const event = EventSchema.parse(raw);
    if (JSON.stringify(event).length > 24000) throw new Error('Event too large; provide resource reference');
    return this.transaction.run(() => {
      const key = JSON.stringify([event.source, event.id]);
      if (this.runtime.seen(key)) return { duplicate: true };
      if (event.route.type !== 'experience' && this.jobs.count() >= this.capacity) throw new Error('Event queue is full');
      if (event.route.type === 'self' && this.experience.countAfter('self.inbox', this.selfCursor()) >= this.capacity * 20) throw new Error('Self inbox is full');
      if (event.route.type === 'execution' && !this.acceptsExecution(event.route.executionId)) throw new Error('Event target is not an active execution');
      this.runtime.markSeen(key);
      const data = { source: event.source, data: event.data };
      if (event.route.type === 'self') this.notify(event.kind, data, now);
      else if (event.route.type === 'experience') this.experience.append(event.source, event.kind, data, now);
      else if (event.route.type === 'session') this.receiveSession({ id: event.route.sessionId, environment: event.route.environment, scope: event.route.scope }, event.kind, data, now);
      else {
        const source = `execution:${event.route.executionId}`;
        this.experience.append(source, event.kind, data, now);
        this.jobs.enqueue('execution', source, { executionId: event.route.executionId }, now);
      }
      return { duplicate: false };
    });
  }
}
