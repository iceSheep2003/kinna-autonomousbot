import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { defaultContextLimits, payloadBudget } from '../src/shared/limits.js';

const NOW = 1800000000000;
class Model implements LanguageModel {
  requests: ModelRequest<unknown>[] = [];
  constructor(private readonly respond: (request: ModelRequest<any>) => unknown | Promise<unknown>) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> { this.requests.push(request); return request.schema.parse(await this.respond(request)); }
}
/** 预算放大到不会触发小时限额，单独观察上下文与回滚这两条性质。 */
function fixture(model: LanguageModel, overrides: Record<string, unknown> = {}) {
  const db = new Store(':memory:');
  const repositories = sqliteRepositories(db);
  const capabilities = new CapabilityRegistry(repositories.operations);
  const config = ConfigSchema.parse({ boundaries: { allowedTools: ['sandbox.observe'], maxModelCallsPerHour: 100000 }, ...overrides });
  const agent = composeAgent(repositories, model, capabilities, config);
  return { db, repositories, agent, close() { agent.runtime.stop(); db.close(); } };
}
function wake(id: string) {
  return { id, source: 'test', kind: 'test.wake', data: { note: id }, route: { type: 'self' as const } };
}

test('长跑 150 轮后 self 每轮上下文仍受 limits 约束，历史增长不进入上下文', async () => {
  const model = new Model(request => request.role === 'self' ? { reflection: '暂时休息。' } : { type: 'wait' });
  const f = fixture(model);
  try {
    await f.agent.runtime.tick(NOW);
    for (let i = 1; i <= 150; i++) {
      f.agent.runtime.ingest(wake(`wake-${i}`), NOW + i * 1000);
      await f.agent.runtime.tick(NOW + i * 1000);
    }
    const selves = model.requests.filter(r => r.role === 'self');
    assert.ok(selves.length >= 150, `self 应被唤醒 150 次，实际 ${selves.length}`);
    for (const request of selves) {
      const context = request.context as any;
      assert.ok(context.observations.length <= defaultContextLimits.observations, '观察条数超限');
      assert.ok(context.recent.length <= defaultContextLimits.recentTurns, '近期决策超限');
      assert.ok(context.goals.length <= defaultContextLimits.goals, '目标条数超限');
      assert.ok(context.memories.length <= defaultContextLimits.memories, '记忆条数超限');
      assert.ok(context.executions.length <= defaultContextLimits.executions, '执行条数超限');
      assert.ok(context.schedules.length <= defaultContextLimits.schedules, '日程条数超限');
      assert.ok(JSON.stringify(context).length < 80000, '单轮上下文超过预算');
    }
    // 经验日志持续增长，但上面每一轮的上下文都没跟着长：这是“会话永久存在 ≠ 上下文无限”的证据。
    assert.ok(f.db.experiences(0, 10000).length > 150, '经验日志应随历史增长');
    const last = selves.at(-1)!.context as any;
    const first = selves[0]!.context as any;
    assert.equal(first.observations.length, last.observations.length, '观察窗口不应随轮次扩大');
  } finally { f.close(); }
});

test('决策越权时整体回滚：目标、执行、日程都不留下半截状态', async () => {
  const model = new Model(request => request.role === 'self'
    ? { reflection: '尝试一个未被授权的能力。',
      goals: [{ id: 'goal-1', content: '越权目标', horizon: 'short', status: 'active', reason: '测试回滚', evidence: [] }],
      act: [{ name: 'sandbox.forbidden', input: {}, reason: '越权调用' }],
      schedules: [{ id: 'later', dueAt: NOW + 60000, action: { type: 'wake', reason: '稍后再试' } }] }
    : { type: 'wait' });
  const f = fixture(model);
  try {
    await f.agent.runtime.tick(NOW);
    for (const at of [NOW + 3000, NOW + 9000, NOW + 30000]) await f.agent.runtime.tick(at);
    assert.equal(f.db.list('goals').length, 0, '失败的目标不应落库');
    assert.equal(f.db.list('executions').length, 0, '失败的执行不应落库');
    assert.equal(f.db.list('schedules').length, 0, '失败的日程不应落库');
    assert.equal(f.agent.subject.read().revision, 0, '主体版本不应被失败的决策推进');
    assert.equal(f.repositories.jobs.count(), 0, '作业应终止而不是无限重试');
    const errors = f.db.experiences(0, 500, 'runtime').filter(e => e.kind === 'job.error');
    assert.equal(errors.length, 3, '重试 3 次后终止');
    assert.equal((errors.at(-1)!.data as { terminal: boolean }).terminal, true);
  } finally { f.close(); }
});

test('超长事件在入口被拒绝，不写入经验日志', async () => {
  const f = fixture(new Model(() => ({ reflection: '休息' })));
  try {
    await f.agent.runtime.tick(NOW);
    const huge = { id: 'huge', source: 'test', kind: 'test.huge', data: { blob: 'x'.repeat(payloadBudget.eventChars) }, route: { type: 'experience' as const } };
    assert.throws(() => f.agent.runtime.ingest(huge, NOW + 1), /Event too large/);
    assert.equal(f.db.experiences(0, 50, 'test').length, 0, '被拒事件不应落库');
    const ok = { id: 'ok', source: 'test', kind: 'test.ok', data: { blob: 'x'.repeat(10) }, route: { type: 'experience' as const } };
    f.agent.runtime.ingest(ok, NOW + 2);
    assert.equal(f.db.experiences(0, 50, 'test').length, 1);
  } finally { f.close(); }
});
