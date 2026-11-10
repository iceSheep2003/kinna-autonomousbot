import type { EnvironmentPlugin } from '../plugin.js';
import type { IncomingEvent } from '../../runtime/types.js';
import type { BilibiliConfig } from './types.js';
import type { BilibiliMessages, BilibiliVideo, HeatSampler, VideoShots } from './ports.js';
import type { TodoBoard } from './todo-board.js';
import type { DraftQueue } from './drafts.js';
import { registerBilibiliTools } from './tools.js';

export interface BilibiliPluginOptions {
  config: BilibiliConfig;
  video: BilibiliVideo;
  messages: BilibiliMessages;
  drafts: DraftQueue;
  /** 按热度选点 + 无头浏览器截图；由应用层注入。 */
  shots?: VideoShots;
  heat?: HeatSampler;
  /** 取 DASH 流地址，截图需要真实流。 */
  stream?: (input: { bvid: string; cid: number; signal: AbortSignal }) => Promise<string>;
  /** 截图对外可访问的地址前缀（DeepSeek 要能下载）。 */
  publicBaseUrl?: string;
  /** 每日任务看板；不配置时 todo 系列工具不注册。 */
  todo?: TodoBoard;
  /** 轮询自己视频的评论，把别人对你说的话送进场景会话。 */
  pollMs?: number;
  /** 读自己空间最近的投稿；不提供时不做评论轮询（仍可用读/写草稿能力）。 */
  recentVideos?: () => Promise<Array<{ bvid: string; aid: number }>>;
}

interface ReplyRow { rpid: number; text: string; user: string; likes: number; replies: number; at: number }

/** 场景 id 按视频分：每个视频一个会话，上下文不会串到别的视频下面。 */
export function sceneFor(bvid: string): { sessionId: string; scope: Record<string, string> } {
  return { sessionId: `bilibili:video:${bvid}`, scope: { type: 'video', id: bvid } };
}

/**
 * B 站环境插件。
 *
 * 只做两件事：注册能力（读视频、读评论、出草稿），以及把「别人评论了你的视频」
 * 作为事件送进场景会话——这样有人回你话时，同一个主体能在那里接话，
 * 而不是只在自己的时间线上自言自语。批准与发送不在这里，走 owner 的 HTTP 接口。
 */
export function createBilibiliPlugin(deps: BilibiliPluginOptions): EnvironmentPlugin {
  const { config } = deps;
  const pollMs = deps.pollMs ?? 5 * 60_000;
  let emit: ((event: IncomingEvent) => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** bvid -> 已知的评论 rpid，用来只把新评论送进会话。 */
  const seen = new Map<string, Set<number>>();

  async function poll(): Promise<void> {
    if (!emit) return;
    const videos = deps.recentVideos ? await deps.recentVideos().catch(() => []) : [];
    for (const { bvid, aid } of videos) {
      let comments: ReplyRow[];
      try { comments = await deps.messages.comments({ aid, bvid, limit: 20, sort: 'time' }, AbortSignal.timeout(20000)); }
      catch { continue; } // 网络或登录态问题：下一轮再试，不把错误伪装成「没人评论」
      const known = seen.get(bvid) ?? new Set<number>();
      const fresh = comments.filter(item => !known.has(item.rpid));
      for (const comment of fresh) known.add(comment.rpid);
      seen.set(bvid, known);
      if (known.size === comments.length && fresh.length === comments.length) continue; // 首轮只建基线
      for (const comment of fresh) {
        const route = sceneFor(bvid);
        emit({ id: `bilibili:comment:${comment.rpid}`, source: 'bilibili', kind: 'bilibili.comment',
          data: { bvid, rpid: comment.rpid, user: comment.user, text: comment.text, at: comment.at },
          route: { type: 'session', sessionId: route.sessionId, environment: 'bilibili', scope: route.scope } });
      }
    }
  }

  return {
    name: 'bilibili',
    setup(registry) {
      registerBilibiliTools(registry, {
        config, video: deps.video, messages: deps.messages, drafts: deps.drafts,
        ...(deps.shots ? { shots: deps.shots } : {}), ...(deps.heat ? { heat: deps.heat } : {}),
        ...(deps.stream ? { stream: deps.stream } : {}), ...(deps.todo ? { todo: deps.todo } : {}),
        ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}),
      });
    },
    async start(context) {
      emit = context.emit;
      // 首轮只记基线，不把历史评论当成新消息一股脑送进来。
      await poll().catch(() => {});
      timer = setInterval(() => { void poll().catch(() => {}); }, Math.max(60_000, pollMs));
      timer.unref();
    },
    async stop() { clearInterval(timer); emit = undefined; },
  };
}
