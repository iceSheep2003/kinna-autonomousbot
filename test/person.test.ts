import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTRAIT_MAX, displayName, rememberName, renderPerson, renderPersonCard, upsertPerson, type Person } from '../src/memory/person.js';
import { observe, trackPerson } from '../src/memory/person-observer.js';

const NOW = 1_800_000_000_000;
const person = (overrides: Partial<Person> = {}): Person => ({
  userId: '3485823460', names: ['牢e'], portraitEvidence: [], notes: [],
  firstSeenAt: NOW, lastSeenAt: NOW, groups: [], ...overrides,
});

/* ------------------------------ 别名 ------------------------------ */

test('同一个人有多个称呼：群名片会变，名字只增不减', () => {
  let p = person();
  p = rememberName(p, 'ending_walker03');
  p = rememberName(p, '群友3460');
  assert.deepEqual(p.names, ['牢e', 'ending_walker03', '群友3460']);
});

test('同名不重复加', () => {
  const p = rememberName(person(), '牢e');
  assert.deepEqual(p.names, ['牢e']);
});

test('调用时用最近一次见到的称呼，但第一个仍留着', () => {
  let p = person();
  p = rememberName(p, '新建的群名片');
  assert.equal(displayName(p), '新建的群名片', '人会改群名片，叫旧名字显得没在听');
  assert.equal(p.names[0], '牢e', '但最开始的认识还在');
});

test('系统生成的占位名不用来称呼人：叫「牢e」不叫「群友3460」', () => {
  // 真实数据里的顺序就是：先认识时的名字，后来自动生成的占位名
  const p = person({ names: ['ending_walker03', '牢e', '群友3460'] });
  assert.equal(displayName(p), '牢e', '占位名不是人给自己起的名字');
});

test('只有占位名时才退回去用它', () => {
  assert.equal(displayName(person({ names: ['群友3460'] })), '群友3460');
});

test('别名有上限，且不会把第一个挤掉', () => {
  let p = person();
  for (let i = 0; i < 20; i++) p = rememberName(p, `名字${i}`);
  assert.equal(p.names.length, 12);
  assert.equal(p.names[0], '牢e', '本名/最早的认识要留住');
  assert.equal(p.names.at(-1), '名字19', '最新的也要留住');
});

/* ------------------------------ 观察 ------------------------------ */

test('从消息里提取人物线索；缺 userId 的一律不记（会张冠李戴）', () => {
  assert.deepEqual(observe({ userId: 'u1', nickname: '牢e', groupId: 'g1' }), { userId: 'u1', name: '牢e', group: 'g1' });
  assert.deepEqual(observe({ nickname: '只有名字' }), {}, '没有 userId 不是可识别的人');
  assert.deepEqual(observe({ userId: 'u1' }), {}, '没有名字也不记');
  assert.deepEqual(observe('不是对象'), {});
});

test('观察到就更新，并记下在哪个群见过', () => {
  const saved: Person[] = [];
  const store = { get: () => undefined, save: (p: Person) => { saved.push(p); } };
  assert.equal(trackPerson(store, { userId: 'u1', name: '牢e', group: 'g1' }, NOW), true, '新认识的人');
  const existing = person({ userId: 'u1' });
  const store2 = { get: () => existing, save: (p: Person) => { saved.push(p); } };
  trackPerson(store2, { userId: 'u1', name: '新名片', group: 'g2' }, NOW + 1000);
  const updated = saved.at(-1)!;
  assert.ok(updated.names.includes('新名片'));
  assert.deepEqual(updated.groups, ['g2'], '跨群仍是同一个人，群列表累加');
  assert.equal(updated.lastSeenAt, NOW + 1000);
});

/* ------------------------------ 画像 ------------------------------ */

test('没有画像时只报名字，不编内容', () => {
  assert.match(renderPerson(person()), /^- 牢e（0 条近况）$/);
});

test('有画像时渲染一句话', () => {
  assert.match(renderPerson(person({ portrait: '群里的技术担当' })), /牢e：群里的技术担当/);
});

test('人物卡片带近况和可展开的证据 id', () => {
  const card = renderPersonCard(person({ portrait: '技术担当', notes: ['最近在找实习'], portraitEvidence: ['mem-1', 'mem-2'] }));
  assert.match(card, /技术担当/);
  assert.match(card, /最近在找实习/);
  assert.match(card, /依据: mem-1,mem-2/);
});

test('画像有长度上限，避免退化成又一份事实列表', () => {
  assert.equal(PORTRAIT_MAX, 200);
  assert.ok(person({ portrait: 'x'.repeat(PORTRAIT_MAX) }).portrait!.length <= PORTRAIT_MAX);
});

test('端到端：反复见到同一个人的不同称呼，最后指向同一个人', async () => {
  const { Store } = await import('../src/infrastructure/sqlite/database.js');
  const { SqlitePeopleRepository } = await import('../src/infrastructure/sqlite/people.js');
  const store = new Store(':memory:');
  const repo = new SqlitePeopleRepository(store);
  for (const name of ['牢e', 'ending_walker03', '群友3460']) trackPerson(repo, { userId: '3485823460', name, group: 'g1' }, NOW);
  const found = repo.get('3485823460');
  assert.equal(found?.names.length, 3, '三个称呼指向同一个人');
  assert.equal(repo.list().length, 1, '不是三个人');
  store.close();
});
