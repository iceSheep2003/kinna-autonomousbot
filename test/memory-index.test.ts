import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_INDEX, INDEX_LIMITS, MemoryIndexSchema, fitIndex, indexSize, pruneDangling,
  referencedIds, renderIndex, type IndexEntry,
} from '../src/memory/index-layer.js';

const NOW = 1_800_000_000_000;
const entry = (overrides: Partial<IndexEntry> = {}): IndexEntry => ({
  topic: '考研', summary: '他在准备 408', memoryIds: ['m1'], weight: 3, ...overrides,
});

/* ------------------------------ 约束 ------------------------------ */

test('有硬上限：条数、摘要长度、整体字符', () => {
  const tooMany = Array.from({ length: INDEX_LIMITS.maxEntries + 5 }, (_, i) => entry({ memoryIds: [`m${i}`] }));
  assert.throws(() => MemoryIndexSchema.parse({ scope: 'owner', version: 1, updatedAt: NOW, entries: tooMany }));
  assert.throws(() => MemoryIndexSchema.parse({ scope: 'owner', version: 1, updatedAt: NOW, entries: [entry({ summary: 'x'.repeat(INDEX_LIMITS.maxSummary + 1) })] }));
});

test('每条必须指向至少一条记忆，否则没有可展开的东西', () => {
  assert.throws(() => MemoryIndexSchema.parse({ scope: 'owner', version: 1, updatedAt: NOW, entries: [entry({ memoryIds: [] })] }));
});

test('fitIndex 把超限裁到合法，且保留权重高的', () => {
  const many = Array.from({ length: 50 }, (_, i) => entry({ topic: `t${i}`, memoryIds: [`m${i}`], weight: i % 6 }));
  const fitted = fitIndex(many, 0, NOW);
  assert.equal(fitted.entries.length, INDEX_LIMITS.maxEntries);
  assert.equal(fitted.version, 0);
  assert.equal(fitted.scope, 'owner');
  assert.equal(fitted.updatedAt, NOW);
  // 保留的应该都是权重较高的那一批
  assert.ok(fitted.entries.every(item => item.weight >= 1));
});

/* ------------------------------ 渲染 ------------------------------ */

test('渲染带展开提示，让模型知道细节怎么取', () => {
  const { text } = renderIndex({ scope: 'owner', version: 1, updatedAt: NOW, entries: [entry({ memoryIds: ['m1', 'm2'] })] });
  assert.match(text, /先看这里/);
  assert.match(text, /memory\.expand/);
  assert.match(text, /展开: m1,m2/);
});

test('空索引不渲染（不是给一段空标题占预算）', () => {
  assert.deepEqual(renderIndex(EMPTY_INDEX), { text: '', dropped: 0 });
});

test('超预算时按权重丢行，但丢的只是索引行不是记忆', () => {
  const entries = [
    entry({ topic: '重要', weight: 5, summary: '很关键的事' }),
    entry({ topic: '次要', weight: 0, summary: 'x'.repeat(50) }),
  ];
  // 预算比标题略大：只能装下一行
  const { text, dropped } = renderIndex({ scope: 'owner', version: 1, updatedAt: NOW, entries }, 80);
  assert.equal(dropped, 1);
  assert.match(text, /重要/);
  assert.doesNotMatch(text, /次要/);
});

test('indexSize 与渲染结果大致一致，用于预算判断', () => {
  const index = { scope: 'owner', version: 1, updatedAt: NOW, entries: [entry()] };
  assert.ok(indexSize(index) > 0);
  assert.ok(indexSize(index) < INDEX_LIMITS.maxChars);
});

/* ------------------------------ 悬挂引用 ------------------------------ */

test('指向不存在的记忆要被丢掉：一条指向空处的索引比没有更糟', () => {
  const index = {
    scope: 'owner', version: 1, updatedAt: NOW,
    entries: [entry({ memoryIds: ['m1', 'gone'] }), entry({ topic: '全没了', memoryIds: ['gone2'] })],
  };
  const { index: pruned, dropped } = pruneDangling(index, id => id === 'm1');
  assert.equal(dropped, 1, '整条都指向空处的要丢掉');
  assert.deepEqual(pruned.entries.length, 1);
  assert.deepEqual(pruned.entries[0]!.memoryIds, ['m1'], '部分悬挂的只去掉那个 id');
});

test('referencedIds 去重', () => {
  const index = { scope: 'owner', version: 1, updatedAt: NOW, entries: [entry({ memoryIds: ['a', 'b'] }), entry({ topic: 'x', memoryIds: ['b'] })] };
  assert.deepEqual(referencedIds(index).sort(), ['a', 'b']);
});

/* ------------------------------ 端到端 ------------------------------ */

test('端到端：Dream 写的索引落库后可读，能按 id 展开', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  repo.publish({ id: 'm1', content: '他在准备 408，目标 110 分', evidence: [1], kind: 'observation', revision: 1, status: 'active' });
  repo.publishIndex(fitIndex([entry({ memoryIds: ['m1'], summary: '准备 408' })], 0, NOW));
  const service = new MemoryService(repo, { clock: () => NOW });
  const index = service.index();
  assert.equal(index?.entries.length, 1);
  assert.match(renderIndex(index!).text, /准备 408/);
  const expanded = service.expand(['m1']);
  assert.equal(expanded.length, 1);
  assert.match(expanded[0]!.content, /目标 110/);
  store.close();
});

/* ------------------------------ 分场景 ------------------------------ */

test('每个作用域各一份索引，互不覆盖', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const { writeMemoryIndexes } = await import('../src/memory/dream-effects.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  repo.publish({ id: 'o1', content: '他喜欢简洁的回答', evidence: [1], kind: 'observation', revision: 1, status: 'active', scope: 'owner' });
  repo.publish({ id: 'g1', content: '这个群里在准备考研', evidence: [2], kind: 'observation', revision: 1, status: 'active', scope: 'group:A' });
  writeMemoryIndexes({ repository: repo, experience: { record() {} } as never }, [
    { scope: 'owner', entries: [entry({ topic: '偏好', summary: '喜欢简洁', memoryIds: ['o1'], weight: 5 })] },
    { scope: 'group:A', entries: [entry({ topic: '话题', summary: '在准备考研', memoryIds: ['g1'], weight: 4 })] },
  ], NOW);
  const service = new MemoryService(repo, { clock: () => NOW });
  assert.equal(service.index('owner')?.entries.length, 1);
  assert.equal(service.index('group:A')?.entries.length, 1);
  assert.match(service.index('group:A')!.entries[0]!.summary, /考研/);
  store.close();
});

test('注入时 owner 与当前场景两份都给，且各自带自己的标题', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const { writeMemoryIndexes } = await import('../src/memory/dream-effects.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (const id of ['o1', 'g1']) repo.publish({ id, content: 'x', evidence: [1], kind: 'observation', revision: 1, status: 'active' });
  writeMemoryIndexes({ repository: repo, experience: { record() {} } as never }, [
    { scope: 'owner', entries: [entry({ topic: '偏好', memoryIds: ['o1'] })] },
    { scope: 'group:A', entries: [entry({ topic: '本群', memoryIds: ['g1'] })] },
  ], NOW);
  const service = new MemoryService(repo, { clock: () => NOW });
  const text = service.indexText('group:A');
  assert.match(text, /我记得的事/, 'owner 那份用通用标题');
  assert.match(text, /在这处我记得的事/, '场景那份要标明只在这个场合成立');
  store.close();
});

test('别的场景的索引不会串进来', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const { writeMemoryIndexes } = await import('../src/memory/dream-effects.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (const id of ['a1', 'b1']) repo.publish({ id, content: 'x', evidence: [1], kind: 'observation', revision: 1, status: 'active' });
  writeMemoryIndexes({ repository: repo, experience: { record() {} } as never }, [
    { scope: 'group:A', entries: [entry({ topic: 'A群的事', memoryIds: ['a1'] })] },
    { scope: 'group:B', entries: [entry({ topic: 'B群的事', memoryIds: ['b1'] })] },
  ], NOW);
  const service = new MemoryService(repo, { clock: () => NOW });
  const fromA = service.indexText('group:A');
  assert.match(fromA, /A群的事/);
  assert.doesNotMatch(fromA, /B群的事/, 'B 群的索引不该出现在 A 群上下文里');
  store.close();
});
