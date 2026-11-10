import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FORGET, archive, planForgetting, revive } from '../src/memory/forget.js';
import { MemoryForgetter } from '../src/memory/forget-service.js';
import { isReadable } from '../src/memory/access.js';
import type { Memory, RecallRequest } from '../src/memory/types.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;

function memory(overrides: Partial<Memory> = {}): Memory {
  return { id: 'm1', content: '一条旧记忆', evidence: [1], kind: 'observation', revision: 1,
    status: 'active', scope: 'group:A', importance: 1, createdAt: NOW - 90 * DAY, ...overrides };
}
const request = (options: Partial<RecallRequest> = {}): RecallRequest => ({ query: 'q', limit: 5, now: NOW, scope: 'group:A', ...options });

test('冷掉的、不重要的、不常用的会被归档', () => {
  assert.equal(planForgetting([memory()], NOW).length, 1);
});

test('四条保护：通用层、重要的、有常用记录的、有明确过期时间的不归档', () => {
  assert.deepEqual(planForgetting([memory({ scope: 'owner' })], NOW), [], '通用层是判断，不是流水账');
  assert.deepEqual(planForgetting([memory({ importance: 4 })], NOW), [], '重要的不归档');
  assert.deepEqual(planForgetting([memory({ accessCount: 5 })], NOW), [], '常用的说明还有用');
  assert.deepEqual(planForgetting([memory({ expiresAt: NOW + DAY })], NOW), [], '过期走另一条路径');
});

test('没冷够的不归档', () => {
  assert.deepEqual(planForgetting([memory({ createdAt: NOW - DAY })], NOW), []);
  // 被访问过就用访问时间算
  assert.deepEqual(planForgetting([memory({ createdAt: NOW - 90 * DAY, lastAccessedAt: NOW - DAY })], NOW), []);
});

test('一次最多归档一批，不会一次清掉半个库', () => {
  const many = Array.from({ length: 100 }, (_, index) => memory({ id: `m${index}` }));
  assert.equal(planForgetting(many, NOW).length, DEFAULT_FORGET.maxPerRun);
});

test('归档后默认不进上下文，但主动回想能找到', () => {
  const archived = archive(memory(), NOW);
  assert.equal(archived.status, 'archived');
  assert.equal(isReadable(archived, request()), false, '默认注入不该被旧事稀释');
  assert.equal(isReadable(archived, request({ includeArchived: true })), true, '努力回想就该翻得更深');
});

test('归档只改状态，内容和证据原样保留', () => {
  const archived = archive(memory({ evidence: [1, 5, 9], content: '原话' }), NOW);
  assert.deepEqual(archived.evidence, [1, 5, 9]);
  assert.equal(archived.content, '原话');
});

test('被想起来就恢复——遗忘必须是可逆的', () => {
  const archived = archive(memory({ accessCount: 1 }), NOW);
  const back = revive(archived, NOW);
  assert.equal(back.status, 'active');
  assert.equal(back.accessCount, 2);
  assert.equal(back.lastAccessedAt, NOW);
});

test('恢复只对归档的生效，别的不动', () => {
  const active = memory();
  assert.equal(revive(active, NOW), active);
  const candidate = memory({ status: 'candidate' });
  assert.equal(revive(candidate, NOW).status, 'candidate');
});

test('端到端：归档后再主动回想，真的会恢复成 active', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  repo.publish({ id: 'old', content: '以前提过想学 Rust', evidence: [1], kind: 'observation', revision: 1,
    status: 'archived', scope: 'group:A', createdAt: NOW - 90 * DAY });
  const service = new MemoryService(repo, { clock: () => NOW });
  // 默认注入看不到
  assert.equal(service.recall('Rust', 5, 'group:A').length, 0);
  // 主动回想找得到，并且恢复
  const found = service.recall('Rust', 5, 'group:A', { includeArchived: true });
  assert.equal(found.length, 1);
  assert.equal(repo.get('old')?.status, 'active', '想起来之后应恢复');
  store.close();
});

test('归档服务只归档该归档的，并把条数记下来', () => {
  const saved: Memory[] = [];
  const forgetter = new MemoryForgetter({
    repository: { recent: () => [memory({ id: 'cold' }), memory({ id: 'owner', scope: 'owner' })],
      publish: (m: Memory) => { saved.push(m); } } as never,
    now: () => NOW,
  });
  const result = forgetter.run();
  assert.equal(result.archived, 1);
  assert.deepEqual(saved.map(m => m.id), ['cold']);
});
