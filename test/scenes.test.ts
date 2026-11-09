import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { SqliteQqState } from '../src/infrastructure/sqlite/qq.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { QqConfigSchema } from '../src/integrations/qq/types.js';
import { createQqPlugin } from '../src/integrations/qq/plugin.js';
import type { OneBotPort } from '../src/integrations/qq/ports.js';
const NOW = 1800000000000;
class Model implements LanguageModel {
  requests: ModelRequest<unknown>[] = [];
  constructor(private readonly respond: (request: ModelRequest<any>) => unknown | Promise<unknown>) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> { this.requests.push(request); return request.schema.parse(await this.respond(request)); }
}
function fixture(model: LanguageModel) {
  const db = new Store(':memory:'); const repositories = sqliteRepositories(db); const capabilities = new CapabilityRegistry(repositories.operations);
  const agent = composeAgent(repositories, model, capabilities, ConfigSchema.parse({ boundaries: { allowedTools: ['qq.send_message'] } }));
  return { db, repositories, capabilities, agent, close() { agent.runtime.stop(); db.close(); } };
}
function sceneEvent(id: string, sessionId: string, type = 'group', target = '123') {
  return { id, source: 'qq', kind: 'qq.message', data: { text: '你好', groupId: target },
    route: { type: 'session' as const, sessionId, environment: 'qq', scope: { type, id: target } } };
}

test('普通 QQ 消息直接进入自己的场景会话；工具回执也留在本地，self 不参与回复', async () => {
  const model = new Model(request => {
    if (request.role === 'self') return { reflection: '初始化后暂时等待。' };
    assert.equal(request.role, 'scene'); const c = request.context as any;
    return c.observations.some((e: any) => e.kind === 'tool.result') ? { type: 'wait', summary: '已经在群里回复了问候。' }
      : { type: 'tool', name: 'qq.send_message', input: { target: c.session.scope, text: '你好呀' }, progress: '在当前群回复问候' };
  });
  const f = fixture(model); let handler!: (event: Record<string, unknown>) => Promise<void>; let sends = 0;
  const gateway: OneBotPort = { async start(callback) { handler = callback; }, async stop() {}, async call(action) { if (action === 'send_group_msg') { sends++; return { message_id: 900 }; } return {}; } };
  const plugin = createQqPlugin({ config: QqConfigSchema.parse({ selfId: '99', allowedGroups: ['123'] }), gateway, state: new SqliteQqState(f.db), clock: () => NOW + 1 });
  try {
    await plugin.setup({ register: tool => f.capabilities.register(tool) });
    await f.agent.runtime.tick(NOW);
    await plugin.start?.({ emit: event => { f.agent.runtime.ingest(event, NOW + 1); } });
    await handler({ post_type: 'message', message_type: 'group', self_id: 99, group_id: 123, user_id: 2, message_id: 1, time: NOW / 1000, message: [{ type: 'text', data: { text: '你好' } }] });
    await f.agent.runtime.tick(NOW + 1); await f.agent.runtime.tick(NOW + 2);
    assert.equal(sends, 1);
    assert.deepEqual(model.requests.map(r => r.role), ['self', 'scene', 'scene']);
    assert.equal(f.db.turns('self').length, 1);
    assert.equal(f.db.turns('scene:qq:99:group:123').length, 2);
    assert.equal(f.db.experiences(0, 100, 'self.inbox').some(e => e.kind === 'qq.message'), false);
    assert.equal(f.repositories.jobs.count(), 0);
  } finally { await plugin.stop?.(); f.close(); }
});

test('各群聊/私聊保持独立 session；等待之后的新消息沿用原 session 和本地前情', async () => {
  const model = new Model(request => request.role === 'self' ? { reflection: '初始化' } : { type: 'wait', summary: `保留${(request.context as any).session.id}的前情` });
  const f = fixture(model);
  try {
    await f.agent.runtime.tick(NOW);
    f.agent.runtime.ingest(sceneEvent('one', 'qq:99:group:123'), NOW + 1); await f.agent.runtime.tick(NOW + 1);
    f.agent.runtime.ingest(sceneEvent('two', 'qq:99:private:2', 'private', '2'), NOW + 2); await f.agent.runtime.tick(NOW + 2);
    f.agent.runtime.ingest(sceneEvent('three', 'qq:99:group:123'), NOW + 3); await f.agent.runtime.tick(NOW + 3);
    const local = model.requests.filter(r => r.role === 'scene');
    assert.deepEqual(local.map(r => (r.context as any).session.id), ['qq:99:group:123', 'qq:99:private:2', 'qq:99:group:123']);
    assert.equal((local[2]!.context as any).session.summary, '保留qq:99:group:123的前情');
    assert.equal((local[1]!.context as any).observations.some((e: any) => e.data.data.groupId === '123'), false);
    assert.equal(model.requests.filter(r => r.role === 'self').length, 1);
  } finally { f.close(); }
});

test('只有场景明确提交反思触发事件后才唤醒 self，由 self 调整主体方向', async () => {
  const model = new Model(request => request.role === 'self'
    ? { reflection: '评估方向', ...((request.context as any).subject.revision > 0 ? { direction: '认真了解群友反复讨论的迁徙问题' } : {}) }
    : { type: 'reflect', trigger: 'important_discovery', summary: '连续讨论产生了值得长期研究的问题', evidence: [(request.context as any).observations[0].seq] });
  const f = fixture(model);
  try {
    await f.agent.runtime.tick(NOW);
    f.agent.runtime.ingest(sceneEvent('discovery', 'qq:99:group:123'), NOW + 1);
    await f.agent.runtime.tick(NOW + 1);
    assert.equal(model.requests.filter(r => r.role === 'self').length, 1);
    assert.equal(f.repositories.jobs.count(), 1);
    await f.agent.runtime.tick(NOW + 2);
    assert.equal(model.requests.filter(r => r.role === 'self').length, 2);
    assert.equal(f.agent.subject.read().direction, '认真了解群友反复讨论的迁徙问题');
    const lastSelf = model.requests.filter(r => r.role === 'self').at(-1)!;
    assert.equal((lastSelf.context as any).observations[0].kind, 'scene.reflection_requested');
  } finally { f.close(); }
});

test('QQ 场景的工具授权绑定宿主 scope，模型不能把回复发到另一个群', async () => {
  const f = fixture(new Model(() => ({ reflection: '初始化' }))); let sends = 0;
  const gateway: OneBotPort = { async start() {}, async stop() {}, async call() { sends++; return { message_id: 1 }; } };
  const plugin = createQqPlugin({ config: QqConfigSchema.parse({ selfId: '99', allowedGroups: ['123', '456'] }), gateway, state: new SqliteQqState(f.db) });
  try {
    await plugin.setup({ register: tool => f.capabilities.register(tool) });
    await assert.rejects(f.capabilities.invoke('op', 'qq.send_message', { target: { type: 'group', id: '456' }, text: '跨群' }, ['qq.send_message'], NOW, { environment: 'qq', scope: { type: 'group', id: '123' } }), /scene scope/);
    assert.equal(sends, 0);
  } finally { f.close(); }
});
