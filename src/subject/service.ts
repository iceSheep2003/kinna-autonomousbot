import type { SelfState, SubjectChange } from './types.js';
import type { SubjectRepository, SubjectView } from './ports.js';
import { GoalService } from './goals.js';
import { AffectService } from './affect.js';

/** 只管理主体，不知道会话、LLM、工具、执行作业或定时器。调用方提供事务边界。 */
export class SubjectService implements SubjectView {
  constructor(private readonly repository: SubjectRepository, readonly goalService: GoalService, readonly affect: AffectService) {}
  initialize(identity: string, tendencies: string[], now: number): boolean {
    if (this.repository.read()) return false;
    this.repository.save({ id: 'self', identity, tendencies, direction: '尚未形成方向；从倾向、环境和经验中探索。',
      affect: { valence: 0, arousal: 0.5, description: '初始中性状态', updatedAt: now }, revision: 0 });
    return true;
  }
  read(): SelfState {
    const state = this.repository.read(); if (!state) throw new Error('Subject not initialized'); return state;
  }
  goal(id: string) { return this.goalService.get(id); }
  goals(query: string, limit: number) { return this.goalService.recall(query, limit); }
  requireActiveGoal(id?: string) { return this.goalService.requireActive(id); }
  apply(change: SubjectChange, expectedRevision: number, now: number) {
    const current = this.read();
    if (current.revision !== expectedRevision) throw new Error('Self revision conflict');
    const revisions = this.goalService.revise(change.goals, now);
    let affect = current.affect;
    if (change.affect) {
      const next = this.affect.appraise(change.affect, now);
      if (!change.affect.target) affect = next;
    }
    this.repository.save({ ...current, direction: change.direction ?? current.direction, focus: change.focus ?? current.focus,
      affect, revision: current.revision + 1 });
    return revisions;
  }
}
