import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPersonality, personaText, SOCIAL_LINES, TONE_LABEL } from '../src/shared/persona.js';
import { selfInstructions } from '../src/self/session.js';
import { sceneInstructions } from '../src/execution/scene.js';
import { executionInstructions } from '../src/execution/runner.js';
import { DREAM_INSTRUCTIONS } from '../src/memory/dream.js';
import { ConfigSchema } from '../src/app/config.js';

test('人格只有一份：self 与 scene 引用完全相同的那一段', () => {
  const shared = personaText(defaultPersonality);
  assert.ok(shared.length > 0);
  assert.ok(selfInstructions(defaultPersonality).includes(shared));
  assert.ok(sceneInstructions(defaultPersonality).includes(shared));
});

test('四种场合开头都强调「还是你」，不重新定义身份或角色', () => {
  const texts = [selfInstructions(defaultPersonality), sceneInstructions(defaultPersonality), executionInstructions(), DREAM_INSTRUCTIONS];
  for (const text of texts) {
    assert.match(text, /还是你，同一个人/);
    assert.doesNotMatch(text, /你是[^。]{0,20}(角色|另一个|独立的)/);
  }
});

test('personal 倾向按场合有强弱：execution 零偏好，dream 不带脾气', () => {
  assert.equal(personaText(undefined), '');
  assert.equal(executionInstructions().includes('我这个人有自己的脾气'), false);
  assert.equal(DREAM_INSTRUCTIONS.includes('我这个人有自己的脾气'), false);
  assert.match(executionInstructions(), /不发挥个人偏好/);
  assert.ok(sceneInstructions(defaultPersonality).includes('我这个人有自己的脾气'));
  assert.ok(selfInstructions(defaultPersonality).includes('我这个人有自己的脾气'));
});

test('关掉 personal 倾向只去掉偏好段落，相处底线仍完整保留', () => {
  const off = sceneInstructions(undefined);
  const on = sceneInstructions(defaultPersonality);
  assert.ok(on.length > off.length);
  assert.equal(off.includes('我这个人有自己的脾气'), false);
  assert.ok(off.includes(SOCIAL_LINES));
  assert.ok(on.includes(SOCIAL_LINES));
  assert.match(off, /还是你，同一个人/);
});

test('为人处事的红线落到了共享分寸里', () => {
  for (const phrase of ['先接住人', '可能', '不能当「一定」', '缓一缓', '不替谁做决定', '不操控', '求助渠道', '群发套话']) {
    assert.ok(SOCIAL_LINES.includes(phrase), phrase);
  }
  assert.match(DREAM_INSTRUCTIONS, /别替谁解读心思/);
  assert.match(DREAM_INSTRUCTIONS, /哪两件事/);
});

test('人格可覆盖，三种基调都有对应说明', () => {
  const custom = { ...defaultPersonality, tone: 'gentle' as const, temper: '话不多，但记人的好' };
  const text = personaText(custom);
  assert.match(text, /话不多，但记人的好/);
  assert.ok(text.includes(TONE_LABEL.gentle));
  assert.ok(TONE_LABEL.steady.length > 0 && TONE_LABEL.boundary.length > 0);
  assert.match(text, /不能因为偏爱谁就把没发生的事记成发生过/);
});

test('ConfigSchema：默认开 personal，关掉只关偏好不动人格数据', () => {
  const defaults = ConfigSchema.parse({});
  assert.equal(defaults.personal, true);
  assert.deepEqual(defaults.personality, defaultPersonality);
  const off = ConfigSchema.parse({ personal: false });
  assert.equal(off.personal, false);
  assert.deepEqual(off.personality, defaultPersonality);
});
