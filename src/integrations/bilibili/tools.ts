import { z } from 'zod';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { BilibiliConfig, Draft } from './types.js';
import type { BilibiliMessages, BilibiliVideo, HeatSampler, VideoShots } from './ports.js';
import type { DraftQueue } from './drafts.js';
import { canReadVideo } from './policy.js';
import { pickMoments } from './heat.js';
import { VIDEO_REF } from './types.js';

export interface BilibiliToolsDeps {
  config: BilibiliConfig;
  video: BilibiliVideo;
  messages: BilibiliMessages;
  /** 按热度选点 + 无头浏览器截图；不配置时 bilibili.video 会明确报错。 */
  shots?: VideoShots;
  heat?: HeatSampler;
  /** 截图文件对外可访问的地址前缀；DeepSeek 靠它下载图片。 */
  publicBaseUrl?: string;
  drafts: DraftQueue;
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

  registry.register({
    name: 'bilibili.video', description: '看一个 B 站视频：用高能进度条找出大家最在意的地方，在播放页截几张图，让你直接看图说清它讲了什么。返回截图地址和时长，图直接进你的上下文。',
    effect: 'read', input: z.object({ bvid: VIDEO, page: Page, frames: z.number().int().min(1).max(8).optional() }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; page: number; frames?: number };
      if (!deps.shots) throw new Error('读视频需要无头浏览器（playwright）与截图地址配置');
      const meta = await video.meta(input.bvid, input.page, signal);
      guard(meta);
      const heat = deps.heat ? await deps.heat.heat({ bvid: meta.bvid, cid: meta.cid, signal }) : null;
      const points = pickMoments({ durationSeconds: meta.durationSeconds, count: input.frames ?? config.maxFrames, heat });
      const shot = await deps.shots.capture({ bvid: meta.bvid, timestamp: meta.durationSeconds, count: points.length, at: points.map(point => point.at), signal });
      return {
        bvid: meta.bvid, title: meta.title, owner: meta.ownerName, durationSeconds: meta.durationSeconds,
        heatAvailable: heat !== null,
        shots: shot.shots.map((item, index) => ({ ...item, why: points[index]?.why ?? '' })),
        note: '图会随下一次发言进入上下文；描述画面里确实有的东西，不要替视频编主题。',
      };
    },
  });

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
    name: 'bilibili.draft_comment', description: '想对某个视频（或某条评论）说点什么时，先写成草稿交给人看：说清楚为什么想回这条、你想说什么。批准前不会发出去。',
    effect: 'read', input: z.object({ bvid: VIDEO, message: z.string().min(1).max(1000), reason: z.string().min(1).max(500), replyToRpid: z.number().int().positive().optional() }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; message: string; reason: string; replyToRpid?: number };
      const meta = await video.meta(input.bvid, 1, signal);
      guard(meta);
      const result = drafts.submit({ kind: 'comment', content: input.message, reason: input.reason, targetBvid: meta.bvid, targetAid: meta.aid,
        ...(input.replyToRpid ? { parentRpid: input.replyToRpid, rootRpid: input.replyToRpid } : {}) });
      return result.ok ? { draft: publicDraft(result.draft) } : { refused: result.reason };
    },
  });

  registry.register({
    name: 'bilibili.draft_dynamic', description: '想发一条动态时先写草稿交给人看：一句话说你在做什么、为什么值得说。批准前不会发出去。',
    effect: 'read', input: z.object({ content: z.string().min(1).max(2000), reason: z.string().min(1).max(500) }),
    async run(raw) {
      const input = raw as { content: string; reason: string };
      const result = drafts.submit({ kind: 'dynamic', content: input.content, reason: input.reason });
      return result.ok ? { draft: publicDraft(result.draft) } : { refused: result.reason };
    },
  });

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

/** 给模型看的草稿视图：没有 cookie、没有内部字段之外的东西。 */
function publicDraft(draft: Draft) {
  return { id: draft.id, kind: draft.kind, content: draft.content, target: draft.targetBvid ?? '', expiresAt: draft.expiresAt, status: draft.status };
}
