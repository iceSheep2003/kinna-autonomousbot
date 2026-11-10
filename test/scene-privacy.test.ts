import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneInstructions } from '../src/execution/scene.js';

/**
 * 同一个它在不同场合说话的分寸不一样。
 *
 * 私聊只有两个人，可以说更私人的事；群里是公开场合，
 * 不能把私聊里听到的事搬到台面上。
 */

test('私聊能说更私人的事，因为只有两个人', () => {
  const text = sceneInstructions(undefined, { type: 'private' });
  assert.match(text, /私聊/, '要说清这是私聊');
  assert.match(text, /更私人|私下/, '私聊可以聊得更开');
});

test('群聊是公开场合，不能把私聊内容搬出来', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  assert.match(text, /群/, '要说清这是群聊');
  assert.match(text, /私下|私聊/, '要明确禁止搬运私聊内容');
  assert.doesNotMatch(text, /只有你们两?个人/, '群聊不是两个人的场合');
});

test('私聊和群聊的指令确实不同——不是同一段话', () => {
  const priv = sceneInstructions(undefined, { type: 'private' });
  const group = sceneInstructions(undefined, { type: 'group' });
  assert.notEqual(priv, group);
});

test('不传场景时保持旧行为（不崩、也不是报错文案）', () => {
  const text = sceneInstructions(undefined);
  assert.ok(text.length > 100);
  assert.doesNotMatch(text, /undefined/);
});
