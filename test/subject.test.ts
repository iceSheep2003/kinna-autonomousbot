import test from 'node:test';
import assert from 'node:assert/strict';
import { SubjectService } from '../src/subject/service.js';
import { GoalService } from '../src/subject/goals.js';
import { AffectService } from '../src/subject/affect.js';
import type { GoalRepository, SubjectRepository } from '../src/subject/ports.js';
import type { AffectState, Appraisal, Goal, GoalRevision, SelfState } from '../src/subject/types.js';

function subjectFixture() {
  let state: SelfState | undefined;
  const goals = new Map<string, Goal>(); const appraisals: Appraisal[] = []; const revisions: GoalRevision[] = [];
  const feelings = new Map<string, AffectState>();
  const repository: SubjectRepository = {
    read: () => state && structuredClone(state), save: next => { state = structuredClone(next); },
    recordAppraisal: (value, now) => { appraisals.push(structuredClone(value)); if (value.target) feelings.set(value.target, { ...value, updatedAt: now }); },
    affectFor: id => feelings.get(id),
  };
  const goalRepository: GoalRepository = {
    get: id => goals.get(id), save: goal => { goals.set(goal.id, structuredClone(goal)); },
    relevant: (_query, limit) => [...goals.values()].slice(0, limit), recordRevision: revision => { revisions.push(revision); },
  };
  const evidence = { assertExists: (refs: number[]) => { if (refs.some(ref => ref !== 1 && ref !== 2)) throw new Error('Unknown evidence'); } };
  const service = new SubjectService(repository, new GoalService(goalRepository, evidence), new AffectService(repository, evidence));
  return { service, goals, appraisals, revisions };
}
const goal = { id: 'learn', content: '了解迁徙规律', horizon: 'long' as const, status: 'active' as const, reason: '探索中发现兴趣', evidence: [1] };

test('主体不需要数据库、模型或会话便可初始化、形成方向和修订目标', () => {
  const f = subjectFixture();
  assert.equal(f.service.initialize('探索者', ['好奇'], 1), true);
  assert.equal(f.service.initialize('另一个身份', [], 2), false);
  const changes = f.service.apply({ direction: '理解自然', goals: [goal] }, 0, 3);
  assert.equal(f.service.read().identity, '探索者');
  assert.equal(f.service.read().direction, '理解自然');
  assert.equal(changes[0]?.next.revision, 1);
  assert.equal(f.revisions.length, 1);
  assert.throws(() => f.service.apply({ goals: [] }, 0, 4), /revision conflict/);
});

test('目标校验覆盖同批父目标、循环和缺失证据，校验失败前没有目标写入', () => {
  const f = subjectFixture();
  f.service.initialize('探索者', [], 0);
  assert.throws(() => f.service.apply({ goals: [{ ...goal, id: 'a', parentId: 'b' }, { ...goal, id: 'b', parentId: 'a' }] }, 0, 1), /cycle/);
  assert.equal(f.goals.size, 0);
  assert.throws(() => f.service.apply({ goals: [{ ...goal, evidence: [999] }] }, 0, 1), /Unknown evidence/);
  assert.equal(f.goals.size, 0);
  f.service.apply({ goals: [{ ...goal, id: 'child', parentId: 'parent' }, { ...goal, id: 'parent' }] }, 0, 1);
  assert.equal(f.goals.size, 2);
});

test('人物相关感受不覆盖整体 mood；新解释不会抹掉旧的感受与证据', () => {
  const f = subjectFixture(); f.service.initialize('探索者', [], 0);
  f.service.apply({ goals: [], affect: { target: 'person:a', valence: -0.3, arousal: 0.4, description: '有些失落', interpretation: '尚不确定对方为何没有回复', evidence: [1] } }, 0, 1);
  assert.equal(f.service.read().affect.valence, 0);
  f.service.apply({ goals: [], affect: { target: 'person:a', valence: 0.2, arousal: 0.3, description: '理解对方在忙', interpretation: '对方解释了未及时回复的原因', evidence: [2] } }, 1, 2);
  assert.equal(f.service.affect.read('person:a')?.valence, 0.2);
  assert.equal(f.appraisals.length, 2);
  assert.deepEqual(f.appraisals[0]?.evidence, [1]);
});
