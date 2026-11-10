import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoBoard } from '../src/integrations/bilibili/todo-board.js';
import { describeDay, localDay, remaining, rollover, type TodoDay } from '../src/integrations/bilibili/todo.js';

/** 一天 = 本地日期；北京时间 2026-11-10 12:00 */
const NOON = Date.UTC(2026, 10, 10, 4, 0, 0);

function board(now: () => number, initial?: TodoDay, quota = 3) {
  let stored = initial;
  const reminders: Array<{ kind: string; data: unknown }> = [];
  const b = new TodoBoard({
    store: {
      read: () => stored, save: day => { stored = day; }, history: () => (stored ? [stored] : []),
      lastRemindedAt: () => 0, markReminded: () => {},
    },
    notify: (kind, data) => { reminders.push({ kind, data }); },
    now, quota,
  });
  return { board: b, reminders, get stored() { return stored; } };
}

test('按本地时区算日期：北京时间早上 7 点仍是当天，不是前一天', () => {
  const early = Date.UTC(2026, 10, 9, 23, 0, 0); // 北京 11-10 07:00
  assert.equal(localDay(early, 'Asia/Shanghai'), '2026-11-10');
});

test('新的一天自动生成配额条目；同一天重复读不重复生成', () => {
  const f = board(() => NOON);
  const first = f.board.today();
  assert.equal(first.day, '2026-11-10');
  assert.equal(first.items.filter(item => item.status === 'pending').length, 3);
  assert.equal(f.board.today().items.length, 3);
});

test('跨日结算：昨天没做完的记为 missed，并通知 self', () => {
  const yesterday: TodoDay = { day: '2026-11-09', items: [
    { id: '2026-11-09#1', status: 'done', outcome: 'rpid:1' },
    { id: '2026-11-09#2', status: 'pending' },
    { id: '2026-11-09#3', status: 'skipped', outcome: '没找到值得评论的' },
  ] };
  const f = board(() => NOON, yesterday);
  const today = f.board.today();
  assert.equal(today.day, '2026-11-10');
  assert.equal(f.stored?.day, '2026-11-10');
  assert.ok(f.reminders.some(item => item.kind === 'bilibili.todo.missed'));
});

test('剩余额度：完成和主动跳过都算消耗，missed 不算', () => {
  const day: TodoDay = { day: '2026-11-10', items: [
    { id: 'a', status: 'done' }, { id: 'b', status: 'skipped' }, { id: 'c', status: 'missed' } ] };
  assert.equal(remaining(day, 3), 1);
});

test('完成必须带回执；没有回执不算完成', () => {
  const f = board(() => NOON);
  const today = f.board.today();
  const id = today.items[0]!.id;
  assert.equal(f.board.complete(id, ''), false);
  assert.equal(f.board.complete(id, 'rpid:123'), true);
  assert.equal(f.board.today().items[0]!.status, 'done');
  assert.equal(f.board.today().items[0]!.outcome, 'rpid:123');
});

test('已完成的条目不能再跳过；跳过要写理由', () => {
  const f = board(() => NOON);
  const id = f.board.today().items[0]!.id;
  f.board.complete(id, 'rpid:9');
  assert.equal(f.board.skip(id, '想做别的'), false);
  assert.equal(f.board.skip(f.board.today().items[1]!.id, '今天没找到值得说的'), true);
});

test('claim 把一条待办绑定到视频；配额用完后返回 undefined', () => {
  const f = board(() => NOON);
  const claimed = f.board.claim('BV1xx4y1x7xx');
  assert.equal(claimed?.bvid, 'BV1xx4y1x7xx');
  f.board.complete(claimed!.id, 'rpid:1');
  const second = f.board.claim('BV1xx4y1x7xx');
  assert.ok(second);
  f.board.complete(second!.id, 'rpid:2');
  const third = f.board.claim('BV1xx4y1x7xx');
  f.board.complete(third!.id, 'rpid:3');
  assert.equal(f.board.claim('BV1xx4y1x7xx'), undefined);
});

test('提醒：做完就不打扰；没做完时把「还差几条」放进 self inbox', () => {
  const f = board(() => NOON);
  const result = f.board.remind();
  assert.equal(result.remaining, 3);
  assert.equal(result.sent, true);
  const payload = f.reminders.find(item => item.kind === 'bilibili.todo')?.data as { summary: string };
  assert.match(payload.summary, /还差 3 条/);
  for (const item of f.board.today().items) f.board.complete(item.id, 'rpid:1');
  assert.equal(f.board.remind().sent, false, '做完就不该再提醒');
});

test('rollover 是纯函数：不改原对象，返回结算后的昨天与今天', () => {
  const day: TodoDay = { day: '2026-11-10', items: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'done' }] };
  const rolled = rollover(day, '2026-11-11', 2);
  assert.equal(day.items[0]!.status, 'pending', '原对象不应被改动');
  assert.equal(rolled.settled.items[0]!.status, 'missed');
  assert.equal(rolled.missed, 1);
  assert.equal(rolled.fresh.items.length, 2);
});

test('给 self 的话读起来像提醒而不是催促', () => {
  const day: TodoDay = { day: '2026-11-10', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }] };
  assert.match(describeDay(day, 2), /还差 1 条/);
  const finished: TodoDay = { day: '2026-11-10', items: [{ id: 'a', status: 'done' }] };
  assert.match(describeDay(finished, 1), /今天的份做完了/);
});

test('每日任务看板接口：未配置时 404，配置后返回今天的进度', async () => {
  const { createServer } = await import('../src/infrastructure/http/server.js');
  const TOKEN = 'test-secret-at-least-24-chars';
  const headers = { authorization: `Bearer ${TOKEN}` };
  const base = { self: () => ({}), list: () => [], experiences: () => [], turns: () => [], jobs: () => [], capabilities: () => [], ingest: () => ({ duplicate: false }) };
  const without = createServer(base, TOKEN);
  try { assert.equal((await without.inject({ url: '/v1/bilibili/todo', headers })).statusCode, 404); } finally { await without.close(); }
  const f = board(() => NOON);
  const withTodo = createServer({ ...base, bilibiliTodo: () => f.board }, TOKEN);
  try {
    assert.equal((await withTodo.inject({ url: '/v1/bilibili/todo' })).statusCode, 401);
    const view = await withTodo.inject({ url: '/v1/bilibili/todo', headers });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().quota, 3);
    assert.equal(view.json().remaining, 3);
    const remind = await withTodo.inject({ method: 'POST', url: '/v1/bilibili/todo/remind', headers });
    assert.equal(remind.json().sent, true);
  } finally { await withTodo.close(); }
});

test('self 的指令里写了日常流程，且强调「只有拿到回执才算做完」', async () => {
  const { selfInstructions } = await import('../src/self/session.js');
  const { defaultPersonality } = await import('../src/shared/persona.js');
  const text = selfInstructions(defaultPersonality);
  assert.match(text, /每天都要做的/);
  assert.match(text, /先看一眼今天做到哪了/);
  assert.match(text, /只有真的拿到了平台回执才算做完/);
  // 不硬编码具体平台：self 的指令不该出现 bilibili 字样，避免把某个平台写进人格层。
  assert.doesNotMatch(text, /bilibili/i);
});
