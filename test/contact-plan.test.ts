import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactPlanSchema, planContact, closeContact, pendingContacts, MIN_BECAUSE } from '../src/self/contacts.js';

/**
 * 「打算找谁聊聊」——由头必须是数据，不是提示词里的一句「要有由头」。
 *
 * 没有由头的主动搭话会变成「每天定时发一句在吗」，然后被踢出群。
 * 所以这里的第一道防线是：**because 不够具体就创建不出来**。
 */

const base = { target: { type: 'private' as const, id: '3485823460' }, because: '他昨天说在犹豫要不要报华师', what: '问问他最后决定没有' };

test('有具体由头的计划能建', () => {
  const plan = planContact({ ...base, now: 1000, existing: [] });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.because, base.because);
});

test('没有由头就建不出来——这是防「无缘无故私聊」的第一道门', () => {
  assert.throws(() => planContact({ target: base.target, because: '', what: base.what, now: 1000, existing: [] }), /because|由头/);
  assert.throws(() => planContact({ target: base.target, because: '想聊聊', what: base.what, now: 1000, existing: [] }), /because|由头|太短/);
});

test('由头门槛是 MIN_BECAUSE，太短就是敷衍', () => {
  assert.ok(MIN_BECAUSE >= 8, '太低的门槛等于没有门槛');
  assert.throws(() => planContact({ target: base.target, because: '想', what: '问问', now: 1000, existing: [] }));
});

test('同一个人同一件事不重复记', () => {
  const first = planContact({ ...base, now: 1000, existing: [] });
  const second = planContact({ ...base, now: 2000, existing: [first] });
  assert.equal(second.id, first.id, '重复计划应该合并到原来那条');
});

test('标记完成要写结果——没结果的完成等于没做', () => {
  const plan = planContact({ ...base, now: 1000, existing: [] });
  const done = closeContact({ plan, result: 'replied', note: '他说决定不报了', now: 2000 });
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'replied');
  assert.equal(done.doneAt, 2000);
});

test('被无视也算结果，而且要能记下来——不然会一直追着同一个人', () => {
  const plan = planContact({ ...base, now: 1000, existing: [] });
  const done = closeContact({ plan, result: 'ignored', note: '', now: 2000 });
  assert.equal(done.result, 'ignored');
});

test('只列还开着的计划，有上限', () => {
  const plans = Array.from({ length: 6 }, (_, i) => ({
    ...planContact({ ...base, target: { type: 'private' as const, id: String(i) }, now: 1000, existing: [] }), id: `p${i}`,
  }));
  assert.equal(pendingContacts(plans, 3).length, 3);
});

test('schema 拒绝空由头', () => {
  assert.equal(ContactPlanSchema.safeParse({ ...base, because: '', id: 'x', status: 'planned', createdAt: 1 }).success, false);
});
