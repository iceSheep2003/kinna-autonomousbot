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
import { evenPoints, pickMoments, stamp } from '../src/integrations/bilibili/heat.js';
import { PbpHeat } from '../src/infrastructure/bilibili/heat.js';
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
  const result = f.queue.submit({ kind: 'comment', content: '这一期讲得很清楚，谢谢', reason: '看完觉得有用', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(result.ok, true);
  assert.equal(f.messages.posted.length, 0);
  const draft = f.queue.get((result as { draft: Draft }).draft.id)!;
  assert.equal(draft.status, 'pending');
  assert.equal(draft.expiresAt, NOW + config().draftTtlMs);
});

test('off 策略连草稿都不建', () => {
  const f = queue({ config: config({ commentPolicy: 'off' }) });
  const result = f.queue.submit({ kind: 'comment', content: '这句话我想说一下', reason: '想回', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(result.ok, false);
  assert.equal(f.queue.pending().length, 0);
});

test('批准后才会真正发出，回执写回草稿并扣当天额度', async () => {
  const f = queue();
  const draft = (f.queue.submit({ kind: 'comment', content: '这段我反复看了两遍', reason: '想回一句', targetBvid: 'BV1xx4y1x7xx', targetAid: 77 }) as { draft: Draft }).draft;
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
  const draft = (f.queue.submit({ kind: 'dynamic', content: '今天把楼下的猫拍到了', reason: '值得说' }) as { draft: Draft }).draft;
  assert.equal((await f.queue.approve(draft.id)).ok, true);
  const second = await f.queue.approve(draft.id);
  assert.equal(second.ok, false);
  assert.equal(f.messages.posted.length, 1);
});

test('每天额度用完就发不出去，草稿还在但不批准', async () => {
  const f = queue({ config: config({ maxPostsPerDay: 1 }) });
  const first = (f.queue.submit({ kind: 'comment', content: '第一条评论内容', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as { draft: Draft }).draft;
  await f.queue.approve(first.id);
  const second = f.queue.submit({ kind: 'comment', content: '第二条评论内容', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 });
  assert.equal(second.ok, false);
  assert.equal(f.queue.remaining('comment'), 0);
});

test('过期草稿不能被批准，过期会被标掉', async () => {
  let now = NOW;
  const f = queue({ now: () => now });
  const draft = (f.queue.submit({ kind: 'comment', content: '深夜想说的那句话', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as { draft: Draft }).draft;
  now = NOW + config().draftTtlMs + 1;
  assert.equal(canApprove(f.queue.get(draft.id), now).ok, false);
  assert.equal(f.queue.expire(), 1);
  assert.equal(f.queue.get(draft.id)?.status, 'expired');
  assert.equal((await f.queue.approve(draft.id)).ok, false);
});

test('发送失败不扣额度，草稿保留原因，不自动重发', async () => {
  const failing = messages({ postComment: async () => { throw new Error('B 站拒绝：评论区已关闭'); } });
  const f = queue({ messages: failing });
  const draft = (f.queue.submit({ kind: 'comment', content: '想在评论区说一句', reason: 'r', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as { draft: Draft }).draft;
  const result = await f.queue.approve(draft.id);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /评论区已关闭/);
  assert.equal(f.queue.remaining('comment'), config().maxPostsPerDay);
  assert.match(f.queue.get(draft.id)?.decisionNote ?? '', /评论区已关闭/);
});

test('拒绝的草稿不会再被批准', () => {
  const f = queue();
  const draft = (f.queue.submit({ kind: 'dynamic', content: '随便说点什么吧', reason: 'r' }) as { draft: Draft }).draft;
  assert.equal(f.queue.reject(draft.id, { note: '太随意' }).ok, true);
  assert.equal(f.queue.get(draft.id)?.status, 'rejected');
  assert.equal(canApprove(f.queue.get(draft.id), NOW).ok, false);
  void isExpired;
});

/* ---------------------- 热度选点与截图读视频 ---------------------- */

test('没有热力数据时退回均匀采样，点落在正文区间内', () => {
  const points = evenPoints(100, 4);
  assert.equal(points.length, 4);
  assert.ok(points.every(point => point.at >= 2 && point.at <= 98));
  assert.equal(points[0]?.why, '均匀取样');
});

test('有热力数据时在高光前几秒截图，而不是在高光那一刻', () => {
  // 每 3 秒一个采样点，第 10 个点（第 30 秒）弹幕最密。
  const points = Array.from({ length: 30 }, (_, index) => (index === 10 ? 9000 : index === 20 ? 4000 : 100));
  const chosen = pickMoments({ durationSeconds: 90, count: 2, heat: { stepSeconds: 3, points } });
  assert.equal(chosen.length, 2);
  assert.equal(chosen[0]?.at, 26, '30 秒的高光要往前退 4 秒，取包袱抖开前的画面');
  assert.match(chosen[0]?.why ?? '', /高光前 4 秒/);
});

test('两个热点挨得太近只截一张，避免同一个镜头截两次', () => {
  const points = Array.from({ length: 30 }, (_, index) => (index === 10 ? 9000 : index === 11 ? 8000 : 100));
  const chosen = pickMoments({ durationSeconds: 90, count: 4, heat: { stepSeconds: 3, points } });
  const hashes = chosen.map(point => Math.round(point.at));
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(chosen.every((point, index) => index === 0 || Math.abs(point.at - chosen[index - 1]!.at) >= 12));
});

test('热点不够时用均匀点补位，并标出来哪些是补的', () => {
  const points = Array.from({ length: 30 }, (_, index) => (index === 10 ? 9000 : 0));
  const chosen = pickMoments({ durationSeconds: 90, count: 3, heat: { stepSeconds: 3, points } });
  assert.equal(chosen.length, 3);
  assert.ok(chosen.some(point => point.why === '均匀补位'));
  assert.equal(chosen.find(point => point.why === '均匀补位')?.why, '均匀补位');
});

test('热力接口失败时返回 null，不因此读不了视频', async () => {
  const failing = { request: async () => { throw new Error('HTTP 412 风控'); } };
  const heat = new PbpHeat(failing as never);
  assert.equal(await heat.heat({ bvid: 'BV1xx4y1x7xx', cid: 1, signal: AbortSignal.timeout(1000) }), null);
});

test('时间点格式化：毫秒进分钟', () => {
  assert.equal(stamp(0), '00:00');
  assert.equal(stamp(65), '01:05');
  assert.equal(stamp(3599), '59:59');
});

test('看视频时把截图地址当多模态输入交给模型，不经过本地视觉服务', async () => {
  const calls: Array<{ images?: Array<{ url?: string; label?: string }>; instructions: string }> = [];
  const result = await watchVideo({
    model: { decide: async <T>(request: { images?: Array<{ url?: string; label?: string }>; instructions: string }) => { calls.push(request); return { reading: '一节课', keyPoints: ['白板公式'], tone: '认真', worthReplying: '' } as T; } },
    material: { bvid: 'BV1xx4y1x7xx', title: '标题', owner: 'UP', durationSeconds: 90,
      shots: [{ url: 'https://example.com/shots/a.jpg', at: 26, why: '高光前 4 秒' }, { url: 'https://example.com/shots/b.jpg', at: 60, why: '均匀补位' }],
      comments: [{ user: 'a', text: '好' }] },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.images?.map(image => image.url), ['https://example.com/shots/a.jpg', 'https://example.com/shots/b.jpg']);
  assert.match(calls[0]?.images?.[0]?.label ?? '', /00:26/);
  assert.equal(result.keyPoints.length, 1);
  assert.doesNotMatch(calls[0]!.instructions, /cookie/i);
});

/* -------------------------- owner 批准接口（HTTP） -------------------------- */

const TOKEN = 'test-secret-at-least-24-chars';

function approvalServer(f: ReturnType<typeof queue>) {
  const base: AdminApi = {
    self: () => ({}), list: () => [], experiences: () => [], turns: () => [], jobs: () => [], capabilities: () => [],
    ingest: () => ({ duplicate: false }),
    approvals: () => ({
      list: () => { f.queue.expire(); return f.queue.pending(); },
      approve: async id => { const r = await f.queue.approve(id, { by: 'owner' }); return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), ...(r.draft?.postedId ? { postedId: r.draft.postedId } : {}) }; },
      reject: (id, note) => { const r = f.queue.reject(id, { by: 'owner', ...(note ? { note } : {}) }); return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) }; },
    }),
  };
  return createServer(base, TOKEN);
}

test('批准接口只有 owner 能调，且全程不返回 cookie 之类的敏感值', async () => {
  const f = queue();
  const app = approvalServer(f);
  const headers = { authorization: `Bearer ${TOKEN}` };
  try {
    const draft = (f.queue.submit({ kind: 'comment', content: '这一段讲得很清楚', reason: '看完有用', targetBvid: 'BV1xx4y1x7xx', targetAid: 1 }) as { draft: Draft }).draft;
    assert.equal((await app.inject({ url: '/v1/bilibili/drafts' })).statusCode, 401);
    const listed = await app.inject({ url: '/v1/bilibili/drafts', headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().drafts.map((d: Draft) => d.id), [draft.id]);
    assert.doesNotMatch(listed.body, /SESSDATA|bili_jct|cookie/i);
    const approved = await app.inject({ method: 'POST', url: `/v1/bilibili/drafts/${draft.id}/approve`, headers });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().ok, true);
    assert.equal(f.messages.posted.length, 1);
    // 重复批准返回 409 而不是再发一遍。
    assert.equal((await app.inject({ method: 'POST', url: `/v1/bilibili/drafts/${draft.id}/approve`, headers })).statusCode, 409);
  } finally { await app.close(); }
});

test('没配置 B 站时批准路由返回 404，而不是假装成功', async () => {
  const app = createServer({ self: () => ({}), list: () => [], experiences: () => [], turns: () => [], jobs: () => [], capabilities: () => [], ingest: () => ({ duplicate: false }) }, TOKEN);
  try {
    assert.equal((await app.inject({ url: '/v1/bilibili/drafts', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 404);
  } finally { await app.close(); }
});

test('owner 可以在批之前拒绝草稿，拒绝后不能再被批准', async () => {
  const f = queue();
  const app = approvalServer(f);
  const headers = { authorization: `Bearer ${TOKEN}` };
  try {
    const draft = (f.queue.submit({ kind: 'dynamic', content: '想发一条不痛不痒的动态', reason: 'r' }) as { draft: Draft }).draft;
    const rejected = await app.inject({ method: 'POST', url: `/v1/bilibili/drafts/${draft.id}/reject`, headers, payload: { note: '没意思' } });
    assert.equal(rejected.statusCode, 200);
    assert.equal(f.queue.get(draft.id)?.status, 'rejected');
    assert.equal((await app.inject({ method: 'POST', url: `/v1/bilibili/drafts/${draft.id}/approve`, headers })).statusCode, 409);
    assert.equal(f.messages.posted.length, 0);
  } finally { await app.close(); }
});

test('配置示例真实可用：schema 能过，列出的 B 站工具都注册得出来', () => {
  const raw = JSON.parse(readFileSync(new URL('../agent.bilibili.example.json', import.meta.url), 'utf8'));
  const config = ConfigSchema.parse(raw);
  assert.equal(config.bilibili?.enabled, true);
  const operations = { get: () => undefined, save() {} };
  const registry = new CapabilityRegistry(operations);
  const f = queue();
  registerBilibiliTools(registry, {
    config: config.bilibili!, drafts: f.queue, messages: f.messages,
    video: { meta: async () => { throw new Error('unused'); } },
  });
  const names = config.boundaries.allowedTools.filter(name => name.startsWith('bilibili.'));
  assert.ok(names.length >= 4);
  assert.doesNotThrow(() => registry.validate(names, names));
  // 注册目录里的每一项都要能被模型看到 schema，不能只是有名字。
  assert.equal(registry.catalog(names).length, names.length);
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
