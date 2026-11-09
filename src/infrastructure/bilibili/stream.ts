import { BilibiliError } from './client.js';

interface PlayData {
  dash?: { video?: Array<{ baseUrl?: string; base_url?: string; width?: number; height?: number; bandwidth?: number }> };
  durl?: Array<{ url?: string }>;
}

/** DASH 优先挑带宽最高的流；拿不到 DASH 时退回 MP4 的 durl。截图不需要音轨。 */
export function pickStream(play: PlayData): string {
  const videos = play.dash?.video ?? [];
  const best = videos
    .filter(item => item.baseUrl ?? item.base_url)
    .sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0))[0];
  const url = best?.baseUrl ?? best?.base_url ?? play.durl?.[0]?.url;
  if (!url) throw new BilibiliError('取不到视频流地址（可能需要登录或视频受限）', -404);
  return url;
}
export type { PlayData };
