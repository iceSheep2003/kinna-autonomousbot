import type { HeatSampler } from '../../integrations/bilibili/ports.js';
import type { HeatSample } from '../../integrations/bilibili/heat.js';
import type { BilibiliTransport } from '../../integrations/bilibili/ports.js';

interface PbpData { step_sec?: number; events?: { default?: number[] } }

/**
 * 高能进度条。它不是播放量，是「每秒弹幕量」的采样，代表观众注意力在哪里。
 *
 * 失败返回 null 而不是抛错：热力数据只在新视频/受限视频上缺失，
 * 缺了就用均匀采样读，不该因此读不了视频。
 */
export class PbpHeat implements HeatSampler {
  constructor(private readonly transport: BilibiliTransport) {}
  async heat(input: { bvid: string; cid: number; signal: AbortSignal }): Promise<HeatSample | null> {
    try {
      const data = await this.transport.request<PbpData>({ method: 'GET', path: '/x/player/pbp/data', query: { cid: input.cid, bvid: input.bvid }, signal: input.signal });
      const points = data.events?.default ?? [];
      const stepSeconds = Number(data.step_sec ?? 0);
      return points.length >= 4 && stepSeconds > 0 ? { stepSeconds, points } : null;
    } catch {
      return null;
    }
  }
}
