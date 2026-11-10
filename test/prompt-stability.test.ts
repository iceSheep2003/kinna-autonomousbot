import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleModel } from '../src/infrastructure/models/openai-compatible.js';
import { prefixRatio, CACHE_TARGET } from '../src/shared/prefix.js';
import { z } from 'zod';

/**
 * 真实调用层必须把易变字段排到末尾，否则前缀缓存全废。
 *
 * 这一层是唯一的出口：接在这里，所有 session（self/scene/execution/dream）都自动受益，
 * 不用每个构造器各自记得排序。
 */

function capture(): { model: OpenAICompatibleModel; bodies: string[] } {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ''));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) } as never;
  }) as never;
  const model = new OpenAICompatibleModel({ baseUrl: 'http://x', apiKey: 'k', model: 'm' });
  return { model, bodies };
}

const restore = () => { /* 每个测试自己恢复 */ };

test('now 在 context 第一位时，实际发出的 prompt 仍把它排到最后', async () => {
  const original = globalThis.fetch;
  const { model, bodies } = capture();
  const schema = z.object({ ok: z.boolean() });
  await model.decide({ role: 'scene', instructions: 'x'.repeat(300), schema,
    context: { now: 1000, subject: { identity: 'y'.repeat(200) }, transcript: ['你好'] } });
  globalThis.fetch = original;
  const body = JSON.parse(bodies[0]!);
  const user = body.messages[1].content as string;
  assert.ok(user.lastIndexOf('"now"') > user.indexOf('"subject"'), 'now 必须排在 subject 之后');
  assert.ok(user.lastIndexOf('"now"') > user.indexOf('"transcript"'), 'now 必须是最后一个');
});

test('相邻两轮的实际请求，公共前缀达到 80%', async () => {
  const original = globalThis.fetch;
  const { model, bodies } = capture();
  const schema = z.object({ ok: z.boolean() });
  const base = { subject: { identity: 'y'.repeat(400) },
    capabilities: Array.from({ length: 30 }, (_, i) => ({ name: `qq.tool_${i}`, effect: 'read' })),
    memories: [{ content: 'z'.repeat(400) }] };
  const request = (now: number, said: string) => model.decide({ role: 'scene', instructions: 'x'.repeat(600), schema,
    context: { now, ...base, transcript: [said] } });
  await request(1000, '你好');
  await request(2000, '你好');
  globalThis.fetch = original;
  const first = JSON.parse(bodies[0]!).messages[1].content as string;
  const second = JSON.parse(bodies[1]!).messages[1].content as string;
  const ratio = prefixRatio(first, second);
  assert.ok(ratio >= CACHE_TARGET, `实际命中率 ${(ratio * 100).toFixed(1)}%，低于目标 80%`);
  restore();
});
