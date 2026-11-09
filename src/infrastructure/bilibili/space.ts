import type { BilibiliTransport } from '../../integrations/bilibili/ports.js';
import { BilibiliError } from './client.js';

interface SpaceData { list?: { vlist?: Array<{ bvid: string; aid: number }> } }

/** 读自己空间最近的投稿，用来轮询自己视频下的评论。只读，不需要 csrf。 */
export function recentVideosOf(transport: BilibiliTransport, mid: string) {
  return async (): Promise<Array<{ bvid: string; aid: number }>> => {
    const data = await transport.request<SpaceData>({
      method: 'GET', path: '/x/space/wbi/arc/search',
      query: { mid, ps: 10, pn: 1, order: 'pubdate' }, signal: AbortSignal.timeout(15000),
    });
    const list = data.list?.vlist ?? [];
    if (!list.length) throw new BilibiliError('空间投稿列表为空（可能需要登录态或风控校验）', -404);
    return list.map(item => ({ bvid: item.bvid, aid: item.aid }));
  };
}
