import type { HeatSampler } from '../../integrations/bilibili/ports.js';
import type { HeatSample } from '../../integrations/bilibili/heat.js';
import type { BilibiliTransport } from '../../integrations/bilibili/ports.js';

const DM_PATH = '/x/v1/dm/list.so';

/** 弹幕 XML 里每条的 `p` 属性第一段就是出现秒数。只要时间，不取文字。 */
export function parseDanmakuSeconds(xml: string): number[] {
  const seconds: number[] = [];
  const pattern = /<d p="([\d.]+),/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) seconds.push(value);
  }
  return seconds;
}

/**
 * 从弹幕接口取观众反应的时间分布。
 *
 * 失败（风控、视频关闭弹幕、网络）返回 null，调用方退回均匀采样——
 * 热力只是「挑更值得看的地方」，它缺了不该让读视频整个失败。
 */
export class DanmakuHeat implements HeatSampler {
  constructor(private readonly transport: BilibiliTransport) {}
  async heat(input: { bvid: string; cid: number; aid: number; signal: AbortSignal }): Promise<HeatSample | null> {
    try {
      const xml = await this.transport.text({ method: 'GET', path: DM_PATH, query: { oid: input.cid }, signal: input.signal });
      const seconds = parseDanmakuSeconds(xml);
      return seconds.length >= 20 ? { durationSeconds: 0, seconds } : null;
    } catch {
      return null;
    }
  }
}
