import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneInstructions } from '../src/execution/scene.js';

/**
 * 群聊里的说话分寸。
 *
 * 之前的指令只说了「不接话也是一种回应」——给了沉默的许可，却没给说话的判据。
 * 结果模型面对「要不要说话」没有依据，只能选最安全的：永远不说。
 * 线上实测：20 条消息、24 次全选 wait，因为「没人点我」。
 */

test('有人点你 / 问你，就该接——这是最明确的判据', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  assert.match(text, /点你|叫你|问你|提到你/, '被点名这条要写清楚');
});

test('不该接的情况也要写清：别人互相聊、没你的事', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  // 线上 policy 的原话是「两人定向交流、刚答过同一件事、内容已经结束」。
  assert.match(text, /定向交流|别人在聊|互相聊|没你的事|插不上/, '不接的判据同样重要');
});

test('判断依据是「有没有真想法」，不是「有没有人叫你」', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  assert.match(text, /想法|有话说|想说什么/, '要让模型按内容判断，而不是等叫号');
});

test('不再有单向鼓励沉默的表述', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  assert.doesNotMatch(text, /不接话也是一种回应/, '这句话等于只给了闭嘴的许可');
});

test('也不能反过来变成每条都接', () => {
  const text = sceneInstructions(undefined, { type: 'group' });
  assert.match(text, /不必每条|不是每条|别每条|不用每条/, '另一个极端同样要防');
});
