import test from 'node:test';
import assert from 'node:assert/strict';
import { prefixRatio, stableOrder, CACHE_TARGET } from '../src/shared/prefix.js';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 每个 session 的 context 都要经得起「相邻两轮只差易变字段」的检验。
 *
 * 这里跑**真实 agent**：捕获模型实际收到的 context，比较相邻两轮的公共前缀。
 * 不用 mock 形状——mock 测的是我的假设，不是代码的行为。
 */

const serialize = (context: unknown): string =>
  JSON.stringify(typeof context === 'object' && context !== null && !Array.isArray(context)
    ? stableOrder(context as Record<string, unknown>) : context);

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sp-')), 'a.sqlite'));
  const repositories = sqliteRepositories(store);
  const roles: { role: string; text: string }[] = [];
  const model = {
    async decide(request: { role: string; instructions: string; context: unknown; schema: { parse(value: unknown): unknown } }) {
      // 真实请求是 instructions + context 拼起来的，两者都算进缓存前缀。
      roles.push({ role: request.role, text: request.instructions + serialize(request.context) });
      if (request.role === 'self') return request.schema.parse({ reflection: '醒着，看看', nextWakeAt: 2_000 });
      if (request.role === 'execution') return request.schema.parse({ type: 'complete', result: '完成', evidence: [] });
      return request.schema.parse({ type: 'wait', summary: '看着' });
    },
  };
  const agent = composeAgent(repositories, model as never, new CapabilityRegistry(repositories.operations),
    ConfigSchema.parse({ boundaries: { allowedTools: [] } }));
  return { store, repositories, agent, roles };
}

test('self 连续两次上下文的前缀达到目标（affect/revision 这类易变值不打断）', async () => {
  const f = harness();
  f.agent.runtime.start(1000);
  // 两次 self 唤醒：第一次走 bootstrap，第二次由 inbox 触发。
  f.repositories.jobs.enqueue('self', 'self', { reason: 'first' }, 1000);
  await f.agent.runtime.tick(1000);
  f.repositories.jobs.enqueue('self', 'self', { reason: 'second' }, 2000);
  await f.agent.runtime.tick(2000);
  const selfRuns = f.roles.filter(entry => entry.role === 'self');
  assert.ok(selfRuns.length >= 2, `self 应该被调用至少两次，实际 ${selfRuns.length}`);
  const ratio = prefixRatio(selfRuns[0]!.text, selfRuns[1]!.text);
  assert.ok(ratio >= CACHE_TARGET, `self 命中率 ${(ratio * 100).toFixed(1)}%，低于目标 80%`);
  f.agent.runtime.stop();
  f.store.close();
});

test('self 的 subject 只放稳定字段，affect 在末尾的 state 里', async () => {
  const f = harness();
  f.agent.runtime.start(1000);
  f.repositories.jobs.enqueue('self', 'self', { reason: 'first' }, 1000);
  await f.agent.runtime.tick(1000);
  const raw = f.roles.find(entry => entry.role === 'self')!;
  const parsed = JSON.parse(raw.text.slice(raw.text.indexOf('{'))) as { subject: Record<string, unknown>; state: Record<string, unknown> };
  assert.equal('affect' in parsed.subject, false, 'affect 每轮变，放在 subject 里会让后面全失效');
  assert.equal('revision' in parsed.subject, false);
  assert.ok('affect' in parsed.state, 'affect 要落在末尾的 state 里');
  f.agent.runtime.stop();
  f.store.close();
});
