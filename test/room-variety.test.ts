import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoom, replyProbability, DEFAULT_ROOM } from '../src/execution/read-room.js';

/**
 * 读空气要有变化，不能是全确定的。
 *
 * 硬阈值的问题是：同样的场面永远得到同样的决定，几十次之后就显得机械。
 * 改成**概率**——分数越高越可能开口，但同一个分数也会有时说有时不说。
 *
 * 可调性不受影响：概率是分数的函数，`steepness` 控制曲线陡不陡，
 * 注入固定的 random 就能重放。
 */

const base = { text: '这个怎么弄？', atBot: false, atOthers: false, hasImage: false, isPrivate: false, now: 1_000_000, recent: [] as never[] };

test('分数越高，开口概率越大', () => {
  const low = replyProbability(-0.5, DEFAULT_ROOM);
  const mid = replyProbability(0, DEFAULT_ROOM);
  const high = replyProbability(1, DEFAULT_ROOM);
  assert.ok(low < mid && mid < high, `应单调递增：${low} < ${mid} < ${high}`);
});

test('分数等于阈值时是一半一半', () => {
  assert.ok(Math.abs(replyProbability(DEFAULT_ROOM.threshold, DEFAULT_ROOM) - 0.5) < 0.01);
});

test('同一个分数，换个随机数结果可以不同——这就是「多样」', () => {
  const always = readRoom({ ...base, random: () => 0.99 });
  const never = readRoom({ ...base, random: () => 0.01 });
  assert.notEqual(always.reply, never.reply, '同样的输入，随机源不同就该有可能不同');
});

test('注入固定随机源可复现——调参时需要这个', () => {
  const a = readRoom({ ...base, random: () => 0.42 });
  const b = readRoom({ ...base, random: () => 0.42 });
  assert.equal(a.reply, b.reply);
  assert.equal(a.score, b.score);
});

test('直接对话永远回，不受随机影响', () => {
  for (const random of [() => 0, () => 1]) {
    assert.equal(readRoom({ ...base, atBot: true, random }).reply, true);
  }
});

test('分数很低时，即使随机数很大也不开口', () => {
  const v = readRoom({ ...base, text: '哈哈', random: () => 0.99 });
  assert.equal(v.reply, false, '寒暄已经有 -0.6，不该因为运气好就冒话');
});

test('steepness 可调：越大越接近硬阈值', () => {
  const flat = { ...DEFAULT_ROOM, steepness: 1 };
  const sharp = { ...DEFAULT_ROOM, steepness: 20 };
  // 离开阈值 0.2 分：平缓的还在犹豫，陡峭的已经很确定
  assert.ok(replyProbability(0.7, flat) < replyProbability(0.7, sharp));
});

test('verdict 带上概率，方便调参时看', () => {
  const v = readRoom({ ...base, random: () => 0.5 });
  assert.ok(typeof v.probability === 'number');
  assert.ok(v.probability >= 0 && v.probability <= 1);
});

test('scene 的温度给到 1.0，让同一句话不总是同一个腔调', async () => {
  const { defaultProfiles } = await import('../src/infrastructure/models/profiles.js');
  assert.equal(defaultProfiles.scene.temperature, 1);
  assert.ok((defaultProfiles.scene.presencePenalty ?? 0) > 0, '靠 presencePenalty 压重复，不是靠降温');
});
