import { SelfSession } from '../self/session.js';
import { SelfContextBuilder } from '../self/context.js';
import { DecisionCommitter } from './decision-committer.js';
import { allowFor } from '../capabilities/scenarios.js';
import type { MemoryService } from '../memory/service.js';
import type { ExperienceService } from '../memory/experience.js';
import type { ReflectionService } from '../memory/reflection.js';
import type { SubjectService } from '../subject/service.js';
import type { ExecutionService } from '../execution/service.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type { Inbox } from '../runtime/inbox.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { LanguageModel } from '../shared/model.js';
import type { Boundaries, ContextLimits } from '../shared/limits.js';
import type { Personality } from '../shared/persona.js';
import type { MoodSystem } from '../subject/mood-system.js';
import type { Repositories } from './repositories.js';
import type { DreamReport } from '../memory/ports.js';
import type { DreamGate } from '../memory/dream-gate.js';
import type { Inbox as InboxType } from '../runtime/inbox.js';

export function reportDream(report: DreamReport, gate: DreamGate, inbox: InboxType): void {
  gate.markConsolidated(report.now);
  if (report.opportunities.length) inbox.notify('dream.opportunity', { dreamId: report.id, opportunities: report.opportunities }, report.now);
  inbox.notify('dream.completed', { dreamId: report.id, summary: report.summary, proposals: report.proposals, opportunities: report.opportunities.length }, report.now);
}

/** 社交圈 + 心情：能不能主动开口由心情决定，不由装配层传。 */
export function socialOf(
  source: (() => { groups: { id: string; name?: string }[]; privateAllowed: string[] }) | undefined,
  mood: MoodSystem,
): () => { groups: { id: string; name?: string }[]; privateAllowed: string[]; proactivePermitted: boolean } {
  const base = source?.() ?? { groups: [], privateAllowed: [] };
  return () => ({ ...base, proactivePermitted: mood.permitsProactive() });
}

/**
 * 装配 self 会话：上下文、提交器、唯一人格。
 *
 * 单独成函数是因为这段参数很长，而 composeAgent 已经承担了「把所有模块接起来」的职责，
 * 再塞细节就看不出主干。
 */
export function wireSelf(input: {
  repositories: Repositories; model: LanguageModel; memory: MemoryService; experience: ExperienceService;
  subject: SubjectService; executions: ExecutionService; scheduler: Scheduler; inbox: Inbox;
  capabilities: CapabilityRegistry; boundaries: Boundaries; limits: ContextLimits;
  personality?: Personality; mood: MoodSystem; reflections: ReflectionService;
  todos?: () => import('../self/todos.js').SelfTodo[];
  people?: () => string;
  social?: () => { groups: { id: string; name?: string }[]; privateAllowed: string[]; proactivePermitted: boolean };
  contacts?: () => { id: string; target: { type: string; id: string }; because: string; what: string }[];
}): SelfSession {
  return new SelfSession({
    model: input.model, repository: input.repositories.selfSession, inbox: input.inbox, personality: input.personality,
    context: new SelfContextBuilder({ subject: input.subject, memory: input.memory, executions: input.executions,
      schedules: input.scheduler, inbox: input.inbox, session: input.repositories.selfSession,
      capabilities: input.capabilities, boundaries: input.boundaries, limits: input.limits,
      // 心情由场景写、self 只读：它没见过那一轮对话，不该自己编。
      moodNarration: () => input.mood.narration(),
      ...(input.people ? { people: input.people } : {}),
      ...(input.social ? { social: input.social } : {}),
      ...(input.contacts ? { contacts: input.contacts } : {}),
      ...(input.todos ? { todos: input.todos } : {}),
      toolNames: allowFor('self', input.boundaries.allowedTools) }),
    committer: new DecisionCommitter({ subject: input.subject, executions: input.executions, scheduler: input.scheduler,
      reflections: input.reflections, jobs: input.repositories.jobs, capacity: input.boundaries.maxPendingJobs }),
  });
}

/** self 的额外注入：待办、认识的人、社交圈。都不改变主干，只是多给点上下文。 */
export function selfExtras(
  options: { todos?: () => import('../self/todos.js').SelfTodo[]; people?: { roster?(limit: number): string };
    social?: () => { groups: { id: string; name?: string }[]; privateAllowed: string[] };
    contacts?: () => { id: string; target: { type: string; id: string }; because: string; what: string }[] },
  mood: MoodSystem,
) {
  return {
    ...(options.todos ? { todos: options.todos } : {}),
    ...(options.people?.roster !== undefined ? { people: () => options.people?.roster?.(5) ?? '' } : {}),
    social: socialOf(options.social, mood),
    ...(options.contacts ? { contacts: options.contacts } : {}),
  };
}
