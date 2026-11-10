import type { BilibiliFeed, BilibiliMessages, BilibiliSearch, BilibiliTransport, BilibiliVideo, VideoMeta } from '../../integrations/bilibili/ports.js';
import { BilibiliError } from './client.js';
import { pickStream, type PlayData } from './stream.js';

interface ViewData {
  bvid: string; aid: number; cid: number; title: string; desc?: string; duration: number;
  owner?: { mid: number; name: string };
  pages?: Array<{ cid: number; part?: string; page: number }>;
}
interface ReplyRow {
  rpid: number; like?: number; rcount?: number; ctime?: number; content?: { message?: string };
  member?: { uname?: string };
}
interface ReplyData { replies?: ReplyRow[] | null; hots?: ReplyRow[] | null; page?: { count?: number } }

/** B 站账号的读写接口：视频信息、评论、发评论、发动态。写操作由传输层补 csrf。 */
export class BilibiliApi implements BilibiliVideo, BilibiliMessages, BilibiliFeed, BilibiliSearch {
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

  /** 取 DASH 流地址：截图要用真实流，不是缩略图。 */
  async streamUrl(input: { bvid: string; cid: number; signal: AbortSignal }): Promise<string> {
    const play = await this.transport.request<PlayData>({
      method: 'GET', path: '/x/player/wbi/playurl',
      query: { bvid: input.bvid, cid: input.cid, fnval: 16, qn: 80, fourk: 0 }, signal: input.signal,
    });
    return pickStream(play);
  }

  /**
   * 找可看的视频。默认用首页推荐（个性化），没有就退回热门、排行榜。
   * 这些接口的字段名不统一（list / item / duration 有的以秒有的以毫秒），所以做一次归一化。
   */
  async discover(input: { limit: number; source: 'recommend' | 'popular' | 'ranking'; signal: AbortSignal }) {
    const limit = Math.max(1, Math.min(20, input.limit));
    const path = input.source === 'ranking'
      ? '/x/web-interface/ranking/v2'
      : input.source === 'popular' ? '/x/web-interface/popular' : '/x/web-interface/wbi/index/top/feed/rcmd';
    const query: Record<string, string | number> = input.source === 'ranking'
      ? { rid: 0, type: 'all' }
      : { ps: limit, pn: 1 };
    const data = await this.transport.request<{ list?: unknown[]; item?: unknown[] }>({ method: 'GET', path, query, signal: input.signal });
    const rows = (data.list ?? data.item ?? []).slice(0, limit) as Array<Record<string, unknown>>;
    return rows.map(row => normalizeVideo(row)).filter(item => item.bvid !== '');
  }

  /**
   * 按关键词搜视频。
   * 用 `search/all/v2` 而不是 `search/type`：后者不带 wbi 签名时返回空列表（实测），
   * 而 all/v2 会把视频放在 result 里 result_type==='video' 的那一项下面。
   */
  async search(input: { query: string; limit: number; signal: AbortSignal }) {
    const limit = Math.max(1, Math.min(20, input.limit));
    const data = await this.transport.request<{ result?: Array<{ result_type?: string; data?: unknown[] }> }>({
      method: 'GET', path: '/x/web-interface/search/all/v2', query: { keyword: input.query, page: 1 }, signal: input.signal,
    });
    const videoGroup = (data.result ?? []).find(group => group.result_type === 'video');
    const rows = (videoGroup?.data ?? []).slice(0, limit) as Array<Record<string, unknown>>;
    return rows.map(row => normalizeVideo({ ...row, title: stripTags(row.title) })).filter(item => item.bvid !== '');
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

  /** 删除自己发的评论。 */
  async deleteComment(input: { aid: number; rpid: number }, signal: AbortSignal): Promise<void> {
    await this.transport.request({
      method: 'POST', path: '/x/v2/reply/del', csrf: true, signal,
      form: { type: 1, oid: input.aid, rpid: input.rpid },
    });
  }

  async deleteDynamic(input: { dynamicId: string }, signal: AbortSignal): Promise<void> {
    await this.transport.request({
      method: 'POST', path: '/dynamic_svr/v1/dynamic_svr/rm_dynamic', base: 'vc', csrf: true, signal,
      form: { dynamic_id: input.dynamicId },
    });
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

export { pickStream };

const text = (value: unknown, max = 200): string => typeof value === 'string' ? value.slice(0, max) : '';
const num = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

/**
 * 推荐/热门/排行榜的字段各不相同，统一成同一份形状；缺的字段给空值而不是猜。
 * 时长的坑最多：推荐给秒，有些接口给毫秒，排行榜干脆给 0（要另取）。
 */
function normalizeVideo(row: Record<string, unknown>) {
  return {
    bvid: text(row.bvid, 20),
    title: text(row.title, 120),
    // 搜索结果把 UP 放在 author，推荐/热门放在 owner.name。
    owner: text(row.author) || text((row.owner as { name?: unknown } | undefined)?.name),
    durationSeconds: secondsOf(row.duration),
    play: num((row.stat as { view?: unknown } | undefined)?.view),
    category: text(row.tname) || text(row.typename),
  };
}

/** 时长有四种写法：秒数、毫秒数、"mm:ss"、"hh:mm:ss"；统一成秒。 */
function secondsOf(value: unknown): number {
  if (typeof value === 'string' && value.includes(':')) {
    const parts = value.split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const raw = num(value);
  return raw > 86_400 ? Math.round(raw / 1000) : raw;
}

/** 搜索结果的标题带 <em> 高亮标签，去掉再给模型看。 */
function stripTags(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]+>/g, '') : '';
}
