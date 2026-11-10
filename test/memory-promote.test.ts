import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPromotion, suggestPromotions } from '../src/memory/promote.js';
import type { Memory } from '../src/memory/types.js';

const NOW = 1_800_000_000_000;

function memory(overrides: Partial<Memory>): Memory {
  return { id: 'm1', content: '一条记忆', evidence: [1], kind: 'observation', revision: 1, ...overrides };
}

test('boundary 最该通用：边界/禁忌换个群也该遵守', () => {
  const [candidate] = suggestPromotions([memory({ id: 'b1', scope: 'group:A', factType: 'boundary', content: '不要提他离职的事' })]);
  assert.ok(candidate);
  assert.equal(candidate.from, 'group:A');
  assert.match(candidate.reason, /不分场合/);
});

test('有观点词的稳定偏好会被建议提升', () => {
  const candidates = suggestPromotions([
    memory({ id: 'p1', scope: 'group:A', factType: 'preference', content: '用户希望回答更有人味' }),
    memory({ id: 'p2', scope: 'group:A', factType: 'preference', content: '觉得这家店便宜耐用' }),
  ]);
  assert.equal(candidates.length, 2);
});

test('一次性的具体安排不提升——真实数据里「计划国庆休息 13 天」被标成了 preference', () => {
  const candidates = suggestPromotions([
    memory({ id: 'x1', scope: 'group:A', factType: 'preference', content: '玩家计划在国庆中秋休息13天来放松身体' }),
    memory({ id: 'x2', scope: 'group:A', factType: 'preference', content: '打算明天去一趟图书馆' }),
  ]);
  assert.deepEqual(candidates, [], '带计划/时间词的不该被当成稳定偏好');
});

test('提到「这个群」的不提升：那是场合专属的', () => {
  const candidates = suggestPromotions([memory({ scope: 'group:A', factType: 'preference', content: '认为这个群的氛围比较放松' })]);
  assert.deepEqual(candidates, []);
});

test('已经是 owner 的不再建议提升；bot 自有状态也不搬', () => {
  assert.deepEqual(suggestPromotions([memory({ scope: 'owner', factType: 'boundary', content: '不要提' })]), []);
  assert.deepEqual(suggestPromotions([memory({ scope: 'bot:self', factType: 'boundary', content: '不要提' })]), []);
});

test('提升是复制到 owner 并升版本，不删原记录——判断错了还能退回去', () => {
  const original = memory({ id: 'm1', scope: 'group:A', revision: 3, content: '用户希望回答更有人味' });
  const promoted = applyPromotion(original, NOW);
  assert.equal(promoted.scope, 'owner');
  assert.equal(promoted.revision, 4);
  assert.equal(promoted.updatedAt, NOW);
  assert.notEqual(promoted.id, original.id, '换 id，避免和原记录互相覆盖');
  assert.equal(original.scope, 'group:A', '原记录不动');
});

test('建议有上限，不会一次性吐出几百条让人审', () => {
  const many = Array.from({ length: 100 }, (_, index) => memory({
    id: `m${index}`, scope: 'group:A', factType: 'preference', content: `认为第 ${index} 个方案更好`,
  }));
  assert.equal(suggestPromotions(many, 5).length, 5);
});
