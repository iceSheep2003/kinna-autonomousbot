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
export interface AgentOptions {
  identity: string; tendencies: string[]; boundaries: Boundaries; reflectionIntervalMs: number; dreamIntervalMs: number; contextLimits?: Partial<ContextLimits>;
}
export function composeAgent(repositories: Repositories, provider: LanguageModel, capabilities: CapabilityRegistry, options: AgentOptions) {
  const r = repositories;
  const limits = { ...defaultContextLimits, ...options.contextLimits };
  const experience = new ExperienceService(r.experience);
  const memory = new MemoryService(r.memory);
  const reflections = new ReflectionService(r.reflection, experience);
  const subject = new SubjectService(r.subject, new GoalService(r.goals, experience), new AffectService(r.subject, experience));
  let scenes: SceneSessions;
  const inbox = new Inbox(r.transaction, r.runtime, r.experience, r.jobs, () => r.selfSession.cursor(),
    id => r.execution.get(id)?.status === 'active', options.boundaries.maxPendingJobs,
    (scene, kind, data, now) => scenes.receive(scene, kind, data, now));
  const executions = new ExecutionService(r.execution, capabilities, options.boundaries, subject, {
    continue: (id, now) => { r.jobs.enqueue('execution', `execution:${id}`, { executionId: id }, now); },
    report: (executionId, status, result, now) => inbox.notify('execution.finished', { executionId, status, result }, now),
  }, experience);
  const scheduler = new Scheduler(r.schedules, {
    goalRevision: id => subject.requireActiveGoal(id)?.revision,
    stillValid: schedule => {
      if (!schedule.goalId) return true;
      const goal = subject.goal(schedule.goalId);
      return !!goal && goal.status === 'active' && goal.revision === schedule.goalRevision;
    },
    validate: action => {
      if (action.type === 'execute') capabilities.validate(action.tools, options.boundaries.allowedTools);
      if (action.type === 'tool') capabilities.validate([action.name], options.boundaries.allowedTools);
    },
    execute: (schedule, now) => {
      if (schedule.action.type === 'execute') executions.launch({ ...schedule.action, goalId: schedule.goalId }, now);
      if (schedule.action.type === 'tool') executions.act({ ...schedule.action, goalId: schedule.goalId }, now);
    },
  }, (kind, data, now) => inbox.notify(kind, data, now), () => r.jobs.count() < options.boundaries.maxPendingJobs);
  const worker = new Worker(r.transaction, r.runtime, r.jobs,
    now => { if (subject.initialize(options.identity, options.tendencies, now)) inbox.notify('initialized', { reason: 'You can explore; no assigned task.' }, now); },
    now => scheduler.fireDue(now), [
      { key: 'reflection', intervalMs: options.reflectionIntervalMs, fire: now => inbox.notify('reflection.due', { reason: 'Review interests, commitments, affect, and whether to act or rest.' }, now) },
      { key: 'dream', intervalMs: options.dreamIntervalMs, fire: now => { r.jobs.enqueue('dream', 'dream', {}, now); } },
    ], (data, now) => { experience.record('runtime', 'job.error', data, now); });
  const model = new BudgetedModel(provider, r.budget, options.boundaries.maxModelCallsPerHour, worker.clock);
  scenes = new SceneSessions(r.scenes, experience, subject, model, capabilities, {
    continue: (id, now) => { r.jobs.enqueue('scene', `scene:${id}`, { sessionId: id }, now); },
    reflect: (sessionId, trigger, summary, evidence, now) => inbox.notify('scene.reflection_requested', { sessionId, trigger, summary, evidence }, now),
  }, options.boundaries, limits);
  const self = new SelfSession(model, new SelfContextBuilder(subject, memory, executions, scheduler, inbox, r.selfSession, capabilities, options.boundaries, limits),
    r.selfSession, inbox, new DecisionCommitter(subject, executions, scheduler, reflections, r.jobs, options.boundaries.maxPendingJobs));
  const runner = new ExecutionRunner(r.execution, executions, model, capabilities, memory, experience, options.boundaries, limits);
  const dream = new DreamService(r.memory, experience, model, { completed: (dreamId, summary, proposals, now) => inbox.notify('dream.completed', { dreamId, summary, proposals }, now) }, limits);
  worker.register('self', { prepare: (job, now) => self.prepare(job.payload, job.error, now) });
  worker.register('scene', { prepare: (job, now) => scenes.prepare(job.id, String(job.payload.sessionId), now), failed: (job, error, now) => scenes.failed(String(job.payload.sessionId), error, now) });
  worker.register('execution', { prepare: (job, now) => runner.prepare(job.id, job.payload.executionId, now), failed: (job, error, now) => runner.failed(String(job.payload.executionId), error, now) });
  worker.register('dream', { prepare: (job, now) => dream.prepare(job.id, job.error, now), failed: (job, error, now) => inbox.notify('job.failed', { jobId: job.id, error }, now) });
  return {
    runtime: { start: (now?: number) => worker.start(now), tick: (now?: number) => worker.tick(now), stop: () => worker.stop(), ingest: (event: IncomingEvent, now?: number) => inbox.ingest(event, now) },
    // 暴露查询接口给 HTTP/内置工具；不把跨模块仓库交给插件。
    subject: subject as import('../subject/ports.js').SubjectView, memory, experience,
    capabilities: () => capabilities.catalog(options.boundaries.allowedTools),
  };
}
export type Agent = ReturnType<typeof composeAgent>;
