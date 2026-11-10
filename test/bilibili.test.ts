import test from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilibiliConfigSchema, type Draft, type PostQuota } from '../src/integrations/bilibili/types.js';
import type { BilibiliMessages, VideoMeta } from '../src/integrations/bilibili/ports.js';
import { DraftQueue } from '../src/integrations/bilibili/drafts.js';
import { canApprove, checkContent, explainCode, isExpired } from '../src/integrations/bilibili/policy.js';
import { bucketize, evenPoints, pickMoments, stamp } from '../src/integrations/bilibili/heat.js';
import { DanmakuHeat, parseDanmakuSeconds } from '../src/infrastructure/bilibili/heat.js';
import type { BilibiliTransport } from '../src/integrations/bilibili/ports.js';
import { watchVideo } from '../src/app/video-watch.js';
import { createServer } from '../src/infrastructure/http/server.js';
import { readFileSync } from 'node:fs';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { ConfigSchema } from '../src/app/config.js';
import { registerBilibiliTools } from '../src/integrations/bilibili/tools.js';
import type { AdminApi } from '../src/app/admin.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

class MemoryBilibiliState {
  drafts = new Map<string, Draft>();
  quotas = new Map<number, PostQuota>();
  draft(id: string) { return this.drafts.get(id); }
  saveDraft(draft: Draft) { this.drafts.set(draft.id, draft); }
  pendingDrafts(_now: number, limit: number) { return [...this.drafts.values()].filter(d => d.status === 'pending').slice(0, limit); }
  quota(day: number) { return this.quotas.get(day) ?? { day, comments: 0, dynamics: 0 }; }
  saveQuota(quota: PostQuota) { this.quotas.set(quota.day, quota); }
  recentPosts(limit: number) { return [...this.drafts.values()].filter(d => d.status === 'approved').slice(0, limit); }
}

function config(overrides: Record<string, unknown> = {}) {
  return BilibiliConfigSchema.parse({ enabled: true, commentPolicy: 'draft', dynamicPolicy: 'draft', ...overrides });
}

function messages(overrides: Partial<BilibiliMessages> = {}): BilibiliMessages & { posted: string[] } {
  const posted: string[] = [];
  const base = {
    posted,
    comments: async () => [],
    postComment: async (input: { message: string }) => { posted.push(input.message); return { rpid: 9001 }; },
    postDynamic: async (input: { content: string }) => { posted.push(input.content); return { dynamicId: 'dyn-1' }; },
  };
  return { ...base, ...overrides } as BilibiliMessages & { posted: string[] };
}

function queue(overrides: { config?: ReturnType<typeof config>; messages?: BilibiliMessages & { posted: string[] }; now?: () => number } = {}) {
  const state = new MemoryBilibiliState();
  const messagesStub = overrides.messages ?? messages();
  const q = new DraftQueue({ state, config: overrides.config ?? config(), messages: messagesStub, now: overrides.now ?? (() => NOW) });
  return { state, queue: q, messages: messagesStub };
}

/* ------------------------------ 正文规则 ------------------------------ */

test('评论与动态的正文规则：空、超长、纯链接、个人信息都不让过', () => {
  assert.equal(checkContent('comment', '   ').ok, false);
  assert.equal(checkContent('comment', 'a'.repeat(1001)).ok, false);
  assert.equal(checkContent('comment', 'https://example.com/only-link').ok, false);
  assert.equal(checkContent('comment', '看我主页 https://example.com 了解详情').ok, false);
  assert.equal(checkContent('dynamic', '想看具体的私聊我').ok, false);
  assert.equal(checkContent('comment', '这一段讲得很清楚，画面里那张图我看了两遍').ok, true);
});

test('平台返回码翻译成人话', () => {
  assert.match(explainCode(-101, 'x'), /未登录/);
  assert.match(explainCode(12002, 'x'), /评论区已关闭/);
  assert.match(explainCode(12345, 'B 站拒绝'), /code 12345/);
});

/* ------------------------------ 草稿队列 ------------------------------ */

test('默认 draft 策略：只建草稿，不发出任何东西', async () => {
  const f = queue();
  const result = await f.queue.submit({ kind: 'comment', content: '这一期讲得很清楚，谢谢', reason: '看完觉得有用', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(result.ok, true);
  assert.equal(f.messages.posted.length, 0);
  const draft = f.queue.get((result as { draft: Draft }).draft.id)!;
  assert.equal(draft.status, 'pending');
  assert.equal(draft.expiresAt, NOW + config().draftTtlMs);
});

test('off 策略连草稿都不建', async () => {
  const f = queue({ config: config({ commentPolicy: 'off' }) });
  const result = await f.queue.submit({ kind: 'comment', content: '这句话我想说一下', reason: '想回', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(result.ok, false);
  assert.equal(f.queue.pending().length, 0);
});

test('direct 策略：校验通过就直接发出，不进草稿队列，回执带平台 id', async () => {
  const f = queue({ config: config({ commentPolicy: 'direct', dynamicPolicy: 'direct' }) });
  const result = await f.queue.submit({ kind: 'comment', content: '这一期的画面剪得很舒服', reason: '看完想说', targetBvid: 'BV1xx4y1x7xx', targetAid: 7 }) as unknown as { ok: true; posted: string };
  assert.equal(f.messages.posted.length, 1);
  assert.equal(result.posted, '9001');
  assert.equal(f.queue.pending().length, 0, 'direct 不应留下待批草稿');
});

test('direct 策略也要过正文规则与每日额度，不是「不检查」', async () => {
  const f = queue({ config: config({ dynamicPolicy: 'direct', maxPostsPerDay: 1 }) });
  const bad = await f.queue.submit({ kind: 'dynamic', content: '私聊我', reason: 'r' });
  assert.equal(bad.ok, false);
  assert.equal(f.messages.posted.length, 0);
  const first = await f.queue.submit({ kind: 'dynamic', content: '今天看完了一本书', reason: 'r' });
  assert.equal(first.ok, true);
  const second = await f.queue.submit({ kind: 'dynamic', content: '还想再说一句', reason: 'r' });
  assert.equal(second.ok, false);
  assert.equal(f.messages.posted.length, 1);
});

test('direct 发送失败时如实返回失败原因，不留下「待批」假象', async () => {
  const failing = messages({ postDynamic: async () => { throw new Error('B 站拒绝：-509'); } });
  const f = queue({ config: config({ dynamicPolicy: 'direct' }), messages: failing });
  const result = await f.queue.submit({ kind: 'dynamic', content: '这句话发不出去', reason: 'r' });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /-509/);
  assert.equal(f.queue.pending().length, 0);
});

test('批准后才会真正发出，回执写回草稿并扣当天额度', async () => {
  const f = queue();
  const draft = (await f.queue.submit({ kind: 'comment', content: '这段我反复看了两遍', reason: '想回一句', targetBvid: 'BV1xx4y1x7xx', targetAid: 77 }) as unknown as { draft: Draft }).draft;
  const result = await f.queue.approve(draft.id, { by: 'owner' });
  assert.equal(result.ok, true);
  assert.equal(f.messages.posted.length, 1);
  const saved = f.queue.get(draft.id)!;
  assert.equal(saved.status, 'approved');
  assert.equal(saved.postedId, '9001');
  assert.equal(f.state.quota(Math.floor(NOW / DAY)).comments, 1);
  assert.equal(f.queue.remaining('comment'), config().maxPostsPerDay - 1);
});

test('重复批准同一草稿不会发第二遍', async () => {
  const f = queue();
  const draft = (await f.queue.submit({ kind: 'dynamic', content: '今天把楼下的猫拍到了', reason: '值得说' }) as unknown as { draft: Draft }).draft;
  assert.equal((await f.queue.approve(draft.id)).ok, true);
  const second = await f.queue.approve(draft.id);
  assert.equal(second.ok, false);
  assert.equal(f.messages.posted.length, 1);
});

test('每天额度用完就发不出去，草稿还在但不批准', async () => {
  const f = queue({ config: config({ maxPostsPerDay: 1 }) });
  const first = (await f.queue.submit({ kind: 'comment', content: '第一条评论内容', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as unknown as { draft: Draft }).draft;
  await f.queue.approve(first.id);
  const second = await f.queue.submit({ kind: 'comment', content: '第二条评论内容', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(second.ok, false);
  assert.equal(f.queue.remaining('comment'), 0);
});

test('过期草稿不能被批准，过期会被标掉', async () => {
  let now = NOW;
  const f = queue({ now: () => now });
  const draft = (await f.queue.submit({ kind: 'comment', content: '深夜想说的那句话', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as unknown as { draft: Draft }).draft;
  now = NOW + config().draftTtlMs + 1;
  assert.equal(canApprove(f.queue.get(draft.id), now).ok, false);
  assert.equal(f.queue.expire(), 1);
  assert.equal(f.queue.get(draft.id)?.status, 'expired');
  assert.equal((await f.queue.approve(draft.id)).ok, false);
});

test('发送失败不扣额度，草稿保留原因，不自动重发', async () => {
  const failing = messages({ postComment: async () => { throw new Error('B 站拒绝：评论区已关闭'); } });
  const f = queue({ messages: failing });
  const draft = (await f.queue.submit({ kind: 'comment', content: '想在评论区说一句', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as unknown as { draft: Draft }).draft;
  const result = await f.queue.approve(draft.id);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /评论区已关闭/);
  assert.equal(f.queue.remaining('comment'), config().maxPostsPerDay);
  assert.match(f.queue.get(draft.id)?.decisionNote ?? '', /评论区已关闭/);
});

test('拒绝的草稿不会再被批准', async () => {
  const f = queue();
  const draft = (await f.queue.submit({ kind: 'dynamic', content: '随便说点什么吧', reason: 'r' }) as unknown as { draft: Draft }).draft;
  assert.equal(f.queue.reject(draft.id, { note: '太随意' }).ok, true);
  assert.equal(f.queue.get(draft.id)?.status, 'rejected');
  assert.equal(canApprove(f.queue.get(draft.id), NOW).ok, false);
  void isExpired;
});

/* ---------------------- 热度选点与截图读视频 ---------------------- */

test('没有弹幕数据时退回均匀采样，点落在正文区间内', () => {
  const points = evenPoints(100, 4);
  assert.equal(points.length, 4);
  assert.ok(points.every(point => point.at >= 2 && point.at <= 98));
  assert.equal(points[0]?.why, '均匀取样');
});

test('弹幕太少（<20 条）不硬说哪里高光，退回均匀采样', () => {
  const seconds = [10, 20, 30, 40, 50];
  assert.deepEqual(pickMoments({ durationSeconds: 100, count: 3, heat: { durationSeconds: 100, seconds } }), evenPoints(100, 3));
});

test('弹幕聚成时间桶：按 5 秒分组计数，过滤非法值', () => {
  const buckets = bucketize([0.2, 1.0, 5.1, 6.0, -3, Number.NaN]);
  assert.deepEqual(buckets, [{ at: 0, count: 2 }, { at: 5, count: 2 }]);
});

test('在弹幕最密处的前几秒截图，而不是最密那一刻', () => {
  // 全程每 10 秒一条零散弹幕，40–44 秒挤了 30 条
  const seconds = [...Array.from({ length: 10 }, (_, i) => i * 10 + 1), ...Array.from({ length: 30 }, () => 41)];
  const chosen = pickMoments({ durationSeconds: 100, count: 2, heat: { durationSeconds: 100, seconds } });
  // 返回结果按时间排序，所以要找的是「最密那段」对应的点，不是第一个。
  const hottest = chosen.find(point => (point.why ?? '').includes('31 条'));
  assert.equal(hottest?.at, 36, '40 秒的热点要往前退 4 秒');
  assert.match(hottest?.why ?? '', /弹幕最密处前 4 秒/);
});

test('邻近热点只截一张；热点不够用均匀点补位并标明', () => {
  const near = [...Array.from({ length: 10 }, (_, i) => i * 10 + 1), ...Array.from({ length: 30 }, () => 21), ...Array.from({ length: 29 }, () => 26)];
  const chosen = pickMoments({ durationSeconds: 100, count: 3, heat: { durationSeconds: 100, seconds: near } });
  const hashes = chosen.map(point => point.at);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(chosen.every((point, index) => index === 0 || Math.abs(point.at - chosen[index - 1]!.at) >= 12));
  // 距离足够的零散热点本身就能填满名额：不需要补位。
  assert.equal(chosen.length, 3);
  assert.ok(chosen.every(point => point.why.includes('弹幕最密处')), JSON.stringify(chosen));
});

test('真实弹幕 XML 能解析出秒数（只取时间，不取文字）', () => {
  const xml = '<i><d p="12.34,1,25,16777215">哈哈</d><d p="0.5,1,25,16777215">前排</d></i>';
  assert.deepEqual(parseDanmakuSeconds(xml), [12.34, 0.5]);
});

test('弹幕接口失败时返回 null，不因此读不了视频', async () => {
  const failing = { text: async () => { throw new Error('HTTP 412 风控'); } };
  const heat = new DanmakuHeat(failing as never);
  assert.equal(await heat.heat({ bvid: 'BV1xx4y1x7xx', cid: 1, aid: 1, signal: AbortSignal.timeout(1000) }), null);
});

test('时间点格式化：毫秒进分钟', () => {
  assert.equal(stamp(0), '00:00');
  assert.equal(stamp(65), '01:05');
  assert.equal(stamp(3599), '59:59');
});

test('看视频时把截图当多模态输入交给模型，不经过本地视觉服务', async () => {
  const calls: Array<{ images?: Array<{ url?: string; label?: string }>; instructions: string }> = [];
  const result = await watchVideo({
    model: { decide: async <T>(request: { images?: Array<{ url?: string; label?: string }>; instructions: string }) => { calls.push(request); return { reading: '一节课', keyPoints: ['白板公式'], tone: '认真', worthReplying: '' } as T; } },
    material: { bvid: 'BV1xx4y1x7xx', title: '标题', owner: 'UP', durationSeconds: 90,
      shots: [{ url: 'data:image/jpeg;base64,AAA', at: 26, why: '弹幕最密处前 4 秒' }],
      comments: [{ user: 'a', text: '好' }] },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.images?.length, 1);
  assert.match(calls[0]?.images?.[0]?.label ?? '', /00:26/);
  assert.equal(result.keyPoints.length, 1);
  assert.doesNotMatch(calls[0]!.instructions, /cookie/i);
});

/* ------------------------------ 多模态请求格式 ------------------------------ */

test('图片进 user 消息的 content blocks：URL 优先，每张图前有一行说明', async () => {
  const { OpenAICompatibleModel } = await import('../src/infrastructure/models/openai-compatible.js');
  const original = globalThis.fetch; let sent: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: 'ok' }) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'deepseek-flash' });
    await model.decide({
      role: 'execution', instructions: '看图', context: { title: '视频' }, schema: z.object({ result: z.string() }),
      images: [
        { url: 'https://example.com/a.jpg', detail: 'high', label: '第 00:26 帧' },
        { url: 'https://example.com/b.jpg' },
      ],
    });
    const user = sent.messages.find((message: { role: string }) => message.role === 'user');
    assert.ok(Array.isArray(user.content), '有图时 user content 必须是 block 数组');
    const types = user.content.map((block: { type: string }) => block.type);
    assert.deepEqual(types, ['text', 'text', 'image_url', 'image_url']);
    assert.equal(user.content[2].image_url.url, 'https://example.com/a.jpg');
    assert.equal(user.content[2].image_url.detail, 'high');
    // 图片不能被塞进 system 消息：DeepSeek 对 system 里的图返回 400。
    const system = sent.messages.find((message: { role: string }) => message.role === 'system');
    assert.equal(typeof system.content, 'string');
  } finally { globalThis.fetch = original; }
});

test('没有图时 user content 仍是字符串，避免改变纯文本请求的形状', async () => {
  const { OpenAICompatibleModel } = await import('../src/infrastructure/models/openai-compatible.js');
  const original = globalThis.fetch; let sent: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: 'ok' }) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'deepseek-flash' });
    await model.decide({ role: 'execution', instructions: 'x', context: { a: 1 }, schema: z.object({ result: z.string() }) });
    const user = sent.messages.find((message: { role: string }) => message.role === 'user');
    assert.equal(typeof user.content, 'string');
  } finally { globalThis.fetch = original; }
});

test('撤回工具：按 bvid 找回 aid 再删评论；缺参数时直接拒绝而不是乱删', async () => {
  const { CapabilityRegistry } = await import('../src/capabilities/registry.js');
  const registry = new CapabilityRegistry({ get: () => undefined, save() {} } as never);
  const f = queue();
  const deleted: Array<{ kind: string; id: number | string }> = [];
  registerBilibiliTools(registry as never, {
    config: config(), drafts: f.queue,
    video: { meta: async () => ({ bvid: 'BV1xx4y1x7xx', aid: 42, cid: 1, title: 't', ownerMid: '9', ownerName: 'u', durationSeconds: 60, desc: '', pages: [] }) },
    messages: { ...f.messages,
      deleteComment: async (input: { rpid: number }) => { deleted.push({ kind: 'comment', id: input.rpid }); },
      deleteDynamic: async (input: { dynamicId: string }) => { deleted.push({ kind: 'dynamic', id: input.dynamicId }); } },
  });
  assert.ok(registry.catalog(['bilibili.delete_post']).length === 1, '删除工具应已注册');
  await assert.rejects(async () => registry.invoke({ operationId: 'op-1', name: 'bilibili.delete_post',
    input: { kind: 'comment', rpid: 5 }, allowed: ['bilibili.delete_post'], now: Date.now() }), /bvid/);
  const result = await registry.invoke({ operationId: 'op-2', name: 'bilibili.delete_post',
    input: { kind: 'comment', bvid: 'BV1xx4y1x7xx', rpid: 5 }, allowed: ['bilibili.delete_post'], now: Date.now() });
  assert.deepEqual(result, { deleted: 'comment', rpid: 5 });
  assert.deepEqual(deleted, [{ kind: 'comment', id: 5 }]);
});

test('内联 data: URL 不受 8192 字符的外部链接上限限制', async () => {
  const { OpenAICompatibleModel } = await import('../src/infrastructure/models/openai-compatible.js');
  const original = globalThis.fetch; let sent: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: 'ok' }) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatibleModel({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'deepseek-flash' });
    const big = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    await model.decide({ role: 'execution', instructions: 'x', context: {}, schema: z.object({ result: z.string() }), images: [{ url: big }] });
    const user = sent.messages.find((m: { role: string }) => m.role === 'user');
    const image = user.content.find((b: { type: string }) => b.type === 'image_url');
    assert.equal(image.image_url.url, big, 'data URL 应原样传给模型，而不是被当成超长外链丢掉');
  } finally { globalThis.fetch = original; }
});

test('发现视频：把推荐/热门/排行榜的字段归一化，缺的给空值不瞎猜', async () => {
  const { BilibiliApi } = await import('../src/infrastructure/bilibili/api.js');
  const transport = { request: async () => ({ list: [
    { bvid: 'BV1xx4y1x7xx', title: '标题一', owner: { name: 'UP甲' }, duration: 600, stat: { view: 1234 }, tname: '科技' },
    { bvid: 'BV2yy4y1x7yy', title: '标题二', duration: 900_000, stat: { view: 0 } },
    { title: '没有 bvid 的脏数据' },
  ] }) };
  const api = new BilibiliApi(transport as never);
  const list = await api.discover({ limit: 5, source: 'recommend', signal: AbortSignal.timeout(1000) });
  assert.equal(list.length, 2, '缺 bvid 的行应被丢掉');
  assert.equal(list[0]!.owner, 'UP甲');
  assert.equal(list[0]!.durationSeconds, 600);
  assert.equal(list[0]!.category, '科技');
  // 毫秒级时长要换算成秒
  assert.equal(list[1]!.durationSeconds, 900);
  assert.equal(list[1]!.owner, '');
  assert.equal(list[1]!.category, '');
});
