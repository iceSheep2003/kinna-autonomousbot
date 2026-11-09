import { mkdtemp, rm } from 'node:fs/promises';
import { explainCode, exploreRange, groundedPoints } from '../../integrations/bilibili/policy.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BilibiliMessages, BilibiliTransport, BilibiliVideo, FramePerception, VideoMeta } from '../../integrations/bilibili/ports.js';
import { BilibiliError } from './client.js';

/** 取流时只要 DASH 的 1080P，够抽帧看画面，也省流量。 */
const FNVAL_DASH = 16;
const QN_1080 = 80;

interface ViewData {
  bvid: string; aid: number; cid: number; title: string; desc?: string; duration: number;
  owner?: { mid: number; name: string };
  pages?: Array<{ cid: number; part?: string; page: number }>;
}

interface PlayData {
  dash?: { video?: Array<{ baseUrl?: string; base_url?: string; width?: number; height?: number; bandwidth?: number; backupUrl?: string[] }> };
  durl?: Array<{ url?: string }>;
  timelength?: number;
}

interface ReplyRow {
  rpid: number; like?: number; rcount?: number; ctime?: number; content?: { message?: string };
  member?: { uname?: string };
}

interface ReplyData { replies?: ReplyRow[] | null; hots?: ReplyRow[] | null; page?: { count?: number } }

/** 读视频 + 抽帧 + 读评论 + 发评论/发动态。所有写操作都走 transport 的 csrf 附件。 */
export class BilibiliApi implements BilibiliVideo, BilibiliMessages {
  constructor(private readonly transport: BilibiliTransport) {}

  async meta(bvid: string, page: number, signal: AbortSignal): Promise<VideoMeta> {
    const view = await this.transport.request<ViewData>({ method: 'GET', path: '/x/web-interface/view', query: { bvid }, signal });
    const pages = (view.pages ?? []).map(item => ({ cid: item.cid, title: item.part ?? `P${item.page}`, page: item.page }));
    const current = pages.find(item => item.page === page) ?? pages[0];
    return {
      bvid: view.bvid, aid: view.aid, cid: current?.cid ?? view.cid, title: view.title, desc: view.desc ?? '',
      ownerMid: String(view.owner?.mid ?? ''), ownerName: view.owner?.name ?? '', durationSeconds: view.duration, pages,
    };
  }

  /**
   * 抽帧：先等间隔算出时间点，再逐个片段用 ffmpeg 取一帧。
   * 视频流 URL 由 API 返回且带时效，所以不缓存、不落盘原视频。
   */
  async frames(input: { bvid: string; page: number; count: number; width: number; at?: number[] }, signal: AbortSignal): Promise<{ frames: string[]; durationSeconds: number }> {
    const meta = await this.meta(input.bvid, input.page, signal);
    const seconds = Math.max(1, meta.durationSeconds);
    // 避开片头片尾：前 5% 往往是标题卡，最后 5% 常常是关注引导。
    const points = input.at?.length
      ? input.at.filter(value => value >= 0 && value < seconds).slice(0, input.count)
      : Array.from({ length: input.count }, (_, index) => seconds * (0.05 + 0.9 * (index / Math.max(1, input.count - 1))));
    const play = await this.transport.request<PlayData>({
      method: 'GET', path: '/x/player/wbi/playurl',
      query: { bvid: input.bvid, cid: meta.cid, fnval: FNVAL_DASH, qn: QN_1080, fourk: 0 }, signal,
    });
    const url = pickStream(play);
    const dir = await mkdtemp(join(tmpdir(), 'bili-frames-'));
    const frames: string[] = [];
    try {
      for (const [index, at] of points.entries()) {
        const clip = await this.transport.clip({ url, startSeconds: Math.floor(at), endSeconds: Math.floor(at) + 1, signal, dir, name: `frame-${index}.jpg` });
        frames.push(clip.path);
      }
    } catch (error) {
      // 抽帧中途失败：整个目录一起删，不留半套帧。
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { frames, durationSeconds: seconds };
  }

  async comments(input: { aid: number; bvid: string; limit: number; sort: 'time' | 'hot' }, signal: AbortSignal) {
    const data = await this.transport.request<ReplyData>({
      method: 'GET', path: '/x/v2/reply',
      query: { type: 1, oid: input.aid, sort: input.sort === 'hot' ? 1 : 0, ps: Math.min(20, input.limit), pn: 1 }, signal,
    });
    const rows = [...(data.hots ?? []), ...(data.replies ?? [])].slice(0, input.limit);
    return rows.map(row => ({
      rpid: row.rpid, text: String(row.content?.message ?? '').slice(0, 1000), user: String(row.member?.uname ?? ''),
      likes: Number(row.like ?? 0), replies: Number(row.rcount ?? 0), at: Number(row.ctime ?? 0) * 1000,
    }));
  }

  async postComment(input: { aid: number; bvid: string; message: string; rootRpid?: number; parentRpid?: number }, signal: AbortSignal): Promise<{ rpid: number }> {
    if (!input.aid) throw new BilibiliError('发评论需要视频 aid', -400);
    const data = await this.transport.request<{ rpid?: number; rpid_str?: string }>({
      method: 'POST', path: '/x/v2/reply/add', csrf: true, signal,
      form: { type: 1, oid: input.aid, message: input.message, plat: 1,
        ...(input.rootRpid ? { root: input.rootRpid } : {}), ...(input.parentRpid ? { parent: input.parentRpid } : {}) },
    });
    return { rpid: Number(data.rpid ?? data.rpid_str ?? 0) };
  }

  /** 纯文本动态：老接口最简单、参数最少，不依赖复杂的 dyn_req 结构。 */
  async postDynamic(input: { content: string }, signal: AbortSignal): Promise<{ dynamicId: string }> {
    const data = await this.transport.request<{ dynamic_id?: string | number; dynamic_id_str?: string }>({
      method: 'POST', path: '/dynamic_svr/v1/dynamic_svr/create', base: 'vc', csrf: true, signal,
      form: { dynamic_id: 0, type: 4, rid: 0, content: input.content, plat: 1 },
    });
    return { dynamicId: String(data.dynamic_id_str ?? data.dynamic_id ?? '') };
  }
}

/** DASH 优先挑带宽最高的 video 流；拿不到 DASH 时退回 MP4 的 durl。 */
function pickStream(play: PlayData): string {
  const videos = play.dash?.video ?? [];
  const best = videos
    .filter(item => item.baseUrl ?? item.base_url)
    .sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0))[0];
  const url = best?.baseUrl ?? best?.base_url ?? play.durl?.[0]?.url;
  if (!url) throw new BilibiliError('取不到视频流地址（可能需要登录或视频受限）', -404);
  return url;
}

/** 感知层：把抽到的帧交给实现方理解。这里只保证帧文件会被清理。 */
export async function describeFrames(input: {
  perception: FramePerception; bvid: string; frames: string[]; question: string; signal: AbortSignal;
}): Promise<{ text: string; frames: number }> {
  try {
    const text = await input.perception.describe({ bvid: input.bvid, frames: input.frames, question: input.question }, input.signal);
    return { text, frames: input.frames.length };
  } finally {
    // 帧是临时文件：不管理解成功与否都删掉，避免在磁盘上留一堆画面。
    if (input.frames[0]) await rm(dirname(input.frames[0]), { recursive: true, force: true }).catch(() => {});
  }
}

/** 把「按时间点抽帧」做成可注入的一组能力，便于用假传输测试抽帧逻辑本身。 */
export function framesWith(transport: BilibiliTransport) {
  return async (input: { bvid: string; cid: number; durationSeconds: number; count: number; signal: AbortSignal }): Promise<string[]> => {
    const play = await transport.request<PlayData>({
      method: 'GET', path: '/x/player/wbi/playurl',
      query: { bvid: input.bvid, cid: input.cid, fnval: FNVAL_DASH, qn: QN_1080, fourk: 0 }, signal: input.signal,
    });
    const url = pickStream(play);
    const points = exploreRange(input.durationSeconds, input.count);
    const dir = await mkdtemp(join(tmpdir(), 'bili-frames-'));
    const frames: string[] = [];
    try {
      for (const [index, at] of points.entries()) {
        const clip = await transport.clip({ url, startSeconds: Math.floor(at), endSeconds: Math.floor(at) + 1, signal: input.signal, dir, name: `frame-${index}.jpg` });
        frames.push(clip.path);
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return frames;
  };
}

/** 抽帧读视频后再落成记忆素材：画面理解 → 结构化阅读，细节要能被画面支撑。 */
export function fromPlatformError(error: unknown): Error {
  const code = (error as { code?: number })?.code ?? 0;
  return new Error(explainCode(code, String((error as Error)?.message ?? error)));
}

export { groundedPoints };

/** 端口实现：把「理解 + 清理」包成一个对象注入给插件，集成层因此不碰文件系统。 */
export const frameReader = {
  describe: (input: { bvid: string; frames: string[]; question: string; perception: FramePerception; signal: AbortSignal }) =>
    describeFrames({ perception: input.perception, bvid: input.bvid, frames: input.frames, question: input.question, signal: input.signal }),
};
