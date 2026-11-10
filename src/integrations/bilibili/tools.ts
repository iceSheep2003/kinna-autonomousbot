import { z } from 'zod';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { BilibiliConfig, Draft } from './types.js';
import type { BilibiliFeed, BilibiliMessages, BilibiliVideo, HeatSampler, VideoShots } from './ports.js';
import type { DraftQueue } from './drafts.js';
import { canReadVideo } from './policy.js';
import { pickMoments } from './heat.js';
import type { TodoBoard } from './todo-board.js';
import { VIDEO_REF } from './types.js';

export interface BilibiliToolsDeps {
  config: BilibiliConfig;
  video: BilibiliVideo;
  messages: BilibiliMessages;
  /** 按热度选点 + 无头浏览器截图；不配置时 bilibili.video 会明确报错。 */
  shots?: VideoShots;
  heat?: HeatSampler;
  /** 取播放流地址（DASH），截图需要真实流。 */
  stream?: (input: { bvid: string; cid: number; signal: AbortSignal }) => Promise<string>;
  /** 截图文件对外可访问的地址前缀；DeepSeek 靠它下载图片。 */
  publicBaseUrl?: string;
  drafts: DraftQueue;
  /** 发现视频：self 靠它挑今天看什么。不发 bvid 时就靠这个。 */
  feed?: BilibiliFeed;
  /** 每日任务看板；没配置时 todo 工具不注册。 */
  todo?: TodoBoard;
}

const VIDEO = z.string().regex(VIDEO_REF, '视频号形如 BV1xx4y1x7xx');
const Page = z.number().int().min(1).max(100).default(1);

/**
 * B 站能力。
 *
 * 读的能力（看懂视频、读评论）可以直接用；写的能力一律只收草稿，
 * 批准走 owner 的 HTTP 接口——模型没有任何路径能自己把内容发到公开平台上。
 */
export function registerBilibiliTools(registry: CapabilityRegistrar, deps: BilibiliToolsDeps): void {
  const { config, video, messages, drafts } = deps;
  const guard = (meta: { ownerMid: string }): void => {
    const allowed = canReadVideo(meta.ownerMid, config.allowedMids);
    if (!allowed.ok) throw new Error(allowed.reason);
  };

  registerVideoTool(registry, deps, { video, guard });

  registry.register({
    name: 'bilibili.comments', description: '读一个视频的评论区（按热度或时间），看大家在聊什么、谁说的话值得回应。',
    effect: 'read', input: z.object({ bvid: VIDEO, limit: z.number().int().min(1).max(20).default(10), sort: z.enum(['time', 'hot']).default('hot') }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; limit: number; sort: 'time' | 'hot' };
      const meta = await video.meta(input.bvid, 1, signal);
      guard(meta);
      const list = await messages.comments({ aid: meta.aid, bvid: meta.bvid, limit: input.limit, sort: input.sort }, signal);
      return { video: { bvid: meta.bvid, title: meta.title }, comments: list };
    },
  });

  registry.register({
    name: 'bilibili.draft_comment', description: '回复某个视频（或某条评论）。按配置的策略，可能直接发出，也可能先存成草稿等人批准——返回值会说明是哪一种。'
      + '。想让评论像真人：说你看完后的具体感受或疑问，不要复述标题、不要用「这个视频真不错」这类空话，也不要写「我是AI」或自我介绍；你不必假装是人，但也别机器腔。'
      + '。只写你真正看到/读到的东西：没看到画面就只说评论区看到的事，不要假装看过视频。',
    effect: 'read', input: z.object({ bvid: VIDEO, message: z.string().min(1).max(1000), reason: z.string().min(1).max(500), replyToRpid: z.number().int().positive().optional() }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; message: string; reason: string; replyToRpid?: number };
      const meta = await video.meta(input.bvid, 1, signal);
      guard(meta);
      const result = await drafts.submit({ kind: 'comment', content: input.message, reason: input.reason, targetBvid: meta.bvid, targetAid: meta.aid,
        ...(input.replyToRpid ? { parentRpid: input.replyToRpid, rootRpid: input.replyToRpid } : {}) });
      if (!result.ok) return { refused: result.reason };
      return result.posted ? { posted: result.posted, note: '已直接发出' } : { draft: publicDraft(result.draft) };
    },
  });

  registry.register({
    name: 'bilibili.draft_dynamic', description: '发一条纯文本动态。按配置的策略，可能直接发出，也可能先存成草稿等人批准——返回值会说明是哪一种。'
      + '。像随手记一句：提一件具体的事，别写成总结或通知。',
    effect: 'read', input: z.object({ content: z.string().min(1).max(2000), reason: z.string().min(1).max(500) }),
    async run(raw) {
      const input = raw as { content: string; reason: string };
      const result = await drafts.submit({ kind: 'dynamic', content: input.content, reason: input.reason });
      if (!result.ok) return { refused: result.reason };
      return result.posted ? { posted: result.posted, note: '已直接发出' } : { draft: publicDraft(result.draft) };
    },
  });

  registry.register({
    name: 'bilibili.delete_post', description: '撤回自己发过的评论或动态。只在说错了、或想纠正时才用；需要平台返回的 rpid / dynamicId。',
    effect: 'read', input: z.object({
      kind: z.enum(['comment', 'dynamic']),
      bvid: VIDEO.optional(),
      rpid: z.number().int().positive().optional(),
      dynamicId: z.string().min(1).max(40).optional(),
    }),
    async run(raw, { signal }) {
      const input = raw as { kind: 'comment' | 'dynamic'; bvid?: string; rpid?: number; dynamicId?: string };
      if (input.kind === 'comment') {
        if (!input.bvid || !input.rpid) throw new Error('撤回评论需要 bvid 与 rpid');
        const meta = await video.meta(input.bvid, 1, signal);
        await messages.deleteComment({ aid: meta.aid, rpid: input.rpid }, signal);
        return { deleted: 'comment', rpid: input.rpid };
      }
      if (!input.dynamicId) throw new Error('撤回动态需要 dynamicId');
      await messages.deleteDynamic({ dynamicId: input.dynamicId }, signal);
      return { deleted: 'dynamic', dynamicId: input.dynamicId };
    },
  });

  if (deps.feed) registerDiscoverTool(registry, deps.feed);
  if (deps.todo) registerTodoTools(registry, deps.todo);

  registry.register({
    name: 'bilibili.quotas', description: '查今天还能发几条评论、几条动态，以及有没有在等人批准的草稿。开口前先看一眼，别把话说满。',
    effect: 'read', input: z.object({}),
    async run() {
      return {
        comment: { used: drafts.used('comment'), remaining: drafts.remaining('comment'), policy: config.commentPolicy },
        dynamic: { used: drafts.used('dynamic'), remaining: drafts.remaining('dynamic'), policy: config.dynamicPolicy },
        pendingDrafts: drafts.pending().map(publicDraft),
      };
    },
  });
}

/** 找可看的视频：每日任务第一步，不能只等别人给 bvid。 */
function registerDiscoverTool(registry: CapabilityRegistrar, feed: BilibiliFeed): void {
  registry.register({
    name: 'bilibili.discover', description: '找几个可以看的视频（默认按推荐，也可热门/排行）。挑自己真的想看的，不要为了完成任务随便点一个。返回 bvid、标题、UP、时长。',
    effect: 'read', input: z.object({
      limit: z.number().int().min(1).max(20).default(8),
      source: z.enum(['recommend', 'popular', 'ranking']).default('recommend'),
    }),
    async run(raw, { signal }) {
      const input = raw as { limit: number; source: 'recommend' | 'popular' | 'ranking' };
      const videos = await feed.discover({ ...input, signal });
      return { source: input.source, videos };
    },
  });
}

/**
 * 每日任务工具。self 读看板 → 自己挑视频 → 看视频 → 评论（真实的那个工具）→ 回来登记完成。
 * 「完成」要求带平台回执，没发出去的不能自己记成完成。
 */
function registerTodoTools(registry: CapabilityRegistrar, todo: TodoBoard): void {
  registry.register({
    name: 'bilibili.todo', description: '今天的 B 站日常：还差几条、每条做到哪了。开始前先看一眼，别把同一件事做两遍。',
    effect: 'read', input: z.object({}),
    async run() { const view = todo.view(); return { ...view, summary: view.remaining === 0 ? '今天的份做完了' : `还差 ${view.remaining} 条` }; },
  });
  registry.register({
    name: 'bilibili.todo_claim', description: '把一条日常任务绑到你要看的视频上，返回条目 id。',
    effect: 'read', input: z.object({ bvid: VIDEO }),
    async run(raw) {
      const input = raw as { bvid: string };
      const item = todo.claim(input.bvid);
      return item ? { item } : { refused: '今天的配额已经用完了' };
    },
  });
  registry.register({
    name: 'bilibili.todo_done', description: '登记完成一条。必须带上刚才评论的真实回执（rpid），没有回执不能算完成。',
    effect: 'read', input: z.object({ itemId: z.string().min(1).max(64), rpid: z.union([z.string(), z.number()]) }),
    async run(raw) {
      const input = raw as { itemId: string; rpid: string | number };
      const ok = todo.complete(input.itemId, `rpid:${input.rpid}`);
      return ok ? { ok: true } : { ok: false, reason: '条目不存在或不是待办状态' };
    },
  });
  registry.register({
    name: 'bilibili.todo_skip', description: '今天这条不做了（比如没找到值得评论的），写清原因。不算失败，但要有理由。',
    effect: 'read', input: z.object({ itemId: z.string().min(1).max(64), reason: z.string().min(1).max(300) }),
    async run(raw) {
      const input = raw as { itemId: string; reason: string };
      return todo.skip(input.itemId, input.reason) ? { ok: true } : { ok: false, reason: '条目不存在或不是待办状态' };
    },
  });
}

/** 看视频：热度选点 → 取流 → 截图。拆出来是因为它比别的工具长得多。 */
function registerVideoTool(registry: CapabilityRegistrar, deps: BilibiliToolsDeps, helpers: {
  video: BilibiliVideo; guard: (meta: { ownerMid: string }) => void;
}): void {
  const { video, guard } = helpers;
  const { config, deps: _unused } = { config: deps.config, deps };
  void _unused;
  registry.register({
    name: 'bilibili.video', description: '看一个 B 站视频：用高能进度条找出大家最在意的地方，在播放页截几张图，让你直接看图说清它讲了什么。返回截图地址和时长，图直接进你的上下文。',
    effect: 'read', input: z.object({ bvid: VIDEO, page: Page, frames: z.number().int().min(1).max(8).optional() }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; page: number; frames?: number };
      if (!deps.shots) throw new Error('读视频需要无头浏览器（playwright）与截图地址配置——这次没看到画面，不要凭标题或评论当作看过');
      const meta = await video.meta(input.bvid, input.page, signal);
      guard(meta);
      const heat = deps.heat ? await deps.heat.heat({ bvid: meta.bvid, cid: meta.cid, aid: meta.aid, signal }) : null;
      const points = pickMoments({ durationSeconds: meta.durationSeconds, count: input.frames ?? config.maxFrames, heat });
      if (!deps.stream) throw new Error('没有配置取流（playurl），无法截图');
      const streamUrl = await deps.stream({ bvid: meta.bvid, cid: meta.cid, signal });
      const shot = await deps.shots.capture({ bvid: meta.bvid, streamUrl, at: points.map(point => point.at), signal });
      return {
        bvid: meta.bvid, title: meta.title, owner: meta.ownerName, durationSeconds: meta.durationSeconds,
        heatAvailable: heat !== null,
        heatSource: heat ? '弹幕时间分布' : '无（均匀取样）',
        shots: shot.shots.map((item, index) => ({ ...item, why: points[index]?.why ?? '' })),
        note: '图会随下一次发言进入上下文；描述画面里确实有的东西，不要替视频编主题。',
      };
    },
  });


}

/** 给模型看的草稿视图：没有 cookie、没有内部字段之外的东西。 */
function publicDraft(draft: Draft) {
  return { id: draft.id, kind: draft.kind, content: draft.content, target: draft.targetBvid ?? '', expiresAt: draft.expiresAt, status: draft.status };
}
