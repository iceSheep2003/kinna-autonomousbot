import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { composeAgent } from '../src/app/agent.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { sqliteAdmin } from '../src/infrastructure/sqlite/admin.js';
import { ConfigSchema } from '../src/app/config.js';
import { UncertainOperation } from '../src/capabilities/ports.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { registerSandbox } from '../src/integrations/builtin.js';
import { DemoModel } from '../src/infrastructure/models/demo.js';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import type { Execution } from '../src/execution/types.js';
import type { SelfState } from '../src/subject/types.js';
import type { Schedule } from '../src/runtime/types.js';
import { createServer } from '../src/infrastructure/http/server.js';
import { OpenAICompatibleModel } from '../src/infrastructure/models/openai-compatible.js';

const NOW = 1800000000000;
class ScriptedModel implements LanguageModel {
  requests: ModelRequest<unknown>[] = [];
  constructor(private fn: (request: ModelRequest<any>) => unknown | Promise<unknown>) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> { this.requests.push(request); return request.schema.parse(await this.fn(request)); }
}
function fixture(model: LanguageModel = new DemoModel(), path = ':memory:', overrides: Record<string, unknown> = {}) {
  const store = new Store(path); const repositories = sqliteRepositories(store); const registry = new CapabilityRegistry(repositories.operations); registerSandbox(registry);
  const options = ConfigSchema.parse({ boundaries: { allowedTools: ['sandbox.observe'] }, ...overrides });
  const agent = composeAgent(repositories, model, registry, options);
  const runtime = agent.runtime;
  return { store, registry, runtime, agent, repositories, close() { runtime.stop(); store.close(); } };
}
const rest = { reflection: '当前没有必要行动，等新线索。' };

test('无外部任务：初始化 self 自行形成目标、执行、收到反馈，self 身份保持不变', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) await f.runtime.tick(NOW + i * 1000);
    assert.equal(f.store.list('goals').length, 1);
    assert.equal(f.store.list<Execution>('executions')[0]?.status, 'completed');
    assert.equal(f.store.get<SelfState>('subject', 'self')?.id, 'self');
    assert.equal(f.store.turns('self').length, 2);
    assert.equal(f.store.list('operations').length, 1);
    assert.equal(f.store.list<Schedule>('schedules')[0]?.status, 'pending');
  } finally { f.close(); }
});

test('重启保留主体、经验和日程，不再次 bootstrap；恢复运行中的作业', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-test-')); const path = join(dir, 'agent.sqlite');
  const a = fixture(new ScriptedModel(() => ({ ...rest, nextWakeAt: NOW + 50000 })), path);
  await a.runtime.tick(NOW);
  const original = a.store.get<SelfState>('subject', 'self');
  a.store.enqueue('self', 'self', { reason: 'recover me' }, NOW + 1000);
  a.store.claim(NOW + 1000);
  a.close();
  const b = fixture(new ScriptedModel(() => rest), path);
  try {
    b.runtime.start(NOW + 2000);
    assert.deepEqual(b.store.get('subject', 'self'), original);
    await b.runtime.tick(NOW + 2000);
    assert.equal(b.store.turns('self').length, 2);
    assert.equal(b.store.experiences().filter(e => e.kind === 'initialized').length, 1);
  } finally { b.close(); rmSync(dir, { recursive: true }); }
});

test('事件去重；读取期间到达的新事件不会被 self 游标跳过', async () => {
  let release!: () => void; let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const model = new ScriptedModel(async () => { if (first) { first = false; began(); await blocked; } return rest; });
  const f = fixture(model);
  try {
    const active = f.runtime.tick(NOW); await started;
    const event = { id: 'one', source: 'test', kind: 'message', data: 'hello', route: { type: 'self' as const } };
    assert.equal(f.runtime.ingest(event, NOW + 1).duplicate, false);
    assert.equal(f.runtime.ingest(event, NOW + 2).duplicate, true);
    release(); await active;
    await f.runtime.tick(NOW + 1001);
    assert.equal(model.requests.length, 2);
    assert.equal((model.requests[1]!.context as any).observations[0].data.data, 'hello');
  } finally { f.close(); }
});

test('不合法能力使整次 self 改动回滚，不能留下半个目标', async () => {
  const f = fixture(new ScriptedModel(() => ({ reflection: '尝试', goals: [{ id: 'g', content: '目标', horizon: 'long', status: 'active', reason: '兴趣', evidence: [] }], launch: [{ intent: '越界动作', tools: ['forbidden.write'] }] })));
  try {
    await f.runtime.tick(NOW);
    assert.equal(f.store.list('goals').length, 0);
    assert.equal(f.store.get<SelfState>('subject', 'self')?.revision, 0);
    assert.equal(f.store.pendingCount(), 1);
  } finally { f.close(); }
});

test('局部工具结果不逐步唤醒 self，结束时反馈；局部步骤有上限', async () => {
  const model = new ScriptedModel(req => req.role === 'self' ? { ...rest, launch: [{ intent: '无限读取尝试', tools: ['sandbox.observe'] }] } : { type: 'tool', name: 'sandbox.observe', input: {}, progress: '继续读取' });
  const f = fixture(model, ':memory:', { boundaries: { allowedTools: ['sandbox.observe'], maxExecutionSteps: 2 } });
  try {
    await f.runtime.tick(NOW); await f.runtime.tick(NOW + 1000); await f.runtime.tick(NOW + 2000);
    assert.equal(model.requests.filter(r => r.role === 'self').length, 1);
    await f.runtime.tick(NOW + 3000);
    assert.equal(f.store.list<Execution>('executions')[0]?.status, 'paused');
    assert.equal(f.store.experiences().filter(e => e.kind === 'execution.finished' && e.source === 'self.inbox').length, 1);
  } finally { f.close(); }
});

test('未来 wake 真正触发 self；目标变更自动取消绑定的旧日程', async () => {
  let call = 0;
  const f = fixture(new ScriptedModel(() => ++call === 1 ? {
    ...rest,
    goals: [{ id: 'g', content: '学习鸟类', horizon: 'long', status: 'active', reason: '兴趣', evidence: [] }],
    schedules: [{ id: 'old', dueAt: NOW + 10000, goalId: 'g', action: { type: 'execute', intent: '读内容', tools: ['sandbox.observe'] } }],
    nextWakeAt: NOW + 2000,
  } : { ...rest, goals: [{ id: 'g', content: '学习鸟类', horizon: 'long', status: 'abandoned', reason: '没有继续投入的理由', evidence: [] }] }));
  try {
    await f.runtime.tick(NOW); assert.equal(await f.runtime.tick(NOW + 1000), false);
    await f.runtime.tick(NOW + 2000);
    assert.equal(call, 2);
    assert.equal(f.store.get<Schedule>('schedules', 'old')?.status, 'cancelled');
    await f.runtime.tick(NOW + 10000);
    assert.equal(f.store.list('executions').length, 0);
  } finally { f.close(); }
});

test('定时确定行动可直接创建执行，不需要先让 self 重做决定', async () => {
  const model = new ScriptedModel(req => req.role === 'self' ? { ...rest, schedules: [{ id: 'read-later', dueAt: NOW + 5000, action: { type: 'execute', intent: '观察环境', tools: ['sandbox.observe'] } }] } : { type: 'tool', name: 'sandbox.observe', input: {}, progress: '观察' });
  const f = fixture(model);
  try {
    await f.runtime.tick(NOW); await f.runtime.tick(NOW + 5000);
    assert.equal(model.requests.filter(r => r.role === 'self').length, 1);
    assert.equal(f.store.list('operations').length, 1);
    assert.equal(f.store.get<Schedule>('schedules', 'read-later')?.status, 'fired');
  } finally { f.close(); }
});

test('Dream 只发布已验证的快照，按事件游标增量整理，不能改变目标', async () => {
  let fail = true;
  const f = fixture(new ScriptedModel(req => {
    if (req.role !== 'dream') return rest;
    const c = req.context as any;
    if (fail) return { summary: '无效引用', memories: [{ id: 'm', content: '内容', kind: 'inference', evidence: [999999] }], proposals: [] };
    return { summary: '整理完成', memories: [{ id: 'm', content: '主体曾反思', kind: 'observation', evidence: [c.experiences[0].seq] }], proposals: ['考虑新兴趣'] };
  }));
  try {
    await f.runtime.tick(NOW);
    f.store.enqueue('dream', 'dream', {}, NOW + 1000);
    await f.runtime.tick(NOW + 1000);
    assert.equal(f.store.get('meta', 'dreamCursor'), undefined);
    assert.equal(f.store.list('memories').length, 0);
    const cutoff = f.store.latestSequence(); fail = false;
    await f.runtime.tick(NOW + 4000);
    assert.equal(f.store.get('meta', 'dreamCursor'), cutoff);
    assert.equal(f.store.list('memories').length, 1);
    assert.equal(f.store.list('goals').length, 0);
    assert.ok(f.store.latestSequence() > cutoff);
  } finally { f.close(); }
});

test('副作用不确定时不自动重发；已完成 operation 直接复用结果', async () => {
  const store = new Store(':memory:'); const registry = new CapabilityRegistry(sqliteRepositories(store).operations); let writes = 0;
  registry.register({ name: 'test.send', description: '写操作', effect: 'write', input: z.object({}), async run() { writes++; throw new Error('connection lost after send'); } });
  try {
    await assert.rejects(registry.invoke('op', 'test.send', {}, ['test.send'], NOW), UncertainOperation);
    await assert.rejects(registry.invoke('op', 'test.send', {}, ['test.send'], NOW), UncertainOperation);
    assert.equal(writes, 1);
    store.put('operations', 'op2', { status: 'completed', effect: 'write', result: { remoteId: '123' } });
    assert.deepEqual(await registry.invoke('op2', 'test.send', {}, ['test.send'], NOW), { remoteId: '123' });
    assert.equal(writes, 1);
  } finally { store.close(); }
});

test('小时预算耗尽时持久延期，不忙循环调用模型', async () => {
  const model = new ScriptedModel(() => rest);
  const f = fixture(model, ':memory:', { boundaries: { allowedTools: [], maxModelCallsPerHour: 1 } });
  try {
    await f.runtime.tick(NOW);
    f.runtime.ingest({ id: 'new', source: 'test', kind: 'notice', data: 'new', route: { type: 'self' } }, NOW + 1000);
    assert.equal(await f.runtime.tick(NOW + 1000), false);
    assert.equal(model.requests.length, 1);
    assert.equal(f.store.pendingCount(), 1);
    await f.runtime.tick(NOW + 3600001);
    assert.equal(model.requests.length, 2);
  } finally { f.close(); }
});

test('数据库租约拒绝第二个 runtime；不吞掉运行中实例的作业', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-test-')); const path = join(dir, 'db.sqlite');
  const a = fixture(new DemoModel(), path); const b = fixture(new DemoModel(), path);
  try { a.runtime.start(NOW); assert.throws(() => b.runtime.start(NOW), /Another runtime/); }
  finally { a.close(); b.close(); rmSync(dir, { recursive: true }); }
});

test('HTTP 接口鉴权、事件校验和去重', async () => {
  const f = fixture(); f.runtime.start(NOW);
  const app = createServer(sqliteAdmin(f.store, f.agent), 'test-secret-at-least-24-chars');
  const headers = { authorization: 'Bearer test-secret-at-least-24-chars' };
  try {
    assert.equal((await app.inject({ url: '/v1/self' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/v1/self', headers })).json().id, 'self');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/events', headers, payload: {} })).statusCode, 400);
    const request = { method: 'POST' as const, url: '/v1/events', headers, payload: { id: 'a', source: 'plugin', kind: 'message', data: '你好', route: { type: 'self' } } };
    assert.equal((await app.inject(request)).json().duplicate, false);
    assert.equal((await app.inject(request)).json().duplicate, true);
  } finally { await app.close(); f.close(); }
});

test('模型 adapter 使用真实 HTTP 格式并校验响应，provider 密钥不进入提示词', async () => {
  const original = globalThis.fetch; let sent: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: 'ok' }) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'test' });
    const result = await model.decide({ role: 'self', instructions: 'Think', context: { identity: 'test' }, schema: z.object({ result: z.string() }) });
    assert.deepEqual(result, { result: 'ok' });
    assert.equal(JSON.stringify(sent).includes('secret'), false);
    assert.equal(sent.response_format.type, 'json_object');
  } finally { globalThis.fetch = original; }
});

test('通过插件入口接入新环境，无须修改 self 或执行器', async () => {
  const { loadPlugins } = await import('../src/integrations/loader.js');
  const f = fixture(new ScriptedModel(() => rest));
  try {
    f.runtime.start(NOW);
    const plugins = await loadPlugins([new URL('../examples/local-environment.ts', import.meta.url).pathname], f.registry);
    await plugins[0]!.start?.({ emit: event => { f.runtime.ingest(event, NOW); } });
    const catalog = f.registry.catalog(['local.explore']);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.inputSchema.type, 'object');
    const observed = await f.registry.invoke('local-read', 'local.explore', {}, ['local.explore'], NOW) as { simulated: boolean };
    assert.equal(observed.simulated, true);
    assert.equal(f.store.experiences().filter(e => e.kind === 'environment.available').length, 1);
  } finally { f.close(); }
});

test('简单 act 与定时 tool 直接调用工具，不产生局部 LLM 会话', async () => {
  const model = new ScriptedModel(() => ({ ...rest,
    act: [{ name: 'sandbox.observe', input: {}, reason: '看一眼环境' }],
    schedules: [{ id: 'direct-later', dueAt: NOW + 5000, action: { type: 'tool', name: 'sandbox.observe', input: {}, reason: '稍后再观察' } }],
  }));
  const f = fixture(model);
  try {
    await f.runtime.tick(NOW); await f.runtime.tick(NOW + 1000);
    assert.equal(model.requests.length, 1);
    const execution = f.store.list<Execution>('executions')[0]!;
    assert.equal(execution.status, 'completed');
    assert.equal(f.store.turns(`execution:${execution.id}`).length, 0);
    // 清掉 self 反馈作业以单独检查到时直接动作，不额外调用脚本模型。
    f.store.db.prepare("UPDATE jobs SET status='done' WHERE kind='self' AND status='pending'").run();
    await f.runtime.tick(NOW + 5000);
    assert.equal(model.requests.length, 1);
    assert.equal(f.store.list('operations').length, 2);
    assert.equal(f.store.get<Schedule>('schedules', 'direct-later')?.status, 'fired');
  } finally { f.close(); }
});

test('Dream 读取快照期间新经验到达，发布只推进到原始截断位置', async () => {
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(new ScriptedModel(async req => {
    if (req.role !== 'dream') return rest;
    started(); await blocked;
    const c = req.context as any;
    return { summary: '快照整理', memories: [{ id: 'snapshot', content: '来自快照的观察', kind: 'observation', evidence: [c.experiences[0].seq] }], proposals: [] };
  }));
  try {
    await f.runtime.tick(NOW);
    const cutoff = f.store.latestSequence();
    f.store.enqueue('dream', 'dream', {}, NOW + 1000);
    const running = f.runtime.tick(NOW + 1000); await ready;
    f.runtime.ingest({ id: 'late', source: 'test', kind: 'new.experience', data: 'new', route: { type: 'experience' } }, NOW + 1001);
    release(); await running;
    assert.equal(f.store.get('meta', 'dreamCursor'), cutoff);
    assert.equal(f.store.experiences(cutoff)[0]?.kind, 'new.experience');
  } finally { f.close(); }
});

test('外部写入成功后本地提交前崩溃，重启复用回执且不再次写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operation-recovery-')); const path = join(dir, 'agent.sqlite');
  let writes = 0;
  const addWrite = (registry: CapabilityRegistry) => registry.register({ name: 'test.write', description: '测试写操作', effect: 'write', input: z.object({}), async run() { writes++; return { remoteId: 'one' }; } });
  const options = { boundaries: { allowedTools: ['test.write'] } };
  const a = fixture(new ScriptedModel(() => ({ ...rest, act: [{ name: 'test.write', input: {}, reason: '执行一次已决定的操作' }] })), path, options);
  addWrite(a.registry);
  await a.runtime.tick(NOW);
  const claimed = a.store.claim(NOW + 1000)!;
  await a.registry.invoke(`operation:${claimed.id}`, 'test.write', {}, ['test.write'], NOW + 1000);
  // 没有提交 execution 状态，相当于进程此时退出。
  a.close();
  const model = new ScriptedModel(() => rest);
  const b = fixture(model, path, options); addWrite(b.registry);
  try {
    await b.runtime.tick(NOW + 2000);
    assert.equal(writes, 1);
    assert.equal(model.requests.length, 0);
    assert.equal(b.store.list<Execution>('executions')[0]?.status, 'completed');
    assert.equal(b.store.pendingCount(), 1); // 完成反馈等待 self。
  } finally { b.close(); rmSync(dir, { recursive: true }); }
});
