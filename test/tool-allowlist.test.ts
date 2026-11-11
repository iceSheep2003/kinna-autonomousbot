import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigSchema } from '../src/app/config.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';

/**
 * 接上 QQ 之后，模型必须有发消息的工具。
 *
 * 线上「@ 了不回复」的根因不是概率，是**白名单里一个 qq 工具都没有**——
 * 场景的 capabilities 是空的，模型连开口的工具都拿不到。
 * 默认值只覆盖无平台的核心工具，所以部署配置必须显式补齐。
 */

test('默认白名单不含平台工具——所以接 QQ 时必须显式配', () => {
  const defaults = ConfigSchema.parse({});
  assert.equal(defaults.boundaries.allowedTools.includes('qq.send_message'), false,
    '默认值不该假装有平台能力');
});

test('示例配置补齐了 QQ 工具，照着配就能说话', () => {
  const example = JSON.parse(readFileSync('agent.qq.example.json', 'utf8')) as {
    boundaries: { allowedTools: string[] };
  };
  assert.ok(example.boundaries.allowedTools.includes('qq.send_message'));
  assert.ok(example.boundaries.allowedTools.includes('qq.history'));
});

test('白名单裁剪：没启用的工具跳过并报告，而不是让启动崩掉', () => {
  const registry = new CapabilityRegistry({ begin: () => 'op', finish: () => {} } as never);
  registry.register({ name: 'qq.send_message', description: 'x', effect: 'write',
    input: {} as never, run: async () => ({}) } as never);
  const { usable, skipped } = registry.narrow(['qq.send_message', 'bilibili.comments', 'web.search']);
  assert.deepEqual(usable, ['qq.send_message']);
  assert.deepEqual(skipped, ['bilibili.comments', 'web.search']);
});
