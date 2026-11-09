/** 心境事件日志的回放与标定。纯函数，固定事件序列永远得到同一个结果。 */
import { baselineMood, COUPLING_ORDER, MOOD_COUPLING, MOOD_DIMENSIONS,
  type EmotionPolicy, type Mood, type MoodDimension, type MoodEvent, type MoodSnapshot } from './mood.js';

/**
 * 从 append-only 事件日志重建心境。折的是「应用前的原始增量」，
 * 用的是与实时写入同一个 policy，因此能逐值复现，而不是粗略近似。
 * upto 给出时忽略更晚的事件，并把结果衰减到那个时刻。
 */
export function replay(policy: EmotionPolicy, events: readonly MoodEvent[], upto?: number): Mood {
  const ordered = upto === undefined ? [...events] : events.filter(event => event.at <= upto);
  let mood = baselineMood(ordered[0]?.at ?? 0);
  for (const event of ordered) mood = policy.apply(mood, event.deltas, event.reason, event.at);
  return upto === undefined ? mood : policy.decay(mood, upto);
}

/** 每次变化之后的心境，最旧在前。 */
export function timeline(policy: EmotionPolicy, events: readonly MoodEvent[]): MoodSnapshot[] {
  let mood = baselineMood(events[0]?.at ?? 0);
  const snapshots: MoodSnapshot[] = [];
  for (const event of events) {
    mood = policy.apply(mood, event.deltas, event.reason, event.at);
    snapshots.push({ at: event.at, mood, deltas: { ...event.deltas }, reason: event.reason });
  }
  return snapshots;
}

/** I + coupling*C：一次 apply 如何映射「偏离基线的量」。 */
function gainMatrix(coupling: number): number[][] {
  return COUPLING_ORDER.map(source => MOOD_DIMENSIONS.map(target =>
    (source === target ? 1 : 0) + coupling * (MOOD_COUPLING[source][target] ?? 0)));
}

/** 幂迭代求主特征值绝对值（主特征值恒为正，故无需复数处理）。 */
function spectralRadius(matrix: number[][]): number {
  const size = matrix.length;
  let vector = new Array<number>(size).fill(1);
  for (let step = 0; step < 500; step++) {
    const moved = matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index]!, 0));
    const norm = Math.sqrt(moved.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return 0;
    vector = moved.map(value => value / norm);
  }
  return Math.sqrt(matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index]!, 0))
    .reduce((sum, value) => sum + value * value, 0));
}

/**
 * 一轮事件周期内「偏离基线」还剩多少。>1 说明心境会 latch 到 0/100 下不来，
 * <1 说明衰减赢过耦合、心境会回到基线附近。用来标定半衰期与 coupling。
 */
export function loopGain(policy: EmotionPolicy, cadenceMs: number): number {
  return spectralRadius(gainMatrix(policy.coupling)) * Math.exp(-cadenceMs / policy.tauMs);
}

/** 供测试/诊断使用：某个维度是否被耦合矩阵触及。 */
export function coupledFrom(source: MoodDimension): MoodDimension[] {
  return Object.keys(MOOD_COUPLING[source]) as MoodDimension[];
}
