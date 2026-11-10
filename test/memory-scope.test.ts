import test from 'node:test';
import assert from 'node:assert/strict';
import { canPromote, formatScope, parseScope, readableScopes, sameScope, scopeReadable } from '../src/memory/scope.js';
import { isReadable } from '../src/memory/access.js';
import { renderMemoryContext } from '../src/memory/render.js';
import type { Memory, RecallRequest, RetrievalHit } from '../src/memory/types.js';

const NOW = 1_800_000_000_000;

function memory(overrides: Partial<Memory> = {}): Memory {
  return { id: 'm1', content: '一条记忆', evidence: [1], kind: 'observation', revision: 1, status: 'active', ...overrides };
}
function request(scope?: string): RecallRequest {
  return { query: 'q', limit: 5, now: NOW, ...(scope ? { scope } : {}) };
}
function hit(m: Memory, score = 1): RetrievalHit {
  return { memory: m, score, reasons: [] };
}

/* ------------------------------ scope 解析 ------------------------------ */

test('scope 序列化与解析：owner 与带 id 的场景', () => {
  assert.equal(formatScope({ kind: 'owner' }), 'owner');
  assert.equal(formatScope({ kind: 'group', id: '123' }), 'group:123');
  assert.deepEqual(parseScope('group:123'), { kind: 'group', id: '123' });
  assert.deepEqual(parseScope('owner'), { kind: 'owner' });
  assert.deepEqual(parseScope(undefined), { kind: 'owner' });
});

test('非法 scope 一律当 owner：脏数据不能变成宽范围授权', () => {
  assert.deepEqual(parseScope('group:'), { kind: 'owner' });
  assert.deepEqual(parseScope('group:../etc'), { kind: 'owner' });
  assert.deepEqual(parseScope('随便写'), { kind: 'owner' });
  assert.deepEqual(parseScope('group:123:456'), { kind: 'owner' });
});

test('读取向下看得到：在 group:A 能读 owner + group:A，读不到 group:B', () => {
  const fromA = readableScopes({ kind: 'group', id: 'A' });
  assert.ok(fromA.has('owner'));
  assert.ok(fromA.has('group:A'));
  assert.ok(!fromA.has('group:B'));
});

test('owner 视角只看得到 owner 层', () => {
  const fromOwner = readableScopes({ kind: 'owner' });
  assert.deepEqual([...fromOwner], ['owner']);
});

test('库里的记录按 scope 判可见；旧数据没标 scope 当 owner，仍然可读', () => {
  assert.equal(scopeReadable(undefined, { kind: 'group', id: 'A' }), true);
  assert.equal(scopeReadable('group:A', { kind: 'group', id: 'A' }), true);
  assert.equal(scopeReadable('group:B', { kind: 'group', id: 'A' }), false);
  assert.equal(scopeReadable('group:A', { kind: 'owner' }), false);
});

test('同层同 id 才算同一个 scope；跨层不算', () => {
  assert.equal(sameScope({ kind: 'group', id: 'A' }, { kind: 'group', id: 'A' }), true);
  assert.equal(sameScope({ kind: 'group', id: 'A' }, { kind: 'feature', id: 'A' }), false);
});

test('只有从具体场景才能提到 owner；owner 到 owner 不算提升', () => {
  assert.equal(canPromote({ kind: 'group', id: 'A' }, { kind: 'owner' }), true);
  assert.equal(canPromote({ kind: 'owner' }, { kind: 'owner' }), false);
  assert.equal(canPromote({ kind: 'group', id: 'A' }, { kind: 'group', id: 'B' }), false, '不允许跨场景平移');
});

/* ------------------------------ 读取过滤 ------------------------------ */

test('isReadable 在检索阶段就挡住别的场景，而不是靠提示词要求模型忽略', () => {
  const otherGroup = memory({ scope: 'group:B' });
  const sameGroup = memory({ scope: 'group:A' });
  const general = memory({ scope: 'owner' });
  const req = request('group:A');
  assert.equal(isReadable(otherGroup, req), false);
  assert.equal(isReadable(sameGroup, req), true);
  assert.equal(isReadable(general, req), true);
});

test('场景内的私事仍受 visibility 约束：别人的私事不进这个会话', () => {
  const privateFact = memory({ scope: 'group:A', subjectUserId: 'u2', visibility: 'personal', originUserId: 'u1' });
  assert.equal(isReadable(privateFact, request('group:A')), false);
});

/* ------------------------------ 分层渲染 ------------------------------ */

test('上下文分两层给出：通用的与只属于当前场景的不混在一起', () => {
  const context = renderMemoryContext([
    hit(memory({ id: 'g1', scope: 'owner', content: '用户喜欢先给结论' })),
    hit(memory({ id: 's1', scope: 'group:A', content: '这个群里小林在准备考研' })),
  ]);
  assert.deepEqual(context.general.map(item => item.id), ['g1']);
  assert.deepEqual(context.scoped.map(item => item.id), ['s1']);
});

test('通用层有自己的预算上限：场景记忆再多也不会把通用偏好挤光', () => {
  const scoped = Array.from({ length: 20 }, (_, index) => hit(memory({
    id: `s${index}`, scope: 'group:A', content: `场景事实 ${index} `.repeat(8),
  })));
  const context = renderMemoryContext([hit(memory({ id: 'g1', scope: 'owner', content: '通用偏好' })), ...scoped], 2000);
  assert.equal(context.general.length, 1, '通用层必须保留');
  assert.ok(context.scoped.length > 0);
});

test('超长的记忆整条跳过，不截半句', () => {
  const context = renderMemoryContext([hit(memory({ content: 'x'.repeat(2000), scope: 'owner' }))]);
  assert.equal(context.general.length, 0);
  assert.equal(context.omitted, 1);
});
