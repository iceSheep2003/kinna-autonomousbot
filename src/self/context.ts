import type { Boundaries, ContextLimits } from '../shared/limits.js';
import { payloadBudget } from '../shared/limits.js';
import type { MoodView, SubjectView } from '../subject/ports.js';
import type { MemoryView } from '../memory/ports.js';
import type { ExecutionView } from '../execution/ports.js';
import type { CapabilityAccess } from '../capabilities/ports.js';
import type { Schedule } from '../runtime/types.js';
import type { SelfInbox, SelfSessionRepository } from './ports.js';
import type { SelfTodo } from './todos.js';

export interface ContextDependencies {
  subject: SubjectView;
  memory: MemoryView;
  executions: ExecutionView;
  schedules: { pending(limit: number): Schedule[] };
  inbox: SelfInbox;
  session: SelfSessionRepository;
  capabilities: CapabilityAccess;
  boundaries: Boundaries;
  limits: ContextLimits;
  /** 自己记下的待办；不配置时不注入。 */
  todos?: () => SelfTodo[];
  /** 本场景固化的工具清单；不传则退回部署白名单（装配层负责按场景算）。 */
  toolNames?: string[];
}

/** self 每轮只看到有界快照；会话永久存在不等于上下文无限增长。 */
export class SelfContextBuilder {
  private readonly subject: SubjectView;
  private readonly memory: MemoryView;
  private readonly executions: ExecutionView;
  private readonly schedules: { pending(limit: number): Schedule[] };
  private readonly inbox: SelfInbox;
  private readonly session: SelfSessionRepository;
  private readonly capabilities: CapabilityAccess;
  private readonly boundaries: Boundaries;
  private readonly limits: ContextLimits;
  private readonly todos?: () => SelfTodo[];
  private readonly toolNames?: string[];
  constructor(deps: ContextDependencies) {
    this.subject = deps.subject; this.memory = deps.memory; this.executions = deps.executions;
    this.schedules = deps.schedules; this.inbox = deps.inbox; this.session = deps.session;
    this.capabilities = deps.capabilities; this.boundaries = deps.boundaries; this.limits = deps.limits;
    this.todos = deps.todos; this.toolNames = deps.toolNames;
  }
  build(trigger: unknown, previousAttemptError: string | undefined, now: number) {
    const cursor = this.session.cursor();
    const observations = this.inbox.read(cursor, this.limits.observations);
    const query = JSON.stringify(observations).slice(0, payloadBudget.recallQueryChars);
    const indexText = this.memory.indexText?.() ?? '';
    return { cursor, now, trigger, previousAttemptError, subject: this.subject.read(),
      goals: this.subject.goals(query, this.limits.goals),
      // 索引优先：先给一份目录（我记得什么），细节留给 memory.expand。
      ...(indexText === '' ? {} : { memoryIndex: indexText }),
      memories: this.memory.recall(query, this.limits.memories),
      observations, recent: this.session.recentDecisions(this.limits.recentTurns),
      // 自己想做的事：只给开着的、最新的几条，避免清单一长就变成负担。
      ...(this.todos ? { todos: this.todos().slice(0, 5) } : {}),
      // 工具清单由装配层按场景算好传进来；self 不认识「场景」这个概念。
      capabilities: this.capabilities.catalog(this.toolNames ?? this.boundaries.allowedTools), boundaries: this.boundaries,
      schedules: this.schedules.pending(this.limits.schedules), executions: this.executions.ongoing(this.limits.executions) };
  }
}
