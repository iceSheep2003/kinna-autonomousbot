import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOpportunities, inlinesMaterial, materialText } from '../src/memory/opportunity.js';
import type { Experience, Opportunity } from '../src/memory/types.js';

function entry(seq: number, kind: string, data: unknown = {}, source = 'world'): Experience {
  return { seq, at: 0, source, kind, data };
}
function opp(id: string, overrides: Partial<Opportunity> = {}): Opportunity {
  return { id, kind: 'follow_up', about: '小林', why: '答应过帮他看看复习节奏', urgency: 'when_idle', evidence: [1], ...overrides };
}
const batch = [entry(1, 'group.message', { name: '小林', text: '复习节奏有点乱，算了先不问了' })];

test('一条像样的机会会被放行', () => {
  const result = filterOpportunities({ candidates: [opp('o1')], evidence: new Set([1]), material: batch });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test('证据指不到本批素材的机会被挡：凭空编的事不投递', () => {
  const result = filterOpportunities({ candidates: [opp('o1', { evidence: [99] })], evidence: new Set([1]), material: batch });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'evidence outside batch');
});

test('机会描述里整句搬了原文，就等于替 self 把话说了，挡掉', () => {
  const result = filterOpportunities({
    candidates: [opp('o1', { why: '小林说复习节奏有点乱，算了先不问了' })],
    evidence: new Set([1]), material: batch,
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'inlines material');
});

test('批内重复的机会只留更急的那条', () => {
  const result = filterOpportunities({
    candidates: [opp('o1', { urgency: 'when_idle' }), opp('o2', { urgency: 'now' })],
    evidence: new Set([1]), material: batch,
  });
  // 更急的替换掉先到的那条；被替换的那条不算「被拒绝」，它只是被更急的说法取代了。
  assert.deepEqual(result.accepted.map(item => item.id), ['o2']);
  assert.equal(result.rejected.length, 0);
});

test('同一批里同一个人的两条相近机会只保留更急的一条', () => {
  const result = filterOpportunities({
    candidates: [opp('o1', { why: '答应过帮他看看复习节奏的事' }), opp('o2', { why: '答应过帮他看看复习节奏的事', urgency: 'now' })],
    evidence: new Set([1]), material: batch,
  });
  assert.deepEqual(result.accepted.map(item => item.id), ['o2']);
});

test('跨批次去重：上一夜已经报过、这一夜一字不差又来一遍的机会不投递', () => {
  const result = filterOpportunities({
    candidates: [opp('o1')], evidence: new Set([1]), material: batch,
    recent: ['小林\n答应过帮他看看复习节奏'],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'duplicate');
});

test('放行后按紧急程度排序，且最多 6 条', () => {
  const many = Array.from({ length: 8 }, (_, index) => opp(`o${index}`, {
    about: `人${index}`, why: `不同的事 ${index}`, urgency: index % 2 ? 'when_idle' : 'now',
  }));
  const result = filterOpportunities({ candidates: many, evidence: new Set([1]), material: batch });
  assert.equal(result.accepted.length, 6);
  assert.equal(result.accepted[0]?.urgency, 'now');
});

test('schema 不合格的机会被挡，而不是让整次整合失败', () => {
  const result = filterOpportunities({ candidates: [{ id: 'bad' }], evidence: new Set([1]), material: batch });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'schema');
});

test('内联检测能穿透嵌套结构取到原文，但不会把短词当原文', () => {
  const nested = entry(2, 'group.message', { payload: { lines: [{ text: '这是完整的一句原话，长度够长' }] } });
  // 14 个字符（含全角逗号），超过 INLINE_MIN_CHARS，算「完整一句」。
  assert.ok(materialText(nested).some(text => text.includes('这是完整的一句原话')));
  assert.equal(inlinesMaterial('继续原话：这是完整的一句原话，长度够长', [nested]), true);
  // 名字短于 INLINE_MIN_CHARS，不会被当成「搬原文」。
  assert.equal(materialText(entry(3, 'x', { name: '小林' })).length, 0);
  assert.equal(inlinesMaterial('小林', [entry(3, 'x', { name: '小林' })]), false);
});
