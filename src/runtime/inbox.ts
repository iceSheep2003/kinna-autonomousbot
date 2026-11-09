import type { UnitOfWork } from '../shared/transaction.js';
import type { ExperienceRepository } from '../memory/ports.js';
import type { SelfInbox } from '../self/ports.js';
import type { JobQueue, RuntimeRepository } from './ports.js';
import { EventSchema, type IncomingEvent } from './types.js';

const MAX_EVENT_CHARS = 24000;
/** 场景会话的接收口；inbox 只转交，不认识场景内部结构。 */
type SceneReceiver = (scene: { id: string; environment: string; scope: Record<string, string> }, kind: string, data: unknown, now: number) => void;

export interface InboxDependencies {
  transaction: UnitOfWork;
  runtime: RuntimeRepository;
  experience: ExperienceRepository;
  jobs: JobQueue;
  selfCursor: () => number;
  acceptsExecution: (id: string) => boolean;
  capacity: number;
  receiveSession: SceneReceiver;
}

export class Inbox implements SelfInbox {
  private readonly transaction: UnitOfWork;
  private readonly runtime: RuntimeRepository;
  private readonly experience: ExperienceRepository;
  private readonly jobs: JobQueue;
  private readonly selfCursor: () => number;
  private readonly acceptsExecution: (id: string) => boolean;
  private readonly capacity: number;
  private readonly receiveSession: SceneReceiver;
  constructor(deps: InboxDependencies) {
    this.transaction = deps.transaction; this.runtime = deps.runtime; this.experience = deps.experience;
    this.jobs = deps.jobs; this.selfCursor = deps.selfCursor; this.acceptsExecution = deps.acceptsExecution;
    this.capacity = deps.capacity; this.receiveSession = deps.receiveSession;
  }
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
    if (JSON.stringify(event).length > MAX_EVENT_CHARS) throw new Error('Event too large; provide resource reference');
    return this.transaction.run(() => this.accept(event, now));
  }
  private accept(event: IncomingEvent, now: number): { duplicate: boolean } {
    const key = JSON.stringify([event.source, event.id]);
    if (this.runtime.seen(key)) return { duplicate: true };
    this.assertCapacity(event);
    this.runtime.markSeen(key);
    this.route(event, now);
    return { duplicate: false };
  }
  private assertCapacity(event: IncomingEvent): void {
    if (event.route.type !== 'experience' && this.jobs.count() >= this.capacity) throw new Error('Event queue is full');
    if (event.route.type === 'self' && this.experience.countAfter('self.inbox', this.selfCursor()) >= this.capacity * 20) throw new Error('Self inbox is full');
    if (event.route.type === 'execution' && !this.acceptsExecution(event.route.executionId)) throw new Error('Event target is not an active execution');
  }
  /** 普通环境消息进持续场景会话，执行结果回到发起它的执行，只有反思事件进 self。 */
  private route(event: IncomingEvent, now: number): void {
    const data = { source: event.source, data: event.data };
    const { route } = event;
    if (route.type === 'self') this.notify(event.kind, data, now);
    else if (route.type === 'experience') this.experience.append(event.source, event.kind, data, now);
    else if (route.type === 'session') this.receiveSession({ id: route.sessionId, environment: route.environment, scope: route.scope }, event.kind, data, now);
    else {
      const source = `execution:${route.executionId}`;
      this.experience.append(source, event.kind, data, now);
      this.jobs.enqueue('execution', source, { executionId: route.executionId }, now);
    }
  }
}
