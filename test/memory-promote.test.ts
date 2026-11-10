import test from 'node:test';
import assert from 'node:assert/strict';
import { PROMOTION_PROMPT, buildPromotion, describeForPromotion, refusePromotion } from '../src/memory/promote.js';
import type { Memory } from '../src/memory/types.js';

const NOW = 1_800_000_000_000;

function memory(overrides: Partial<Memory> = {}): Memory {
  return { id: 'm1', content: '一条记忆', evidence: [1], kind: 'observation', revision: 1, scope: 'group:A', ...overrides };
}

test('判据是写给模型看的，不是一条人间审批流', () => {
  const prompt = PROMOTION_PROMPT;
  // 必须给模型明确的「什么该提、什么不该提」
  assert.match(prompt, /稳定偏好或看法/);
  assert.match(prompt, /一次性的安排/);
  assert.match(prompt, /这个群里发生的事/);
  assert.match(prompt, /边界和禁忌/);
  // 必须给出方向：宁可少提
  assert.match(prompt, /宁可少提，不可错搬/);
  // 不该出现「等人审核」这类措辞——系统是自运行的
  assert.doesNotMatch(prompt, /人工审核|等待确认|审核通过/);
});

test('描述里带上 scope：模型得知道这条现在挂在哪才能判断该不该提', () => {
  const text = describeForPromotion(memory({ scope: 'group:330707267', factType: 'preference', content: '希望回答更有人味' }));
  assert.match(text, /group:330707267/);
  assert.match(text, /preference/);
  assert.match(text, /希望回答更有人味/);
});

test('结构上讲不通的提升直接拦下：已经在通用层、bot 状态、过期、非 active', () => {
  assert.match(refusePromotion(memory({ scope: 'owner' }), NOW) ?? '', /已经在通用层/);
  assert.match(refusePromotion(memory({ scope: 'bot:self' }), NOW) ?? '', /不往通用层搬/);
  assert.match(refusePromotion(memory({ expiresAt: NOW - 1 }), NOW) ?? '', /过期/);
  assert.match(refusePromotion(memory({ status: 'candidate' }), NOW) ?? '', /候选池/);
  assert.equal(refusePromotion(memory(), NOW), undefined, '正常场景记忆应放行');
  assert.match(refusePromotion(undefined, NOW) ?? '', /没有这条记忆/);
});

test('拦截只针对「结构上说不通」，不替模型判断内容该不该通用', () => {
  // 一条明显该留在原处的记忆，结构检查是放行的——判断交给模型。
  const oneOff = memory({ content: '玩家计划在国庆中秋休息13天来放松身体', factType: 'preference' });
  assert.equal(refusePromotion(oneOff, NOW), undefined);
});

test('提升是复制到 owner 并升版本，保留原记录：判断错了还能退回', () => {
  const original = memory({ id: 'm1', revision: 3, scope: 'group:A', content: '希望回答更有人味' });
  const promoted = buildPromotion(original, '这是稳定的偏好', NOW);
  assert.equal(promoted.scope, 'owner');
  assert.equal(promoted.revision, 4);
  assert.equal(promoted.updatedAt, NOW);
  assert.notEqual(promoted.id, original.id, '换 id，避免覆盖原记录');
  assert.equal(original.scope, 'group:A', '原记录不动');
});

test('为什么提升会跟着记忆留下来，并保留来源线索', () => {
  const promoted = buildPromotion(memory({ content: '希望回答更有人味' }), '跨场合都成立', NOW);
  assert.match(promoted.content, /跨场合都成立/);
  assert.match(promoted.sourceEventId ?? '', /promoted-from:group:A/);
});

test('提升后的内容仍受长度上限约束，不会因为备注撑爆', () => {
  const promoted = buildPromotion(memory({ content: 'x'.repeat(300) }), 'y'.repeat(200), NOW);
  assert.ok(promoted.content.length <= 300);
});

test('端到端：提升后另一个群也能读到，原记录还在（判断错了能退）', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  const service = new MemoryService(repo, { clock: () => NOW });

  // 一条只存在于 A 群的偏好
  repo.publish({ id: 'p1', content: '用户希望回答更有人味', evidence: [1], kind: 'strategy', revision: 1,
    scope: 'group:A', factType: 'preference', status: 'active', createdAt: NOW, updatedAt: NOW });

  // 提升前：B 群看不到
  const before = service.context({ query: '回答 人味', limit: 10, now: NOW, scope: 'group:B' });
  assert.equal([...before.general, ...before.scoped].length, 0, 'B 群不该看到 A 群的记忆');

  // 模型自己决定提升（没有人审核）
  assert.deepEqual(service.promote('p1', '这是稳定的偏好，换哪个群都成立', NOW), { ok: true });

  // 提升后：B 群能读到，而且落在通用层
  const after = service.context({ query: '回答 人味', limit: 10, now: NOW, scope: 'group:B' });
  assert.equal(after.general.length, 1, '提升后应出现在通用层');
  assert.match(after.general[0]!.fact, /更有人味/);
  // 原记录仍在 A 群，可以退回
  assert.equal(repo.get('p1')?.scope, 'group:A');
  store.close();
});

test('端到端：重复提升同一条会被结构检查挡住，不会堆出一堆副本', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqliteMemoryRepository } = await import('../src/infrastructure/sqlite/memory.js');
  const { MemoryService } = await import('../src/memory/service.js');
  const store = new Store(':memory:');
  const repo = new SqliteMemoryRepository(store);
  const service = new MemoryService(repo, { clock: () => NOW });
  repo.publish({ id: 'p1', content: '偏好一', evidence: [1], kind: 'strategy', revision: 1,
    scope: 'group:A', factType: 'preference', status: 'active', createdAt: NOW, updatedAt: NOW });
  assert.equal(service.promote('p1', '通用', NOW).ok, true);
  const again = service.promote('p1', '再来一次', NOW);
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /已经提升过/);
  store.close();
});
