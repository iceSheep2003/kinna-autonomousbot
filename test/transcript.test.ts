import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSpeaker, toTranscriptMessage, transcriptSize, transcriptWindow } from '../src/execution/transcript.js';
import type { Experience } from '../src/memory/types.js';

/** 入站事件在 inbox 里被包了一层：{ source, data: <事件体> }。 */
function inbound(seq: number, body: Record<string, unknown>, kind = 'qq.message'): Experience {
  return { seq, source: 'qq', kind, data: { source: 'qq', data: body }, at: 0 } as Experience;
}
function said(seq: number, text: string, tool = 'qq.send_message'): Experience {
  return { seq, source: 's', kind: 'tool.result', data: { name: tool, input: { text }, result: { messageIds: ['9'] } }, at: 0 } as Experience;
}

test('群友说的话：昵称拼进内容，不用模型自己解结构', () => {
  const message = toTranscriptMessage(inbound(7, { nickname: '牢e', text: '华师那个保研是校企合作' }))!;
  assert.equal(message.role, 'user');
  assert.equal(message.content, '牢e: 华师那个保研是校企合作');
  assert.equal(message.seq, 7, 'seq 要带上：reflect 需要它当证据');
});

test('入站事件被包了一层也要能解出来——不解就是「完全不记得群友说过什么」', () => {
  // row.data = { source, data: { nickname, text } }，昵称在第二层
  const wrapped = { seq: 1, kind: 'qq.message', data: { source: 'qq', data: { nickname: 'A', text: '你好' } }, at: 0 } as Experience;
  assert.equal(toTranscriptMessage(wrapped)?.content, 'A: 你好');
});

test('平台的 kind 前缀不影响识别（qq.message / bilibili.comment）', () => {
  assert.ok(toTranscriptMessage(inbound(1, { nickname: 'A', text: 'x' }, 'qq.message')));
  assert.ok(toTranscriptMessage(inbound(1, { nickname: 'A', text: 'x' }, 'message')));
  assert.ok(toTranscriptMessage(inbound(1, { nickname: 'A', text: 'x' }, 'bilibili.message')));
});

test('自己说的话：从工具入参还原，role=assistant 且不加昵称前缀', () => {
  const mine = toTranscriptMessage(said(2, '你好呀'))!;
  assert.equal(mine.role, 'assistant');
  assert.equal(mine.content, '你好呀');
});

test('发送类工具必须按后缀匹配——写死 send_message 会漏掉 qq.send_message', () => {
  // 漏掉的后果是模型以为自己没说过话，于是又发一遍（实测发两次）
  assert.ok(toTranscriptMessage(said(1, 'x', 'qq.send_message')));
  assert.ok(toTranscriptMessage(said(1, 'x', 'send_message')));
  assert.ok(toTranscriptMessage(said(1, 'x', 'bilibili.draft_comment')));
  // 非发送类工具不生成 assistant 消息
  assert.equal(toTranscriptMessage({ seq: 1, kind: 'tool.result', data: { name: 'web.fetch', input: {}, result: {} }, at: 0 } as Experience), undefined);
});

test('不是对话的记录跳过：笔记、Dream 日志不占上下文', () => {
  assert.equal(toTranscriptMessage({ seq: 1, kind: 'note', data: { text: '随手记' }, at: 0 } as Experience), undefined);
  assert.equal(toTranscriptMessage({ seq: 1, kind: 'dream.completed', data: {}, at: 0 } as Experience), undefined);
  assert.equal(transcriptSize([inbound(1, { nickname: 'A', text: 'x' }), { seq: 2, kind: 'note', data: {}, at: 0 } as Experience]), 1);
});

test('按字符预算从最新往前取，一条不切半', () => {
  const rows = [inbound(1, { nickname: 'A', text: '一'.repeat(20) }), inbound(2, { nickname: 'B', text: '二'.repeat(20) })];
  const all = transcriptWindow(rows, 6000);
  assert.equal(all.length, 2);
  // 预算只够最后一条：前面那条整条掉，而不是被截断
  const narrow = transcriptWindow(rows, 25);
  assert.equal(narrow.length, 1);
  assert.match(narrow[0]!.content, /^B: /, '保留的是最新的那条');
});

test('空昵称/空文本不生成消息，不产生「某人: 」这种空壳', () => {
  assert.equal(toTranscriptMessage(inbound(1, { text: '有文本没昵称' }))?.content, '某人: 有文本没昵称');
  assert.equal(toTranscriptMessage(inbound(1, { nickname: 'A', text: '  ' })), undefined);
  assert.equal(toTranscriptMessage(inbound(1, { nickname: 'A' })), undefined);
});

test('端到端：一段群聊投影成 [群友, 我, 群友] 的正确顺序', () => {
  const rows = [
    inbound(1, { nickname: '牢e', text: '华师那个保研是校企合作' }),
    said(2, '听着有点风险'),
    inbound(3, { nickname: '凯哥', text: '确实' }),
  ];
  const transcript = transcriptWindow(rows, 6000);
  assert.deepEqual(transcript.map(m => m.role), ['user', 'assistant', 'user']);
  assert.ok(transcript[0]!.content.startsWith('牢e: '));
  assert.ok(transcript[1]!.content.startsWith('听着有点风险'));
  assert.ok(transcript[2]!.content.startsWith('凯哥: '));
  assert.deepEqual(transcript.map(m => m.seq), [1, 2, 3]);
});

/* ------------------------------ 当前说话人 ------------------------------ */

test('从最新一条入站消息认出说话人：靠 QQ 号，不靠昵称', () => {
  const rows = [
    inbound(1, { nickname: '旧名片', text: '之前说的', userId: '3485823460' }),
    said(2, '我回了一句'),
    inbound(3, { nickname: '新名片', text: '现在说的', userId: '1774905612' }),
  ];
  const who = currentSpeaker(rows);
  assert.equal(who.userId, '1774905612', '取最后说话的那个，不是第一个');
  assert.equal(who.name, '新名片');
});

test('换群名片后仍是同一个人：认号不认名字', () => {
  const before = currentSpeaker([inbound(1, { nickname: '牢e', text: 'x', userId: '3485823460' })]);
  const after = currentSpeaker([inbound(2, { nickname: 'ending_walker03', text: 'y', userId: '3485823460' })]);
  assert.equal(before.userId, after.userId, '两个昵称指向同一个 QQ 号');
  assert.notEqual(before.name, after.name);
});

test('只有自己说过话时认不出说话人（返回空，不编一个）', () => {
  assert.deepEqual(currentSpeaker([said(1, '只有我说的')]), {});
  assert.deepEqual(currentSpeaker([]), {});
});

test('transcript 里每条入站消息都带说话人，assistant 的不带', () => {
  const transcript = transcriptWindow([
    inbound(1, { nickname: '牢e', text: '你好', userId: 'u1' }),
    said(2, '你也好'),
  ], 6000);
  assert.equal(transcript[0]!.userId, 'u1');
  assert.equal(transcript[0]!.name, '牢e');
  assert.equal(transcript[1]!.userId, undefined, '自己说的话没有 QQ 号');
});
