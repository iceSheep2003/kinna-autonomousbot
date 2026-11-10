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
  /** 心境的一句话描述；由场景侧维护，self 只读。 */
  moodNarration?: () => string;
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
  private readonly moodNarration?: () => string;
  constructor(deps: ContextDependencies) {
    this.subject = deps.subject; this.memory = deps.memory; this.executions = deps.executions;
    this.schedules = deps.schedules; this.inbox = deps.inbox; this.session = deps.session;
    this.capabilities = deps.capabilities; this.boundaries = deps.boundaries; this.limits = deps.limits;
    this.todos = deps.todos; this.toolNames = deps.toolNames; this.moodNarration = deps.moodNarration;
  }
  build(trigger: unknown, previousAttemptError: string | undefined, now: number) {
    const cursor = this.session.cursor();
    const observations = this.inbox.read(cursor, this.limits.observations);
    const query = JSON.stringify(observations).slice(0, payloadBudget.recallQueryChars);
    const indexText = this.memory.indexText?.() ?? '';
    const moodText = this.moodNarration?.() ?? '';
    // 前缀缓存：subject 只放**不变**的东西（人格、方向）。
    // affect 每轮会被场景改，混进来会让后面所有稳定内容一起失效——实测命中率只有 37%。
    const self_state = this.subject.read(); void self_state.revision; void self_state.focus;
    return {
      subject: { id: self_state.id, identity: self_state.identity, direction: self_state.direction, tendencies: self_state.tendencies },
      capabilities: this.capabilities.catalog(this.toolNames ?? this.boundaries.allowedTools), boundaries: this.boundaries,
      goals: this.subject.goals(query, this.limits.goals),
      // 心境：一句话，不是数字。self 只读——它没看过那一轮对话，不该写这个。
      ...(moodText === '' ? {} : { mood: moodText }),
      // 索引优先：先给一份目录（我记得什么），细节留给 memory.expand。
      ...(indexText === '' ? {} : { memoryIndex: indexText }),
      memories: this.memory.recall(query, this.limits.memories),
      observations, recent: this.session.recentDecisions(this.limits.recentTurns),
      // 自己想做的事：只给开着的、最新的几条，避免清单一长就变成负担。
      ...(this.todos ? { todos: this.todos().slice(0, 5) } : {}),
      schedules: this.schedules.pending(this.limits.schedules), executions: this.executions.ongoing(this.limits.executions),
      // 会变的部分统一放这里：情绪、焦点、游标、本次唤醒的原因。
      state: { affect: self_state.affect, focus: self_state.focus, revision: self_state.revision,
        cursor, now, trigger, previousAttemptError } };
  }
}
