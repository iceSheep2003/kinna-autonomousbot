import type { BilibiliMessages, BilibiliTransport, BilibiliVideo, VideoMeta } from '../../integrations/bilibili/ports.js';
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

  /** 取 DASH 流地址：截图要用真实流，不是缩略图。 */
  async streamUrl(input: { bvid: string; cid: number; signal: AbortSignal }): Promise<string> {
    const play = await this.transport.request<PlayData>({
      method: 'GET', path: '/x/player/wbi/playurl',
      query: { bvid: input.bvid, cid: input.cid, fnval: 16, qn: 80, fourk: 0 }, signal: input.signal,
    });
    return pickStream(play);
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
