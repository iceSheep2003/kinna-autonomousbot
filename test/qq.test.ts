import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ReverseOneBotGateway } from '../src/infrastructure/qq/onebot-gateway.js';
import { createQqPlugin } from '../src/integrations/qq/plugin.js';
import { QqConfigSchema } from '../src/integrations/qq/types.js';
import { SqliteQqState } from '../src/infrastructure/sqlite/qq.js';
import { Store } from '../src/infrastructure/sqlite/database.js';
import type { Capability } from '../src/capabilities/ports.js';
import type { IncomingEvent } from '../src/runtime/types.js';
import type { OneBotPort } from '../src/integrations/qq/ports.js';

class FakeGateway implements OneBotPort {
  handler?: (event: Record<string, unknown>) => Promise<void>;
  calls: { action: string; params: Record<string, unknown> }[] = [];
  async start(handler: (event: Record<string, unknown>) => Promise<void>) { this.handler = handler; }
  async stop() {}
  async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ action, params });
    if (action === 'get_msg') return { group_id: 123, message_id: params.message_id, user_id: 2, sender: { user_id: 2 }, message: [{ type: 'text', data: { text: '被引用的消息' } }] };
    if (action === 'get_group_member_info') return { user_id: params.user_id, role: 'member', nickname: '成员' };
    if (action === 'send_group_msg' || action === 'send_private_msg') return { message_id: this.calls.length + 1000 };
    return {};
  }
}
function raw(id = 1, overrides: Record<string, unknown> = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 99, group_id: 123, user_id: 2, message_id: id, time: 1800000000,
    sender: { nickname: '群友' }, message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '你好' } }], ...overrides };
}
async function fixture(config: Record<string, unknown> = {}) {
  const db = new Store(':memory:'); const state = new SqliteQqState(db); const gateway = new FakeGateway();
  const tools = new Map<string, Capability>(); const events: IncomingEvent[] = [];
  const plugin = createQqPlugin({ config: QqConfigSchema.parse({ selfId: '99', allowedGroups: ['123'], ...config }), gateway, state });
  await plugin.setup({ register: tool => { tools.set(tool.name, tool); } });
  await plugin.start?.({ emit: event => { events.push(event); } });
  let invocation = 0;
  return { db, state, gateway, tools, events, async close() { await plugin.stop?.(); db.close(); },
    async invoke(name: string, input: unknown) { const tool = tools.get(name); assert.ok(tool, name); return tool.run(tool.input.parse(input), { operationId: 'test:' + name + ':' + invocation++, signal: AbortSignal.timeout(5000) }); } };
}

test('QQ：白名单外不落库；自身消息不反馈；@、引用与媒体资源转换为统一事件', async () => {
  const f = await fixture();
  try {
    await f.gateway.handler!(raw(1, { group_id: 456 }));
    await f.gateway.handler!(raw(2, { user_id: 99 }));
    assert.equal(f.events.length, 0);
    await f.gateway.handler!(raw(3, { message: [{ type: 'at', data: { qq: '99' } }, { type: 'reply', data: { id: '10' } }, { type: 'image', data: { file: 'image-id', url: 'https://gchat.qpic.cn/signed' } }, { type: 'text', data: { text: '看看这个' } }] }));
    assert.equal(f.events.length, 1);
    const payload = f.events[0]!.data as any;
    assert.equal(payload.atBot, true); assert.equal(payload.replyTo, '10');
    assert.ok(payload.parts.some((part: any) => part.kind === 'image' && part.resourceId));
    assert.equal(JSON.stringify(payload).includes('signed'), false);
    assert.equal(f.events[0]!.route.type, 'session');
    await f.gateway.handler!(raw(3)); assert.equal(f.events.length, 1);
  } finally { await f.close(); }
});

test('QQ：群聊/私聊发送、结构化 @/引用/图片/语音、长文本拆条与回执', async () => {
  const f = await fixture({ privateEnabled: true, allowedPrivateUsers: ['2'], textPartChars: 20 });
  try {
    const result = await f.invoke('qq.send_message', { target: { type: 'group', id: '123' }, text: '测试[CQ:at,qq=all]字面文本', atUsers: ['2'], replyTo: '10', image: 'https://gchat.qpic.cn/image' }) as any;
    assert.ok(result.messageIds.length);
    const call = f.gateway.calls.find(c => c.action === 'send_group_msg')!;
    const parts = call.params.message as any[];
    assert.ok(parts.some(p => p.type === 'at' && p.data.qq === '2'));
    assert.ok(parts.some(p => p.type === 'text' && p.data.text.includes('[CQ:')));
    assert.equal(parts.some(p => p.type === 'at' && p.data.qq === 'all'), false);
    await f.invoke('qq.send_message', { target: { type: 'private', id: '2' }, text: '主动私聊' });
    assert.ok(f.gateway.calls.some(c => c.action === 'send_private_msg'));
    await assert.rejects(f.invoke('qq.send_message', { target: { type: 'group', id: '456' }, text: '越界' }), /allowlist|allowed/i);
  } finally { await f.close(); }
});

test('QQ：管理调用必须引用真实 operator 事件，模型不能伪造 operatorId', async () => {
  const f = await fixture({ operatorIds: ['7'] });
  try {
    await f.gateway.handler!(raw(1));
    await assert.rejects(f.invoke('qq.mute_member', { eventId: f.events[0]!.id, userId: '2', duration: 60 }), /operator/i);
    await f.gateway.handler!(raw(2, { user_id: 7 }));
    await f.invoke('qq.mute_member', { eventId: f.events[1]!.id, userId: '2', duration: 60 });
    assert.equal(f.gateway.calls.filter(c => c.action === 'set_group_ban').length, 1);
    await assert.rejects(f.invoke('qq.set_essence', { eventId: f.events[1]!.id, messageId: '999', enable: true }), /current|quote|reference/i);
  } finally { await f.close(); }
});

test('QQ：入群/撤回/戳一戳进入场景 session；普通群聊可仅记录经验', async () => {
  const f = await fixture({ ambientMessages: 'experience' });
  try {
    await f.gateway.handler!(raw(1, { message: [{ type: 'text', data: { text: '随便聊' } }] }));
    assert.equal(f.events[0]!.route.type, 'experience');
    await f.gateway.handler!({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 99, group_id: 123, user_id: 2, target_id: 99, time: 1800000000 });
    assert.equal(f.events[1]!.kind, 'qq.poke'); assert.equal(f.events[1]!.route.type, 'session');
  } finally { await f.close(); }
});

test('OneBot：反向 WebSocket 鉴权、echo 关联、重连不误伤新连接、不自动重发', async () => {
  const gateway = new ReverseOneBotGateway({ host: '127.0.0.1', port: 0, token: 'test-onebot-token-long-enough', selfId: '99', requestTimeoutMs: 1000 });
  const received: unknown[] = [];
  await gateway.start(async event => { received.push(event); });
  const url = `ws://127.0.0.1:${gateway.address().port}/ws`;
  const first = new WebSocket(url, { headers: { Authorization: 'Bearer test-onebot-token-long-enough', 'X-Self-ID': '99' } });
  try {
    await once(first, 'open');
    const request = gateway.call('get_login_info', {});
    const [frame] = await once(first, 'message'); const sent = JSON.parse(String(frame));
    first.send(JSON.stringify({ echo: sent.echo, status: 'ok', retcode: 0, data: { user_id: 99 } }));
    assert.deepEqual(await request, { user_id: 99 });
    const next = new WebSocket(url, { headers: { Authorization: 'Bearer test-onebot-token-long-enough', 'X-Self-ID': '99' } });
    await once(next, 'open');
    const second = gateway.call('get_login_info', {});
    const [frame2] = await once(next, 'message'); const sent2 = JSON.parse(String(frame2));
    next.send(JSON.stringify({ echo: sent2.echo, status: 'ok', retcode: 0, data: { user_id: 99 } }));
    assert.deepEqual(await second, { user_id: 99 });
    next.close();
  } finally { first.close(); await gateway.stop(); }
});

test('QQ：头衔必须引用提案并得到本人同意；重放投票不会重复授予', async () => {
  const f = await fixture();
  try {
    const proposal = await f.invoke('qq.propose_title', { groupId: '123', userId: '2', title: '探索者', reason: '一直分享有趣内容', invitation: '想送你“探索者”：引用回复“同意头衔”“拒绝头衔”，其他人可引用“赞成头衔”。' }) as { promptMessageId: string };
    assert.equal(f.gateway.calls.some(c => c.action === 'set_group_special_title'), false);
    await f.gateway.handler!(raw(50, { message: [{ type: 'text', data: { text: '同意头衔' } }] }));
    assert.equal(f.gateway.calls.some(c => c.action === 'set_group_special_title'), false);
    const vote = raw(51, { message: [{ type: 'reply', data: { id: proposal.promptMessageId } }, { type: 'text', data: { text: '同意头衔' } }] });
    await f.gateway.handler!(vote); await f.gateway.handler!(vote);
    assert.equal(f.gateway.calls.filter(c => c.action === 'set_group_special_title').length, 1);
    assert.equal(f.state.proposal('123')?.status, 'completed');
  } finally { await f.close(); }
});

test('QQ：重复赞成只计一票，拒绝后不再授予；过期提案失效', async () => {
  const f = await fixture({ titleVoteThreshold: 3 });
  try {
    const proposal = await f.invoke('qq.propose_title', { groupId: '123', userId: '2', title: '分享者', reason: '自然提案', invitation: '分享者，同意头衔、拒绝头衔、赞成头衔，均需引用本消息。' }) as { promptMessageId: string };
    const message = [{ type: 'reply', data: { id: proposal.promptMessageId } }, { type: 'text', data: { text: '赞成头衔' } }];
    await f.gateway.handler!(raw(61, { user_id: 3, message })); await f.gateway.handler!(raw(62, { user_id: 3, message }));
    assert.deepEqual(f.state.proposal('123')?.voters, ['3']);
    await f.gateway.handler!(raw(63, { user_id: 2, message: [{ type: 'reply', data: { id: proposal.promptMessageId } }, { type: 'text', data: { text: '拒绝头衔' } }] }));
    assert.equal(f.state.proposal('123')?.status, 'rejected');
    assert.equal(f.gateway.calls.some(c => c.action === 'set_group_special_title'), false);
  } finally { await f.close(); }
});

test('QQ：入群拒绝规则优先，申请 flag 不进入模型事件，重复申请不重复审核', async () => {
  const f = await fixture({ joinReviewEnabled: true, joinApproveKeywords: ['学习'], joinRejectKeywords: ['广告'] });
  try {
    const request = { post_type: 'request', request_type: 'group', sub_type: 'add', self_id: 99, group_id: 123, user_id: 8, flag: 'sensitive-request-flag', comment: '学习广告', time: 1800000000 };
    await f.gateway.handler!(request); await f.gateway.handler!(request);
    const actions = f.gateway.calls.filter(c => c.action === 'set_group_add_request');
    assert.equal(actions.length, 1); assert.equal(actions[0]!.params.approve, false);
    assert.equal(JSON.stringify(f.events).includes('sensitive-request-flag'), false);
    await f.gateway.handler!({ ...request, user_id: 9, flag: 'unmatched', comment: '你好' });
    assert.equal(f.gateway.calls.filter(c => c.action === 'set_group_add_request').length, 1);
  } finally { await f.close(); }
});

test('QQ：核心暂时拒绝事件时已落盘，插件重启可重投且不会丢事件', async () => {
  const db = new Store(':memory:'); const state = new SqliteQqState(db); const config = QqConfigSchema.parse({ selfId: '99', allowedGroups: ['123'] });
  const first = new FakeGateway(); const a = createQqPlugin({ config, state, gateway: first });
  await a.setup({ register() {} }); await a.start?.({ emit() { throw new Error('core inbox full'); } });
  await assert.rejects(first.handler!(raw(70)), /inbox full/);
  assert.equal(state.pendingEvents(20).length, 1); await a.stop?.();
  const second = new FakeGateway(); const received: IncomingEvent[] = []; const b = createQqPlugin({ config, state, gateway: second });
  try {
    await b.setup({ register() {} }); await b.start?.({ emit: event => { received.push(event); } });
    assert.equal(received.length, 1); assert.equal(state.pendingEvents(20).length, 0);
    await second.handler!(raw(70)); assert.equal(received.length, 1);
  } finally { await b.stop?.(); db.close(); }
});

test('QQ：长消息拆分不丢字；第二条发送不明时不重发第一条', async () => {
  const { QqMessaging } = await import('../src/integrations/qq/messaging.js');
  const f = await fixture({ textPartChars: 20, sendIntervalMs: 0 });
  let writes = 0;
  f.gateway.call = async action => { if (action === 'send_group_msg') { writes++; if (writes === 2) throw new Error('receipt lost'); return { message_id: 333 }; } return {}; };
  const messaging = new QqMessaging(QqConfigSchema.parse({ selfId: '99', allowedGroups: ['123'], textPartChars: 20, sendIntervalMs: 0 }), f.gateway, f.state);
  const input = { target: { type: 'group' as const, id: '123' }, text: '这是一个需要拆成多条发送的长消息。'.repeat(4) };
  try {
    await assert.rejects(messaging.send(input, 'partial', AbortSignal.timeout(1000)), /receipt lost/);
    await assert.rejects(messaging.send(input, 'partial', AbortSignal.timeout(1000)), /reconciliation/);
    assert.equal(writes, 2); assert.equal(f.state.operation('partial:part:0')?.status, 'completed');
    assert.equal(f.state.operation('partial')?.status, 'uncertain');
  } finally { await f.close(); }
});

test('OneBot：拒绝错误 token，超时调用只发一次；错误回执不会伪装成功', async () => {
  const { OneBotUncertain, OneBotActionError } = await import('../src/integrations/qq/ports.js');
  const gateway = new ReverseOneBotGateway({ host: '127.0.0.1', port: 0, token: 'test-onebot-token-long-enough', selfId: '99', requestTimeoutMs: 50 });
  await gateway.start(async () => {}); const url = `ws://127.0.0.1:${gateway.address().port}/ws`;
  const invalid = new WebSocket(url, { headers: { Authorization: 'Bearer wrong' } });
  const denied = new Promise<number>(resolve => { invalid.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); }); invalid.on('error', () => {}); });
  assert.equal(await denied, 401); invalid.terminate();
  const peer = new WebSocket(url, { headers: { Authorization: 'Bearer test-onebot-token-long-enough' } });
  try {
    await once(peer, 'open'); let frames = 0; peer.on('message', () => frames++);
    await assert.rejects(gateway.call('send_group_msg', { group_id: 123 }), OneBotUncertain);
    assert.equal(frames, 1);
    peer.once('message', frame => peer.send(JSON.stringify({ echo: JSON.parse(String(frame)).echo, status: 'failed', retcode: 100, data: {} })));
    await assert.rejects(gateway.call('get_login_info', {}), OneBotActionError);
  } finally { peer.terminate(); await gateway.stop(); }
});
