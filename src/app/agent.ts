import type { LanguageModel } from '../shared/model.js';
import { defaultPersonality, type Personality } from '../shared/persona.js';
import { defaultContextLimits, type Boundaries, type ContextLimits } from '../shared/limits.js';
import type { Repositories } from './repositories.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { allowFor } from '../capabilities/scenarios.js';
import { ModelSceneCompactor } from '../execution/scene-compactor.js';
import { SubjectService } from '../subject/service.js';
import { MoodSystem } from '../subject/mood-system.js';
import { defaultAffectConfig } from '../subject/mood-system.js';
import { createSceneAffect } from './scene-affect.js';
import { reportDream, selfExtras, wireSelf } from './wire-self.js';
import { GoalService } from '../subject/goals.js';
import { AffectService } from '../subject/affect.js';
import { ExperienceService } from '../memory/experience.js';
import { MemoryService } from '../memory/service.js';
import { ReflectionService } from '../memory/reflection.js';
import { wireDream } from './memory-wiring.js';
import { DreamGate, defaultDreamGate, HOUR, type DreamGateConfig } from '../memory/dream-gate.js';
import { ExecutionService } from '../execution/service.js';
import { ExecutionRunner } from '../execution/runner.js';
import { SceneSessions } from '../execution/scene.js';
import { SelfContextBuilder } from '../self/context.js';
import { SelfSession } from '../self/session.js';
import { Inbox } from '../runtime/inbox.js';
import { Scheduler } from '../runtime/scheduler.js';
import { Worker } from '../runtime/worker.js';
import { BudgetedModel } from '../runtime/budget.js';
import { DecisionCommitter } from './decision-committer.js';
import type { IncomingEvent } from '../runtime/types.js';
import type { SchedulePolicy } from '../runtime/ports.js';
import type { DreamLock, DreamReport, ExperienceLog } from '../memory/ports.js';
export interface AgentOptions {
  identity: string; tendencies: string[]; boundaries: Boundaries;
  /** 关掉 personal 倾向（A/B 对照用）；身份唯一、相处底线不变。 */
  personal?: boolean;
  /** 唯一一份人格定义；不传用默认。 */
  personality?: Personality;
  reflectionIntervalMs: number; dreamIntervalMs: number;
  dreamCheckIntervalMs?: number; dreamGate?: Partial<DreamGateConfig>;
  dreamOpportunities?: boolean; // 翻出的机会是否交给 self（不传为开启；对照/回滚时关掉）
  todos?: () => import('../self/todos.js').SelfTodo[]; // 自己想做的事，注入 self 上下文
  /** 人物视图：观察消息里的人 + 渲染认识的几位。 */
  people?: import('../execution/scene.js').PeopleView;
  /** 能主动联系的对象。合不合适开口由心情决定，不在这里传。 */
  social?: () => { groups: { id: string; name?: string }[]; privateAllowed: string[] };
  /** 情绪配置覆盖；不传用默认（启用、半衰期 180 分钟）。 */
  affect?: Partial<import('../subject/mood-system.js').AffectConfig>;
  /** 人物仓储（写画像用）；不提供就不写画像。 */
  peopleStore?: { get(userId: string): import('../memory/person.js').Person | undefined; save(person: import('../memory/person.js').Person): void };
  /** 跨进程互斥由调用方注入；不传则只在进程内互斥。 */
  dreamLock?: DreamLock;
  contextLimits?: Partial<ContextLimits>;
}

/** 默认锁只在进程内互斥；跨进程由基础设施层的文件锁提供。 */
function localLock(): DreamLock {
  let held = false;
  return {
    acquire() { if (held) return false; held = true; return true; },
    release() { held = false; },
    held() { return held; },
  };
}

interface GateWiring { gate: DreamGate; checkDream: (now: number) => void }

/** 门控替代「到点就整合」：周期只问「现在该不该整合」，整合仍由 dream 作业执行。 */
function wireGate(input: { repositories: Repositories; experience: ExperienceLog; options: AgentOptions }): GateWiring {
  const { repositories, experience, options } = input;
  const gate = new DreamGate({
    state: repositories.dreamState, experience, memory: repositories.memory,
    lock: options.dreamLock ?? localLock(),
    config: { ...defaultDreamGate, ...options.dreamGate, minHours: options.dreamGate?.minHours ?? options.dreamIntervalMs / HOUR },
  });
  let lastBlocked = '';
  const checkDream = (now: number): void => {
    const decision = gate.check(now);
    if (decision.fire) {
      experience.record('runtime', 'dream.gate', { snapshot: decision.snapshot }, now);
      repositories.jobs.enqueue('dream', 'dream', {}, now);
      lastBlocked = '';
      return;
    }
    if (decision.blockedBy === lastBlocked) return; // 只在触发或原因变化时记一条，别刷屏
    experience.record('runtime', 'dream.gate.blocked', { blockedBy: decision.blockedBy, snapshot: decision.snapshot }, now);
    lastBlocked = decision.blockedBy;
  };
  return { gate, checkDream };
}
/** 整合完成：机会单独成一条通知（self 醒来看的是「有事可做」），再报整合本身。 */

export function composeAgent(repositories: Repositories, provider: LanguageModel, capabilities: CapabilityRegistry, options: AgentOptions) {
  const r = repositories;
  const limits = { ...defaultContextLimits, ...options.contextLimits };
  const { boundaries } = options;
  // 一个人格，多个场合：self 和 scene 拿同一份；execution / dream 不发挥偏好。
  const personality = options.personal === false ? undefined : options.personality ?? defaultPersonality;
  const experience = new ExperienceService(r.experience);
  // 提升也记进同一条流水，事后能追「这条通用记忆是哪次、凭什么提上来的」。
  const memory = new MemoryService(r.memory, {}, experience);
  const reflections = new ReflectionService(r.reflection, experience);
  const { gate, checkDream } = wireGate({ repositories: r, experience, options });
  const subject = new SubjectService(r.subject, new GoalService(r.goals, experience), new AffectService(r.subject, experience));
  // 情绪与好感度：状态机在 subject 层，由**场景**写（它见过那一轮），self 只读。
  const mood = new MoodSystem({ config: { ...defaultAffectConfig, ...(options.affect ?? {}) }, store: r.affect, clock: () => Date.now() });
  const sceneAffect = createSceneAffect({ mood, memory });
  let scenes: SceneSessions;
  const inbox = new Inbox({
    transaction: r.transaction, runtime: r.runtime, experience: r.experience, jobs: r.jobs, capacity: boundaries.maxPendingJobs,
    selfCursor: () => r.selfSession.cursor(),
    acceptsExecution: id => r.execution.get(id)?.status === 'active',
    receiveSession: (scene, kind, data, now) => scenes.receive(scene, kind, data, now),
  });
  const executions = new ExecutionService({
    repository: r.execution, capabilities, boundaries, authority: subject, experience,
    requests: {
      continue: (id, now) => { r.jobs.enqueue('execution', `execution:${id}`, { executionId: id }, now); },
      report: (executionId, status, result, now) => inbox.notify('execution.finished', { executionId, status, result }, now),
    },
  });
  const scheduler = new Scheduler(r.schedules, schedulePolicy({ subject, executions, capabilities, boundaries }),
    (kind, data, now) => inbox.notify(kind, data, now), () => r.jobs.count() < boundaries.maxPendingJobs);
  const worker = new Worker({
    transaction: r.transaction, repository: r.runtime, jobs: r.jobs,
    initialize: now => {
      if (subject.initialize(options.identity, options.tendencies, now)) {
        inbox.notify('initialized', { reason: '你刚来到这个群，还不认识谁。先看看最近大家都在聊什么；有想说的就说，没想说的也不用勉强。' }, now);
      }
    },
    due: now => scheduler.fireDue(now),
    periodic: [
      { key: 'reflection', intervalMs: options.reflectionIntervalMs, fire: now => inbox.notify('reflection.due', { reason: 'Review interests, commitments, affect, and whether to act or rest.' }, now) },
      { key: 'dream-check', intervalMs: options.dreamCheckIntervalMs ?? 600_000, fire: checkDream },
    ],
    reportError: (data, now) => { experience.record('runtime', 'job.error', data, now); },
  });
  const model = new BudgetedModel(provider, r.budget, boundaries.maxModelCallsPerHour, worker.clock);
  scenes = new SceneSessions({
    repository: r.scenes, experience, subject, model, capabilities, boundaries, limits, personality,
    // 场景记忆：owner + 本群（或本环境），别的群读不到。
    memory,
    // 旧对话压缩：攒够一批就压成现场状态，否则窗口外的消息直接丢。
    compactor: new ModelSceneCompactor(model),
    // 人物：消息流过时顺手认人，注入时给认识的几张卡片。
    ...(options.people ? { people: options.people } : {}),
    // 情绪：场景在回复后写（规则算，不调模型），self 只读来决定要不要主动开口。
    affect: sceneAffect,
    requests: {
      continue: (id, now) => { r.jobs.enqueue('scene', `scene:${id}`, { sessionId: id }, now); },
      reflect: (request, now) => inbox.notify('scene.reflection_requested', request, now),
    },
  });
  const self = wireSelf({ repositories: r, model, memory, experience, subject, executions, scheduler, inbox,
    capabilities, boundaries, limits, personality, mood, reflections, ...selfExtras(options, mood) });
  const runner = new ExecutionRunner({ repository: r.execution, service: executions, model, capabilities, memory, experience, boundaries, limits });
  const dream = wireDream({
    repositories: r, experience, model, limits, opportunities: options.dreamOpportunities,
    ...(options.peopleStore ? { people: options.peopleStore } : {}),
    feedback: { completed: report => reportDream(report, gate, inbox) },
  });
  worker.register('self', { prepare: (job, now) => self.prepare(job.payload, job.error, now) });
  worker.register('scene', { prepare: (job, now) => scenes.prepare(job.id, String(job.payload.sessionId), now), failed: (job, error, now) => scenes.failed(String(job.payload.sessionId), error, now) });
  worker.register('execution', { prepare: (job, now) => runner.prepare(job.id, job.payload.executionId, now), failed: (job, error, now) => runner.failed(String(job.payload.executionId), error, now) });
  worker.register('dream', {
    // 锁覆盖「读经验 + 调模型」这段真正耗时的部分；提交是瞬时的，不必占用锁。
    prepare: async (job, now) => {
      if (!gate.tryLock()) return () => {};
      try { return await dream.prepare(job.id, job.error, now); }
      finally { gate.releaseDream(); }
    },
    failed: (job, error, now) => inbox.notify('job.failed', { jobId: job.id, error }, now),
  });
  return {
    runtime: { start: (now?: number) => worker.start(now), tick: (now?: number) => worker.tick(now), stop: () => worker.stop(), ingest: (event: IncomingEvent, now?: number) => inbox.ingest(event, now) },
    // 暴露查询接口给 HTTP/内置工具；不把跨模块仓库交给插件。
    subject: subject as import('../subject/ports.js').SubjectView, memory, experience,
    // 对外暴露的是「自己待着」这个场景的工具，不是全量注册表。
    capabilities: () => capabilities.catalog(allowFor('self', boundaries.allowedTools)),
  };
}
export type Agent = ReturnType<typeof composeAgent>;

interface ScheduleWiring {
  subject: SubjectService; executions: ExecutionService; capabilities: CapabilityRegistry; boundaries: Boundaries;
}
/** 调度器只问“还该不该发生”；目标版本和启动执行由应用层回答。 */
function schedulePolicy(wiring: ScheduleWiring): SchedulePolicy {
  const { subject, executions, capabilities, boundaries } = wiring;
  return {
    goalRevision: id => subject.requireActiveGoal(id)?.revision,
    stillValid: schedule => {
      if (!schedule.goalId) return true;
      const goal = subject.goal(schedule.goalId);
      return !!goal && goal.status === 'active' && goal.revision === schedule.goalRevision;
    },
    validate: action => {
      if (action.type === 'execute') capabilities.validate(action.tools, boundaries.allowedTools);
      if (action.type === 'tool') capabilities.validate([action.name], boundaries.allowedTools);
    },
    execute: (schedule, now) => {
      if (schedule.action.type === 'execute') executions.launch({ ...schedule.action, goalId: schedule.goalId }, now);
      if (schedule.action.type === 'tool') executions.act({ ...schedule.action, goalId: schedule.goalId }, now);
    },
  };
}
