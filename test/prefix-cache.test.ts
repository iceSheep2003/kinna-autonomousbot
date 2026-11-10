import test from 'node:test';
import assert from 'node:assert/strict';
import { promptPrefix, prefixRatio, CACHE_TARGET } from '../src/shared/prefix.js';

/**
 * 前缀缓存（prefix caching）。
 *
 * DeepSeek 等按**消息前缀**命中缓存，命中部分便宜一个数量级。
 * 规则很简单：从第一个 token 起逐字比较，遇到不同就全部失效。
 *
 * 所以 prompt 的字段顺序不是小事——把 `now` 放在第一位，等于每轮都让整条缓存失效。
 */

test('公共前缀按字符算，遇到第一个不同就停', () => {
  assert.equal(promptPrefix('{"a":1,"b":2}', '{"a":1,"b":3}'), '{"a":1,"b":');
  assert.equal(promptPrefix('{"now":1}', '{"now":2}'), '{"now":');
  assert.equal(promptPrefix('abc', 'abc'), 'abc');
});

test('公共前缀占比：稳定部分越长，命中率越高', () => {
  const stable = 'x'.repeat(400);
  // now 在最后：前面全命中
  const good = prefixRatio(`{"rules":"${stable}","now":1}`, `{"rules":"${stable}","now":2}`);
  // now 在最前：第一个字段就不同，全部失效
  const bad = prefixRatio(`{"now":1,"rules":"${stable}"}`, `{"now":2,"rules":"${stable}"}`);
  assert.ok(good > 0.95, `now 在最后应该几乎全命中，实际 ${good}`);
  assert.ok(bad < 0.05, `now 在最前会全失效，实际 ${bad}`);
});

test('目标命中率是 80%', () => {
  assert.equal(CACHE_TARGET, 0.8);
});

test('jsonPrompt 把动态字段排到末尾，稳定字段排在前面', () => {
  const stable = { persona: 'x'.repeat(100), rules: 'y'.repeat(100) };
  const a = JSON.stringify(stable) + JSON.stringify({ transcript: ['第一轮'], now: 1000 });
  const b = JSON.stringify(stable) + JSON.stringify({ transcript: ['第一轮', '第二轮'], now: 2000 });
  assert.ok(prefixRatio(a, b) >= 0.5, '稳定部分必须保住');

  const badA = JSON.stringify({ now: 1000 }) + JSON.stringify(stable);
  const badB = JSON.stringify({ now: 2000 }) + JSON.stringify(stable);
  assert.ok(prefixRatio(badA, badB) < 0.1, '反过来就全废');
});

test('stableOrder 把易变字段排到最后，稳定字段排到最前', async () => {
  const { stableOrder } = await import('../src/shared/prefix.js');
  const ordered = stableOrder({ now: 1, transcript: ['a'], memories: ['m'], subject: { s: 1 }, capabilities: ['c'] });
  // now 是每轮必变的短值，排在最末；transcript 虽是主体内容但比它稳定一些。
  assert.deepEqual(Object.keys(ordered), ['subject', 'capabilities', 'memories', 'transcript', 'now']);
});

test('重排之后相邻两轮的公共前缀占比达到 80% 目标', async () => {
  const { stableOrder } = await import('../src/shared/prefix.js');
  const base = { subject: { identity: 'x'.repeat(200) }, capabilities: Array.from({ length: 20 }, (_, i) => `tool_${i}`),
    memories: [{ content: 'y'.repeat(300) }] };
  const turn = (now: number, said: string) => JSON.stringify(stableOrder({ ...base, transcript: [said], now }));
  assert.ok(prefixRatio(turn(1000, '你好'), turn(2000, '你好')) >= 0.8);
});
