import { randomUUID } from 'node:crypto';
import type { Boundaries } from '../shared/limits.js';
import type { CapabilityAccess } from '../capabilities/ports.js';
import type { ExperienceLog } from '../memory/ports.js';
import type { ExecutionRepository, ExecutionRequests, ExecutionView, GoalAuthority } from './ports.js';
import { IntentSchema, DirectActionSchema, type DirectAction, type Execution, type Intent } from './types.js';

export interface ExecutionDependencies {
  repository: ExecutionRepository;
  capabilities: CapabilityAccess;
  boundaries: Boundaries;
  authority: GoalAuthority;
  requests: ExecutionRequests;
  experience: ExperienceLog;
}

export class ExecutionService implements ExecutionView {
  private readonly repository: ExecutionRepository;
  private readonly capabilities: CapabilityAccess;
  private readonly boundaries: Boundaries;
  private readonly authority: GoalAuthority;
  private readonly requests: ExecutionRequests;
  private readonly experience: ExperienceLog;
  constructor(deps: ExecutionDependencies) {
    this.repository = deps.repository; this.capabilities = deps.capabilities; this.boundaries = deps.boundaries;
    this.authority = deps.authority; this.requests = deps.requests; this.experience = deps.experience;
  }
  launch(raw: Intent, now: number): string {
    const intent = IntentSchema.parse(raw);
    this.authority.requireActiveGoal(intent.goalId);
    this.capabilities.validate(intent.tools, this.boundaries.allowedTools);
    const id = randomUUID();
    this.repository.save({ id, ...intent, status: 'active', steps: 0, progress: 'Not started' });
    this.experience.record(`execution:${id}`, 'execution.started', intent, now);
    this.requests.continue(id, now);
    return id;
  }
  act(raw: DirectAction, now: number): string {
    const action = DirectActionSchema.parse(raw);
    this.authority.requireActiveGoal(action.goalId);
    this.capabilities.validate([action.name], this.boundaries.allowedTools);
    const id = randomUUID();
    this.repository.save({ id, intent: action.reason, goalId: action.goalId, tools: [action.name], directAction: action,
      status: 'active', steps: 0, progress: 'Direct tool action pending' });
    this.requests.continue(id, now);
    return id;
  }
  acceptsEvents(id: string): boolean { return this.repository.get(id)?.status === 'active'; }
  ongoing(limit: number) { return this.repository.ongoing(limit); }
  pause(id: string, reason: string, now: number): void {
    const current = this.repository.get(id);
    if (!current) throw new Error(`Unknown execution: ${id}`);
    if (current.status !== 'active') return;
    this.repository.save({ ...current, status: 'paused', result: reason });
    this.experience.record(`execution:${id}`, 'execution.paused', { reason }, now);
  }
  invalidateGoal(goalId: string, now: number): void {
    for (const execution of this.repository.activeForGoal(goalId)) this.pause(execution.id, 'Goal revision changed; awaiting self reconsideration', now);
  }
  finish(id: string, status: Execution['status'], result: string, now: number): void {
    const current = this.repository.get(id);
    if (!current) throw new Error(`Unknown execution: ${id}`);
    this.repository.save({ ...current, status, result });
    this.experience.record(`execution:${id}`, 'execution.finished', { status, result }, now);
    this.requests.report(id, status, result, now);
  }
  continue(execution: Execution, progress: string, tool: { operationId: string; name: string; result: unknown }, now: number): void {
    this.repository.save({ ...execution, progress, steps: execution.steps + 1 });
    this.experience.record(`execution:${execution.id}`, 'tool.result', tool, now);
    this.requests.continue(execution.id, now);
  }
}
