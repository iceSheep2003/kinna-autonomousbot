import { z } from 'zod';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { BilibiliConfig, Draft } from './types.js';
import type { BilibiliMessages, BilibiliVideo, FramePerception, FrameReader } from './ports.js';
import type { DraftQueue } from './drafts.js';
import { canReadVideo } from './policy.js';
import { VIDEO_REF } from './types.js';

export interface BilibiliToolsDeps {
  config: BilibiliConfig;
  video: BilibiliVideo;
  messages: BilibiliMessages;
  perception?: FramePerception;
  /** 抽帧 → 理解 → 清理临时文件；由应用层注入，集成层不碰文件系统。 */
  reader?: FrameReader;
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
    name: 'bilibili.video', description: '看一个 B 站视频：按时间轴抽几帧读画面，结合标题和简介说清楚它讲了什么。抽帧是临时文件，读完即删。',
    effect: 'read', input: z.object({ bvid: VIDEO, page: Page, question: z.string().min(1).max(500).default('这个视频在讲什么？'), frames: z.number().int().min(1).max(12).optional() }),
    async run(raw, { signal }) {
      const input = raw as { bvid: string; page: number; question: string; frames?: number };
      if (!deps.perception) throw new Error('没有配置画面理解（bilibili.inspect 需要视觉模型或感知服务）');
      const meta = await video.meta(input.bvid, input.page, signal);
      guard(meta);
      if (!deps.reader) throw new Error('抽帧读取器未配置');
      const shot = await video.frames({ bvid: input.bvid, page: input.page, count: input.frames ?? config.maxFrames, width: config.frameWidth }, signal);
      const seen = await deps.reader.describe({ bvid: input.bvid, frames: shot.frames, question: input.question, perception: deps.perception, signal });
      return { bvid: meta.bvid, title: meta.title, owner: meta.ownerName, duration: meta.durationSeconds, frames: seen.frames, reading: seen.text };
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
