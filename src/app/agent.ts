import type { LanguageModel } from '../shared/model.js';
import { defaultContextLimits, type Boundaries, type ContextLimits } from '../shared/limits.js';
import type { Repositories } from './repositories.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { SubjectService } from '../subject/service.js';
import { GoalService } from '../subject/goals.js';
import { AffectService } from '../subject/affect.js';
import { ExperienceService } from '../memory/experience.js';
import { MemoryService } from '../memory/service.js';
import { ReflectionService } from '../memory/reflection.js';
import { DreamService } from '../memory/dream.js';
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
import type { DreamLock, ExperienceLog } from '../memory/ports.js';
export interface AgentOptions {
  identity: string; tendencies: string[]; boundaries: Boundaries;
  reflectionIntervalMs: number; dreamIntervalMs: number;
  dreamCheckIntervalMs?: number; dreamGate?: Partial<DreamGateConfig>;
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

/**
 * 门控替代了「到点就整合」的盲定时器。周期只负责问一句「现在该不该整合」，
 * 真正耗时的整合仍由 dream 作业执行；锁在作业结束时释放，崩溃靠超时回收。
 */
function wireGate(input: { repositories: Repositories; experience: ExperienceLog; options: AgentOptions }): GateWiring {
  const { repositories, experience, options } = input;
  const gate = new DreamGate({
    state: repositories.dreamState, experience, memory: repositories.memory,
    lock: options.dreamLock ?? localLock(),
    config: { ...defaultDreamGate, ...options.dreamGate, minHours: options.dreamGate?.minHours ?? options.dreamIntervalMs / HOUR },
  });
  let lastBlocked = '';
  /** 只在「触发」或「拦截原因变化」时记一条，避免每 10 分钟写一行噪音。 */
  const checkDream = (now: number): void => {
    const decision = gate.check(now);
    if (decision.fire) {
      experience.record('runtime', 'dream.gate', { snapshot: decision.snapshot }, now);
      repositories.jobs.enqueue('dream', 'dream', {}, now);
      lastBlocked = '';
      return;
    }
    if (decision.blockedBy === lastBlocked) return;
    experience.record('runtime', 'dream.gate.blocked', { blockedBy: decision.blockedBy, snapshot: decision.snapshot }, now);
    lastBlocked = decision.blockedBy;
  };
  return { gate, checkDream };
}
/** 装配只做依赖注入；每个模块拿到的都是自己的 port 或依赖对象。 */
export function composeAgent(repositories: Repositories, provider: LanguageModel, capabilities: CapabilityRegistry, options: AgentOptions) {
  const r = repositories;
  const limits = { ...defaultContextLimits, ...options.contextLimits };
  const { boundaries } = options;
  const experience = new ExperienceService(r.experience);
  const memory = new MemoryService(r.memory);
  const reflections = new ReflectionService(r.reflection, experience);
  const { gate, checkDream } = wireGate({ repositories: r, experience, options });
  const subject = new SubjectService(r.subject, new GoalService(r.goals, experience), new AffectService(r.subject, experience));
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
      if (subject.initialize(options.identity, options.tendencies, now)) inbox.notify('initialized', { reason: 'You can explore; no assigned task.' }, now);
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
    repository: r.scenes, experience, subject, model, capabilities, boundaries, limits,
    requests: {
      continue: (id, now) => { r.jobs.enqueue('scene', `scene:${id}`, { sessionId: id }, now); },
      reflect: (request, now) => inbox.notify('scene.reflection_requested', request, now),
    },
  });
  const self = new SelfSession({
    model, repository: r.selfSession, inbox,
    context: new SelfContextBuilder({ subject, memory, executions, schedules: scheduler, inbox, session: r.selfSession, capabilities, boundaries, limits }),
    committer: new DecisionCommitter({ subject, executions, scheduler, reflections, jobs: r.jobs, capacity: boundaries.maxPendingJobs }),
  });
  const runner = new ExecutionRunner({ repository: r.execution, service: executions, model, capabilities, memory, experience, boundaries, limits });
  const dream = new DreamService({
    repository: r.memory, experience, model, limits,
    feedback: {
      completed: (dreamId, summary, proposals, now) => {
        gate.markConsolidated(now);
        inbox.notify('dream.completed', { dreamId, summary, proposals }, now);
      },
    },
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
    capabilities: () => capabilities.catalog(boundaries.allowedTools),
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
