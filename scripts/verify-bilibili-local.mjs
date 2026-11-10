/**
 * 本地端到端验证（不是验收测试，不联网降级）：
 * 真实 B 站视频 → 弹幕选点 → 无头浏览器截图 → 检查截到的确实是有内容的画面。
 *
 *   npx tsx scripts/verify-bilibili-local.mjs BV1GJ411x7h7
 */
import { BilibiliHttp } from '../src/infrastructure/bilibili/client.js';
import { BilibiliApi } from '../src/infrastructure/bilibili/api.js';
import { DanmakuHeat } from '../src/infrastructure/bilibili/heat.js';
import { BrowserShots } from '../src/infrastructure/bilibili/shots.js';
import { pickMoments } from '../src/integrations/bilibili/heat.js';

const bvid = process.argv[2] ?? 'BV1GJ411x7h7';
const transport = new BilibiliHttp(undefined);
const api = new BilibiliApi(transport);
const signal = AbortSignal.timeout(120000);
try {
  const meta = await api.meta(bvid, 1, signal);
  const heat = await new DanmakuHeat(transport).heat({ bvid, cid: meta.cid, aid: meta.aid, signal });
  const points = pickMoments({ durationSeconds: meta.durationSeconds, count: 3, heat });
  const streamUrl = await api.streamUrl({ bvid, cid: meta.cid, signal });
  const shots = new BrowserShots({ outputDir: 'data/e2e/shots' });
  const result = await shots.capture({ bvid, streamUrl, at: points.map(p => p.at), signal });
  await shots.close();
  // data URL 的字节数能说明「是不是只有一片黑」：纯黑 JPEG 只有几百字节。
  const sizes = result.shots.map(shot => Math.round(shot.url.length * 3 / 4 / 1024));
  console.log(JSON.stringify({ title: meta.title, duration: meta.durationSeconds, heatDanmaku: heat?.seconds.length ?? 0,
    points, sizesKB: sizes, ok: sizes.every(size => size > 5) }, null, 1));
} catch (error) {
  console.error('E2E FAILED:', error.message);
  process.exit(1);
}
