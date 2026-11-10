import test from 'node:test';
import assert from 'node:assert/strict';
import { closeTodo, openTodo, openTodos, TODO_CAP, type SelfTodo } from '../src/self/todos.js';
import { isPrivateHost, readableText } from '../src/integrations/web-fetch.js';

const NOW = 1_800_000_000_000;

test('记一条待办：来源和由头都留下，以后能想起为什么记', () => {
  const { todo, duplicate } = openTodo({ text: '弄清那个 408 复习安排', source: 'bilibili: BV1Lo4M6nEF2',
    reason: '刷到视频，板书里提到每天一套，想知道具体怎么排', now: NOW, existing: [], id: 't1' });
  assert.equal(duplicate, false);
  assert.equal(todo.status, 'open');
  assert.equal(todo.source, 'bilibili: BV1Lo4M6nEF2');
  assert.match(todo.reason ?? '', /每天一套/);
});

test('同一件事重复记会被合并，不会刷出一堆一样的条目', () => {
  const first = openTodo({ text: '查一下 PV 大题怎么练', source: 'bilibili: BV1', now: NOW, existing: [], id: 't1' }).todo;
  const again = openTodo({ text: '查一下PV大题怎么练！', source: 'qq: 群1', now: NOW + 1000, existing: [first], id: 't2' });
  assert.equal(again.duplicate, true);
  assert.equal(again.todo.id, 't1', '标点/空白的差异不该算新条目');
});

test('划掉必须写结果；空着不算完成', () => {
  const todo: SelfTodo = { id: 't1', text: 'x', source: 's', status: 'open', createdAt: NOW };
  assert.equal(closeTodo(todo, '   ', NOW), undefined);
  const done = closeTodo(todo, '看完了，结论是……', NOW)!;
  assert.equal(done.status, 'done');
  assert.equal(done.outcome, '看完了，结论是……');
  // 已经关过的不再重复关
  assert.equal(closeTodo(done, '再来一次', NOW), undefined);
});

test('放弃也要写原因，且和完成区分开', () => {
  const todo: SelfTodo = { id: 't1', text: 'x', source: 's', status: 'open', createdAt: NOW };
  const dropped = closeTodo(todo, '后来发现这事不重要', NOW, 'dropped')!;
  assert.equal(dropped.status, 'dropped');
});

test('只列还开着的，旧的排前面（新想法不该把旧的一直压下去）', () => {
  const todos: SelfTodo[] = [
    { id: 'a', text: 'a', source: 's', status: 'open', createdAt: NOW + 300 },
    { id: 'b', text: 'b', source: 's', status: 'done', createdAt: NOW, outcome: 'x' },
    { id: 'c', text: 'c', source: 's', status: 'open', createdAt: NOW + 100 },
  ];
  assert.deepEqual(openTodos(todos).map(todo => todo.id), ['c', 'a']);
  assert.equal(TODO_CAP > 0, true);
});

test('网页抓取拒绝内网地址，防止被当成访问宿主内网的跳板', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1', 'foo.local']) {
    assert.equal(isPrivateHost(host), true, `${host} 应被拒绝`);
  }
  for (const host of ['www.bilibili.com', '8.8.8.8', 'example.com']) {
    assert.equal(isPrivateHost(host), false, `${host} 应放行`);
  }
});

test('网页正文提取：去掉脚本样式和标签，保留标题', () => {
  const html = '<html><head><title>标题</title><style>x{}</style></head><body><script>alert(1)</script><p>第一段</p><p>第二段</p></body></html>';
  const text = readableText(html);
  assert.match(text, /^# 标题/);
  assert.match(text, /第一段 第二段/);
  assert.doesNotMatch(text, /alert|<p>|x\{\}/);
});
