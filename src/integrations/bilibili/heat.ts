/**
 * 按高能进度条选「值得看」的时刻。纯函数，不碰网络。
 *
 * 高能进度条（pbp）给的是一串采样点，每个点代表那几秒里弹幕发了多少。
 * 弹幕密集的地方是观众停下来、倒回去、发弹幕的地方；它说明「这里发生了事」，
 * 但**不说明「画面在讲什么」**——满屏「哈哈哈哈」的时刻截一帧，可能正好是一张笑脸。
 *
 * 所以选点不是「取最高的几处」，而是：先找热点（大家在意的段落），
 * 再在每个热点的**前几秒**截一帧——那是包袱抖开之前、画面还完整的时候。
 * 没有热力数据（新视频、短片段）时退回均匀采样，绝不假装知道哪里重要。
 */
export interface HeatSample { stepSeconds: number; points: number[] }

export interface ShotPoint { at: number; why: string }

/** 每个热点往前退几秒：一句话说到一半、一个镜头切过来之前，往往才是信息最全的帧。 */
export const LEAD_SECONDS = 4;
/** 相邻两个热点至少隔这么久，避免截到同一个镜头的两张图。 */
export const MIN_GAP_SECONDS = 12;
/** 片头（标题卡）与片尾（关注引导）不截。 */
const EDGE_RATIO = 0.03;

function pureSeconds(duration: number): { from: number; to: number } {
  const edge = Math.min(8, Math.max(2, duration * EDGE_RATIO));
  return { from: edge, to: Math.max(edge + 1, duration - edge) };
}

/** 均匀采样：没有热力数据时的退路，点落在正文区间内。 */
export function evenPoints(durationSeconds: number, count: number): ShotPoint[] {
  const duration = Math.max(1, durationSeconds);
  const n = Math.max(1, Math.min(12, count));
  const { from, to } = pureSeconds(duration);
  if (n === 1) return [{ at: Math.round((from + to) / 2), why: '视频中点' }];
  return Array.from({ length: n }, (_, index) => ({
    at: Math.round(from + ((to - from) * index) / (n - 1)),
    why: '均匀取样',
  }));
}

/**
 * 选出 count 个截图时刻。返回的点已排序、去重、落在正文区间内。
 * 热力点里的 0 是「这几秒几乎没人发弹幕」，不参与排序。
 */
export function pickMoments(input: { durationSeconds: number; count: number; heat?: HeatSample | null }): ShotPoint[] {
  const duration = Math.max(1, input.durationSeconds);
  const count = Math.max(1, Math.min(12, input.count));
  const heat = input.heat;
  if (!heat || heat.points.length < 4 || heat.stepSeconds <= 0) return evenPoints(duration, count);
  const { from, to } = pureSeconds(duration);
  const peaks = heat.points
    .map((value, index) => ({ at: index * heat.stepSeconds, value }))
    .filter(item => item.value > 0 && item.at >= from && item.at <= to)
    .sort((a, b) => b.value - a.value);
  const chosen: ShotPoint[] = [];
  for (const peak of peaks) {
    if (chosen.length >= count) break;
    const at = Math.max(from, Math.min(to, Math.round(peak.at - LEAD_SECONDS)));
    if (chosen.some(item => Math.abs(item.at - at) < MIN_GAP_SECONDS)) continue;
    chosen.push({ at, why: `高光前 ${LEAD_SECONDS} 秒（该处弹幕 ${Math.round(peak.value)}）` });
  }
  // 热点不够（很安静的视频）就补齐均匀点；混着标出来，让人知道哪些是热的、哪些只是补位。
  for (const point of evenPoints(duration, count)) {
    if (chosen.length >= count) break;
    if (chosen.some(item => Math.abs(item.at - point.at) < MIN_GAP_SECONDS)) continue;
    chosen.push({ at: point.at, why: '均匀补位' });
  }
  return chosen.sort((a, b) => a.at - b.at).slice(0, count);
}

/** 把一帧的原始秒数格式化成「mm:ss」，给提示词里的图标注和给用户的摘要用。 */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
