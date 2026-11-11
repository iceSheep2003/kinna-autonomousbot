import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defaultProfiles, profilesFromEnv, resolveProfile } from '../src/infrastructure/models/profiles.js';
import { OpenAICompatibleModel } from '../src/infrastructure/models/openai-compatible.js';

const schema = z.object({ result: z.string() });
const ROLES = ['self', 'dream', 'execution', 'scene'] as const;

/** 拦下 fetch，记录请求 body；返回合法 JSON 让 decide 走完。 */
function capture(): { bodies: any[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"result":"ok"}' } }] }), { status: 200 });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

test('默认档位：self/dream 开思考，execution/scene 关思考', () => {
  assert.equal(defaultProfiles.self.thinking, 'enabled');
  assert.equal(defaultProfiles.dream.thinking, 'enabled');
  assert.equal(defaultProfiles.execution.thinking, 'disabled');
  assert.equal(defaultProfiles.scene.thinking, 'disabled');
});

test('思考档不带温度参数；聊天档更松、更不容易复读套话', () => {
  assert.equal(defaultProfiles.self.temperature, undefined);
  assert.equal(defaultProfiles.self.presencePenalty, undefined);
  assert.ok(defaultProfiles.scene.temperature! > defaultProfiles.execution.temperature!);
  assert.ok(defaultProfiles.scene.presencePenalty! > defaultProfiles.execution.presencePenalty!);
});

test('输出与超时预算按场合分：dream 最重，scene 最轻', () => {
  assert.ok(defaultProfiles.dream.maxTokens > defaultProfiles.self.maxTokens);
  assert.ok(defaultProfiles.scene.maxTokens < defaultProfiles.execution.maxTokens);
  assert.ok(defaultProfiles.dream.timeoutMs > defaultProfiles.scene.timeoutMs);
  assert.equal(defaultProfiles.dream.reasoningEffort, 'high');
  assert.equal(defaultProfiles.self.reasoningEffort, 'low');
});

test('resolveProfile 优先级：默认 < 构造覆盖 < 单请求覆盖', () => {
  assert.equal(resolveProfile('scene', undefined, undefined).thinking, 'disabled');
  assert.equal(resolveProfile('scene', { scene: { temperature: 0.5 } }, undefined).temperature, 0.5);
  const single = resolveProfile('scene', { scene: { temperature: 0.5 } }, { temperature: 0.9, thinking: 'enabled' });
  assert.equal(single.temperature, 0.9);
  assert.equal(single.thinking, 'enabled');
  assert.equal(resolveProfile('self', undefined, undefined).reasoningEffort, 'low');
});

test('LLM_THINKING=off：全场合关思考、清掉思考专用字段、补上温度', () => {
  const overrides = profilesFromEnv({ LLM_THINKING: 'off' });
  for (const role of ROLES) {
    const p = resolveProfile(role, overrides, undefined);
    assert.equal(p.thinking, 'disabled', role);
    assert.equal(p.reasoningEffort, undefined, role);
    assert.equal(p.topP, undefined, role);
    assert.ok((p.temperature ?? 0) > 0, role);
  }
});

test('LLM_THINKING=on：全场合开思考、清掉只在非思考模式生效的字段', () => {
  const overrides = profilesFromEnv({ LLM_THINKING: 'on' });
  for (const role of ROLES) {
    const p = resolveProfile(role, overrides, undefined);
    assert.equal(p.thinking, 'enabled', role);
    assert.equal(p.temperature, undefined, role);
    assert.equal(p.presencePenalty, undefined, role);
    assert.ok(p.topP! >= 0.95 && p.topP! <= 1, role);
  }
});

test('未设置或非法 LLM_THINKING 时不产生覆盖', () => {
  assert.deepEqual(profilesFromEnv({}), {});
  assert.deepEqual(profilesFromEnv({ LLM_THINKING: 'maybe' }), {});
});

test('HTTP body：self 发 thinking/reasoning_effort/top_p，不发 temperature', async () => {
  const c = capture();
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' });
    await model.decide({ role: 'self', instructions: 'i', context: {}, schema });
    const body = c.bodies[0]!;
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.top_p, 0.95);
    assert.equal(body.temperature, undefined);
    assert.equal(body.presence_penalty, undefined);
    assert.equal(body.max_tokens, defaultProfiles.self.maxTokens);
  } finally { c.restore(); }
});

test('HTTP body：scene 关思考、带温度与 presence_penalty，不发 top_p', async () => {
  const c = capture();
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' });
    await model.decide({ role: 'scene', instructions: 'i', context: {}, schema });
    const body = c.bodies[0]!;
    assert.deepEqual(body.thinking, { type: 'disabled' });
    // 跟随配置而不是写死数值：调温度不该让这条测试变红。
    assert.equal(body.temperature, defaultProfiles.scene.temperature);
    assert.equal(body.presence_penalty, 0.4);
    assert.equal(body.top_p, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.max_tokens, defaultProfiles.scene.maxTokens);
  } finally { c.restore(); }
});

test('单请求 sampling 可临时改写档位；截断报错显示实际 max_tokens', async () => {
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' });
    await assert.rejects(
      model.decide({ role: 'execution', instructions: 'i', context: {}, schema, sampling: { thinking: 'enabled', maxTokens: 4321 } }),
      /max_tokens=4321/,
    );
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.max_tokens, 4321);
    assert.equal(body.temperature, undefined);
  } finally { globalThis.fetch = original; }
});

test('构造时按场合覆盖生效，不必改调用点', async () => {
  const c = capture();
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm',
      profiles: { scene: { temperature: 0.42, maxTokens: 777 } } });
    await model.decide({ role: 'scene', instructions: 'i', context: {}, schema });
    assert.equal(c.bodies[0]!.temperature, 0.42);
    assert.equal(c.bodies[0]!.max_tokens, 777);
    assert.equal(c.bodies[0]!.presence_penalty, 0.4);
  } finally { c.restore(); }
});
