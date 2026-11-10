import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { SocialContextSchema, socialLine } from '../src/self/social.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * self 主动找人的前提：它得知道**能找谁**、**现在合不合适**。
 *
 * 之前它的 context 里没有 people、没有社交圈，只有 send_message——
 * 等于给了电话不给通讯录，想发消息时连群号都得从最近一条消息里猜。
 */

function harness(options: Record<string, unknown> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'ss-')), 'a.sqlite'));
  const repositories = sqliteRepositories(store);
  const contexts: Record<string, unknown>[] = [];
  const model = {
    async decide(request: { role: string; context: Record<string, unknown>; schema: { parse(v: unknown): unknown } }) {
      if (request.role === 'self') contexts.push(request.context);
      if (request.role === 'self') return request.schema.parse({ reflection: '醒着' });
      return request.schema.parse({ type: 'wait', summary: '看' });
    },
  };
  // social 是运行时数据（依赖心情），不是环境配置，所以单独传给 AgentOptions。
  const agent = composeAgent(repositories, model as never, new CapabilityRegistry(repositories.operations), {
    ...ConfigSchema.parse({ boundaries: { allowedTools: [] } }),
    ...options,
  } as never);
  return { store, repositories, agent, contexts };
}

test('social 只接受有界结构：群、可私聊的人、现在合不合适主动开口', () => {
  const parsed = SocialContextSchema.parse({
    groups: [{ id: '330707267', name: '考研群' }], privateAllowed: ['3485823460'], proactivePermitted: true,
  });
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.proactivePermitted, true);
});

test('社交圈渲染成人话，不是一串 id', () => {
  const text = socialLine({ groups: [{ id: '330707267', name: '考研群' }], privateAllowed: ['3485823460'], proactivePermitted: true });
  assert.match(text, /考研群/);
  assert.match(text, /3485823460/);
  assert.match(text, /可以/);
});

test('心情不允许时，这句话要明确说不合适——而不是让模型自己猜', () => {
  const text = socialLine({ groups: [], privateAllowed: [], proactivePermitted: false });
  assert.match(text, /不太想|不合适|先别/);
});

test('self 的上下文里带上社交圈（来自装配层的注入）', async () => {
  const f = harness({
    social: () => ({ groups: [{ id: '330707267', name: '考研群' }], privateAllowed: [], proactivePermitted: true }),
  });
  f.agent.runtime.start(1000);
  f.repositories.jobs.enqueue('self', 'self', { reason: 'first' }, 1000);
  await f.agent.runtime.tick(1000);
  const context = f.contexts[0] as { social?: string };
  assert.ok(context.social, 'self 必须知道自己能跟谁说话');
  // 给的是渲染好的人话，不是原始结构：模型读文字比读 id 列表准。
  assert.match(context.social, /考研群/);
  f.agent.runtime.stop();
  f.store.close();
});

test('没有注入 social 时不崩，也不假造一群群', async () => {
  const f = harness();
  f.agent.runtime.start(1000);
  f.repositories.jobs.enqueue('self', 'self', { reason: 'first' }, 1000);
  await f.agent.runtime.tick(1000);
  assert.ok(f.contexts[0]);
  f.agent.runtime.stop();
  f.store.close();
});
