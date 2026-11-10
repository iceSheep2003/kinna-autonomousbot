/**
 * 从弹幕时间分布选出「值得看」的时刻。纯函数，不碰网络。
 *
 * 为什么不直接用 pbp 高能进度条：那个接口在本机实测已 404（`/x/player/pbp/data`），
 * 世界在变，接口会变。弹幕本身是同一件事的原始证据——观众在哪些秒发了弹幕，
 * 就是他们在哪些秒有反应。自己按时间桶统计，比依赖一个可能随时消失的接口稳。
 *
 * 选点不取「最热闹那一刻」：满屏「哈哈哈哈」时画面可能是随便一帧。取热点前几秒，
 * 那是事情发生之前、信息还完整的画面。
 */
export interface HeatSample { durationSeconds: number; seconds: number[] }

export interface ShotPoint { at: number; why: string }

/** 每个热点往前退几秒。 */
export const LEAD_SECONDS = 4;
/** 相邻两帧至少隔这么久，避免截到同一动作。 */
export const MIN_GAP_SECONDS = 12;
/** 统计用的时间桶宽度。 */
const BUCKET_SECONDS = 5;

function edges(duration: number): { from: number; to: number } {
  const edge = Math.min(8, Math.max(2, duration * 0.03));
  return { from: edge, to: Math.max(edge + 1, duration - edge) };
}

/** 均匀采样：没有弹幕、或弹幕太少时的退路。 */
export function evenPoints(durationSeconds: number, count: number): ShotPoint[] {
  const duration = Math.max(1, durationSeconds);
  const n = Math.max(1, Math.min(12, count));
  const { from, to } = edges(duration);
  if (n === 1) return [{ at: Math.round((from + to) / 2), why: '视频中点' }];
  return Array.from({ length: n }, (_, index) => ({ at: Math.round(from + ((to - from) * index) / (n - 1)), why: '均匀取样' }));
}

/** 把弹幕秒数聚成时间桶，返回按桶计数从高到低的分桶曲线。 */
export function bucketize(seconds: readonly number[], bucketSeconds = BUCKET_SECONDS): Array<{ at: number; count: number }> {
  const counts = new Map<number, number>();
  for (const second of seconds) {
    if (!Number.isFinite(second) || second < 0) continue;
    const bucket = Math.floor(second / bucketSeconds) * bucketSeconds;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].map(([at, count]) => ({ at, count })).sort((a, b) => a.at - b.at);
}

/**
 * 选出 count 个截图时刻。
 * 弹幕少于桶数时说明「没人看」或「数据缺失」，退回均匀采样而不是硬说哪里高光。
 */
export function pickMoments(input: { durationSeconds: number; count: number; heat?: HeatSample | null }): ShotPoint[] {
  const duration = Math.max(1, input.durationSeconds);
  const count = Math.max(1, Math.min(12, input.count));
  const seconds = input.heat?.seconds ?? [];
  const buckets = bucketize(seconds);
  if (seconds.length < 20 || buckets.length < 3) return evenPoints(duration, count);
  const { from, to } = edges(duration);
  const chosen = hotPoints(buckets, from, to, count);
  for (const point of evenPoints(duration, count)) {
    if (chosen.length >= count) break;
    if (chosen.some(item => Math.abs(item.at - point.at) < MIN_GAP_SECONDS)) continue;
    chosen.push({ ...point, why: '均匀补位' });
  }
  return chosen.sort((a, b) => a.at - b.at).slice(0, count);
}

/** 从最密的桶往前退几秒取点；距离太近的桶跳过。 */
function hotPoints(buckets: Array<{ at: number; count: number }>, from: number, to: number, count: number): ShotPoint[] {
  const hot = buckets.filter(bucket => bucket.at >= from && bucket.at <= to && bucket.count > 0)
    .sort((a, b) => b.count - a.count || a.at - b.at);
  const chosen: ShotPoint[] = [];
  for (const bucket of hot) {
    if (chosen.length >= count) break;
    // 弹幕通常比画面稍晚：观众看到画面才发弹幕，所以热点前几秒才是那一帧。
    const at = Math.max(from, Math.min(to, Math.round(bucket.at - LEAD_SECONDS)));
    if (chosen.some(point => Math.abs(point.at - at) < MIN_GAP_SECONDS)) continue;
    chosen.push({ at, why: `弹幕最密处前 ${LEAD_SECONDS} 秒（该段 ${bucket.count} 条）` });
  }
  return chosen;
}

/** 把秒数格式化成 mm:ss，用于图片标注与摘要。 */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
