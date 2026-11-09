import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilibiliConfigSchema, type Draft, type PostQuota } from '../src/integrations/bilibili/types.js';
import type { BilibiliMessages, FramePerception, MediaClip, VideoMeta } from '../src/integrations/bilibili/ports.js';
import { DraftQueue } from '../src/integrations/bilibili/drafts.js';
import { canApprove, checkContent, exploreRange, explainCode, groundedPoints, isExpired } from '../src/integrations/bilibili/policy.js';
import { describeFrames, framesWith } from '../src/infrastructure/bilibili/media.js';
import type { BilibiliTransport } from '../src/integrations/bilibili/ports.js';
import { translateVideo } from '../src/app/video-watch.js';

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

/* ------------------------------ 抽帧读视频 ------------------------------ */

test('抽帧避开片头片尾，按时间点取帧，读完统一清理临时文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-test-'));
  const clips: Array<{ start: number; end: number }> = [];
  const transport: BilibiliTransport = {
    request: async <T>() => ({ dash: { video: [{ baseUrl: 'https://upos.example/1.m4s', bandwidth: 100 }] } }) as T,
    clip: async request => {
      clips.push({ start: request.startSeconds, end: request.endSeconds });
      const path = join(request.dir ?? dir, request.name ?? 'frame.jpg');
      writeFileSync(path, 'fake-jpeg');
      return { path, cleanup() {} } as MediaClip;
    },
  };
  const meta: VideoMeta = { bvid: 'BV1xx4y1x7xx', aid: 1, cid: 2, title: 't', ownerMid: '9', ownerName: 'u', durationSeconds: 100, desc: '', pages: [] };
  const seen: string[] = [];
  const perception: FramePerception = { describe: async input => { seen.push(...input.frames); return '画面里是教学课，白板上写着公式'; } };
  const frames = await framesWith(transport)({ bvid: meta.bvid, cid: meta.cid, durationSeconds: meta.durationSeconds, count: 4, signal: AbortSignal.timeout(5000) });
  // 前 5% 与后 5% 不取：100 秒视频的帧点落在 5..95 之间。
  assert.ok(clips.every(c => c.start >= 5 && c.start <= 95));
  assert.equal(frames.length, 4);
  await describeFrames({ perception, bvid: meta.bvid, frames, question: '讲什么', signal: AbortSignal.timeout(5000) });
  assert.equal(seen.length, 4);
  // 帧是临时文件：理解完就删，不留画面在磁盘上。
  assert.ok(frames.every((file: string) => !existsSync(file)));
  rmSync(dir, { recursive: true, force: true });
});

test('抽帧时间点落在正文区间内，按帧数均匀分布', () => {
  const points = exploreRange(100, 4);
  assert.equal(points.length, 4);
  assert.ok(points.every(at => at >= 5 && at <= 95));
  assert.deepEqual([...points].sort((a, b) => a - b), points);
});

test('细节必须被画面支撑：画面里没写到的细节被丢掉', () => {
  const result = groundedPoints(['白板上写着公式', '主讲人穿着红色外套'], '画面里是教学课，白板上写着公式');
  assert.deepEqual(result.kept, ['白板上写着公式']);
  assert.deepEqual(result.dropped, ['主讲人穿着红色外套']);
});

test('translateVideo 只喂「检索到的几条评论」和「画面理解」，不把整页评论倒进去', async () => {
  const calls: Array<{ context: unknown; instructions: string }> = [];
  const result = await translateVideo({
    model: { decide: async <T>(request: { context: unknown; instructions: string }) => { calls.push(request); return { reading: '这是一节课', keyPoints: ['公式'], tone: '认真', worthReplying: '可以问一个问题' } as T; } },
    material: { title: '标题', owner: 'UP', duration: 100, frameReading: '白板上写着公式', comments: [{ user: 'a', text: '好' }] },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.keyPoints.length, 1);
  assert.doesNotMatch(calls[0]!.instructions, /cookie/i);
});
