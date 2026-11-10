import test from 'node:test';
import assert from 'node:assert/strict';
import { appraiseTurn } from '../src/subject/appraisal.js';

const base = { text: '', reply: '', atBot: false, question: false };

test('群里跟我无关的闲聊不动情绪——那是别人的事', () => {
  const result = appraiseTurn({ ...base, text: '他们俩在聊择校', reply: '嗯' });
  assert.deepEqual(result.mood.deltas, {});
  assert.equal(result.rapport, undefined);
  assert.equal(result.reaction, undefined);
});

test('有人专门找我说话：兴趣和说话欲都上来', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '你怎么看', reply: '我觉得还行' });
  assert.equal(result.mood.deltas.interest, 2);
  assert.equal(result.mood.deltas.sociability, 2);
  assert.match(result.mood.reason, /专门找我/);
});

test('被夸：心情上来，关系也加分', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '你这话说得厉害', reply: '谢谢' });
  assert.equal(result.mood.deltas.valence, 2);
  assert.equal(result.rapport?.delta, 2);
  assert.equal(result.reaction?.label, '开心');
});

test('被怼：心情掉、压力涨、不想说话，关系减分', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '你是不是傻', reply: '……' });
  assert.equal(result.mood.deltas.valence, -3);
  assert.equal(result.mood.deltas.stress, 3);
  assert.equal(result.mood.deltas.sociability, -2);
  assert.equal(result.rapport?.delta, -2);
  assert.match(result.mood.reason, /被怼/);
});

test('被质疑但不算攻击：加压力，不动关系（多半只是观点不同）', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '你错了吧', reply: '我再看看' });
  assert.equal(result.mood.deltas.stress, 2);
  assert.equal(result.rapport, undefined, '质疑不该记成关系变差');
});

test('被问住（问题+回复很短）：加一点压力', () => {
  const result = appraiseTurn({ ...base, text: '那你说说原理', question: true, reply: '嗯' });
  assert.equal(result.mood.deltas.stress, 1);
  assert.match(result.mood.reason, /被问住/);
});

test('delta 永远有界，不会一次把情绪打穿', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '傻 蠢 垃圾 闭嘴 滚 废物 烂 烦死 有病 别烦', reply: 'x' });
  for (const value of Object.values(result.mood.deltas)) assert.ok(Math.abs(value as number) <= 15);
});

test('reason 不超过 80 字，能直接进提示词', () => {
  const result = appraiseTurn({ ...base, atBot: true, text: '被质疑又被怼'.repeat(20), reply: 'x' });
  assert.ok(result.mood.reason.length <= 80);
});
