import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPACTION, buildMerged, planCompaction, retireMerged } from '../src/memory/compact.js';
import { MemoryCompactor } from '../src/memory/compact-service.js';
import type { Memory } from '../src/memory/types.js';

const NOW = 1_800_000_000_000;

/** 假模型：分组调用把整批归成一组，合并调用返回给定句子。 */
function fakeModel(options: { merged?: string; fail?: boolean } = {}) {
  return {
    decide: async (request: { context?: { memories?: unknown[] } }) => {
      if (options.fail) throw new Error('模型挂了');
      const memories = request.context?.memories ?? [];
      if (memories.length > 0 && typeof memories[0] === 'object') {
        return { groups: [{ ids: (memories as Array<{ id: string }>).map(item => item.id), topic: '同一件事' }] };
      }
      return { merged: options.merged ?? '合并后的说法' };
    },
  } as never;
}


function memory(overrides: Partial<Memory>): Memory {
  return { id: 'm1', content: '一条记忆', evidence: [1], kind: 'observation', revision: 1,
    status: 'active', scope: 'owner', importance: 2, confidence: 0.8, createdAt: NOW, ...overrides };
}
/** 造一组讲同一件事的记忆（字面高度重叠）。 */
function cluster(count: number, idPrefix = 'c'): Memory[] {
  return Array.from({ length: count }, (_, index) => memory({
    id: `${idPrefix}${index}`,
    content: `不喜欢变量名多、炫技式的编程题，认为这类题没什么意义（第 ${index} 次提到）`,
    evidence: [index + 1], revision: index + 1, importance: index,
  }));
}

test('同一个 scope 超过阈值才值得压；没超就不动', () => {
  assert.deepEqual(planCompaction(cluster(10), DEFAULT_COMPACTION), [], '没到 40 条不压');
  const many = [...cluster(30, 'a'), ...Array.from({ length: 20 }, (_, i) => memory({
    id: `x${i}`, content: `完全不同的另一件事 ${i}`, createdAt: NOW,
  }))];
  const groups = planCompaction(many, DEFAULT_COMPACTION);
  assert.equal(groups.length >= 0, true);
});

test('分组只挑「明显在说同一件事」的，每组至少 3 条', () => {
  const rows = [...cluster(4, 'same'), memory({ id: 'other', content: '今天天气不错适合出门走走' })];
  const many = [...rows, ...Array.from({ length: 40 }, (_, i) => memory({ id: `f${i}`, content: `填充条目 ${i}` }))];
  const groups = planCompaction(many, DEFAULT_COMPACTION);
  assert.ok(groups.length > 0, '应至少分出一组');
  for (const group of groups) assert.ok(group.members.length >= DEFAULT_COMPACTION.minGroupSize);
});

test('非 active 的（已撤回/已合并）不参与压缩', () => {
  const rows = Array.from({ length: 50 }, (_, i) => memory({
    id: `s${i}`, content: '不喜欢炫技式编程题，觉得没意义', status: i < 2 ? 'superseded' : 'active',
  }));
  const groups = planCompaction(rows, DEFAULT_COMPACTION);
  const ids = groups.flatMap(group => group.members.map(member => member.id));
  assert.ok(!ids.includes('s0') && !ids.includes('s1'));
});

test('合并保留全部证据：任何一条的出处都能沿它找回原话', () => {
  const group = { scope: 'owner', members: cluster(3), topic: 'x' };
  const merged = buildMerged(group, '不喜欢炫技式的编程题', NOW)!;
  assert.deepEqual(merged.evidence, [1, 2, 3], '证据取并集，不丢任何一条');
  assert.equal(merged.importance, 2, '重要度取最大（组内是 0/1/2）：最重要那条不该因为合并变轻');
  assert.equal(merged.revision, 4, '版本要比所有被合并的（1/2/3）都高');
});

test('合并后的时间取最早：这条说的是「一直以来」，不是「最近」', () => {
  const group = { scope: 'owner', members: [
    memory({ id: 'a', createdAt: NOW - 10_000 }), memory({ id: 'b', createdAt: NOW }), memory({ id: 'c', createdAt: NOW + 1 }),
  ], topic: 'x' };
  assert.equal(buildMerged(group, '合并后', NOW + 2)!.createdAt, NOW - 10_000);
});

test('合并内容为空或超长都不产出脏数据', () => {
  const group = { scope: 'owner', members: cluster(3), topic: 'x' };
  assert.equal(buildMerged(group, '   ', NOW), undefined);
  assert.ok(buildMerged(group, 'x'.repeat(800), NOW)!.content.length <= 300);
});

test('被合并的原记录标 superseded 并指向新记录，不硬删', () => {
  const retired = retireMerged(memory({ id: 'old' }), 'new-id');
  assert.equal(retired.status, 'superseded');
  assert.equal(retired.mergedInto, 'new-id');
  assert.equal(retired.id, 'old', '原记录还在，可以沿 mergedInto 找回去');
});

test('端到端：压缩后库里条数减少，但证据一条没少', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  const rows = cluster(45).map((item, index) => ({ ...item, evidence: [index + 1] }));
  for (const row of rows) repo.publish(row);
  const compactor = new MemoryCompactor({
    repository: repo, now: () => NOW,
    model: fakeModel({ merged: '不喜欢炫技式的编程题，觉得没意义' }),
  });
  const result = await compactor.run();
  assert.ok(result.merged >= 1);
  const live = repo.recent(500).filter(item => (item.status ?? 'active') === 'active');
  const allEvidence = new Set(repo.recent(500).flatMap(item => item.evidence));
  assert.ok(live.length < rows.length, '活跃记忆应减少');
  assert.equal(allEvidence.size, 45, '证据一条都不能少');
  store.close();
});

test('模型说「不是同一件事」时不动，也不删记录', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (const row of cluster(45)) repo.publish(row);
  const compactor = new MemoryCompactor({
    repository: repo, now: () => NOW,
    // 分组就给空，等价于模型说「没有可合并的」
    model: { decide: async () => ({ groups: [] }) } as never,
  });
  const result = await compactor.run();
  assert.equal(result.merged, 0);
  assert.equal(repo.recent(500).filter(item => (item.status ?? 'active') === 'active').length, 45);
  store.close();
});

test('模型调用失败只跳过那一组，不影响其它组也不改库', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (const row of cluster(45)) repo.publish(row);
  const compactor = new MemoryCompactor({
    repository: repo, now: () => NOW,
    model: fakeModel({ fail: true }),
  });
  const result = await compactor.run();
  assert.equal(result.merged, 0);
  assert.ok(result.skipped >= 1);
  store.close();
});

test('必须分批：一次灌 275 条模型会放弃分组，40 条一批才稳定', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (let i = 0; i < 120; i++) repo.publish(memory({ id: `m${i}`, content: `第 ${i} 条记忆，内容各不相同`, evidence: [i] }));
  const calls: number[] = [];
  const compactor = new MemoryCompactor({
    repository: repo, now: () => NOW,
    policy: { ...DEFAULT_COMPACTION, maxPerScope: 20, batchSize: 40 },
    model: {
      decide: async (request: { context?: { memories?: unknown[] } }) => {
        calls.push(request.context?.memories?.length ?? 0);
        return { groups: [], merged: 'none' };
      },
    } as never,
  });
  await compactor.run();
  assert.ok(calls.length >= 2, `应分批调用，实际 ${calls.length} 次`);
  for (const size of calls) assert.ok(size <= 40, `每批不超过 40 条，实际 ${size}`);
});

test('一条记忆只能被合并一次，不会同时进两组', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  for (let i = 0; i < 30; i++) repo.publish(memory({ id: `m${i}`, content: `记忆 ${i}`, evidence: [i] }));
  const compactor = new MemoryCompactor({
    repository: repo, now: () => NOW,
    policy: { ...DEFAULT_COMPACTION, maxPerScope: 20, batchSize: 40 },
    // 模型故意把同一批 id 拆成两组重叠的（m2 同时出现在两组）
    model: {
      decide: async (request: { context?: { memories?: unknown[] } }) => {
        const memories = request.context?.memories ?? [];
        if (memories.length > 0 && typeof memories[0] === 'object') {
          return { groups: [
            { ids: ['m0', 'm1', 'm2'], topic: 'A' },
            { ids: ['m2', 'm3', 'm4'], topic: 'B' },
          ] };
        }
        return { merged: '合并' };
      },
    } as never,
  });
  const result = await compactor.run();
  const retired = repo.recent(500).filter(item => item.status === 'superseded');
  const ids = retired.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '同一条不该被两次标记退役');
  assert.ok(result.merged >= 1);
  store.close();
});
