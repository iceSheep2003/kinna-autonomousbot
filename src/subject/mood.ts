/**
 * 会话层心境：纯值与纯函数，不碰数据库、时钟、模型。
 *
 * 对齐服务器 qunbot/emotion/state.py：五维 0..100、向 50 指数衰减、耦合矩阵、
 * 只把中文措辞交给模型。这里刻意与「主体长期自我评价」（types.ts 的
 * AffectState）分开：那是 identity 的一部分，心境是这会儿的状态，会自己回落。
 *
 * 时间戳统一用毫秒，与本项目其余模块一致；服务器用秒，语义等价。
 */
export const MOOD_DIMENSIONS = ['valence', 'energy', 'stress', 'interest', 'sociability'] as const;
export type MoodDimension = (typeof MOOD_DIMENSIONS)[number];
export type MoodValues = Record<MoodDimension, number>;

export const MOOD_BASELINE = 50;
export const MOOD_FLOOR = 0;
export const MOOD_CEIL = 100;
export const MOOD_MAX_DELTA = 15;

export interface Mood extends MoodValues { reason: string; updatedAt: number }
export interface MoodEvent { at: number; deltas: Partial<MoodValues>; reason: string }
export interface MoodSnapshot { at: number; mood: Mood; deltas: Partial<MoodValues>; reason: string }

/** 一个维度偏离基线时，会轻轻拖动相邻维度。顺序即结算顺序，不能随意重排。 */
export const COUPLING_ORDER: readonly MoodDimension[] = ['stress', 'energy', 'valence', 'interest', 'sociability'];
export const MOOD_COUPLING: Record<MoodDimension, Partial<MoodValues>> = {
  stress: { energy: -0.18, valence: -0.12, interest: -0.08 },
  energy: { interest: 0.12, sociability: 0.10 },
  valence: { stress: -0.15, sociability: 0.10 },
  interest: { sociability: 0.12 },
  sociability: { valence: 0.06 },
};

/** 降序阈值；第一个命中的措辞胜出。模型永远看不到这些数字。 */
export const MOOD_BANDS: Record<MoodDimension, readonly (readonly [number, string])[]> = {
  valence: [[70, '心情很好'], [55, '心情不错'], [45, '心情平静'], [30, '有点低落'], [0, '很低落']],
  energy: [[70, '精神头很足'], [55, '还算有精神'], [45, '精力一般'], [30, '有点累'], [0, '很疲惫']],
  stress: [[70, '绷得很紧'], [55, '有点压力'], [45, '压力还好'], [30, '比较放松'], [0, '很放松']],
  interest: [[70, '兴致很高'], [55, '有点兴致'], [45, '兴致平平'], [30, '提不起兴致'], [0, '完全没兴致']],
  sociability: [[70, '很想说话'], [55, '愿意聊两句'], [45, '跟平时一样'], [30, '不太想说话'], [0, '只想安静待着']],
};

export const MOOD_HINT = '（以上心境只影响你说话的语气、长短和想不想主动开口。不要提及任何数值，不要因此失礼、迁怒或辱骂任何人。）';

export function clampMood(value: number): number {
  return Math.max(MOOD_FLOOR, Math.min(MOOD_CEIL, value));
}

export function baselineMood(updatedAt = 0): Mood {
  return { valence: MOOD_BASELINE, energy: MOOD_BASELINE, stress: MOOD_BASELINE,
    interest: MOOD_BASELINE, sociability: MOOD_BASELINE, reason: '', updatedAt };
}

/** 老数据缺字段时按基线补齐，避免一次部署把历史状态读成 NaN。 */
export function moodFromRow(row: Partial<Mood> | undefined): Mood {
  if (!row) return baselineMood();
  const base = baselineMood(row.updatedAt ?? 0);
  const values = moodValues(base);
  for (const name of MOOD_DIMENSIONS) {
    const value = Number(row[name]);
    if (Number.isFinite(value)) values[name] = clampMood(value);
  }
  return { ...values, reason: String(row.reason ?? '').slice(0, 120), updatedAt: base.updatedAt };
}

export function moodValues(mood: Mood): MoodValues {
  return { valence: mood.valence, energy: mood.energy, stress: mood.stress,
    interest: mood.interest, sociability: mood.sociability };
}

/** 只给措辞。每个维度都能兜底到最低档，不会出现「undefined 心情」。 */
export function bandFor(name: MoodDimension, value: number): string {
  for (const [threshold, wording] of MOOD_BANDS[name]) if (value >= threshold) return wording;
  return MOOD_BANDS[name].at(-1)![1];
}

export interface EmotionSettings {
  /** 偏离基线减半所需分钟数。 */
  halfLifeMinutes?: number;
  /** 单次增量的整体缩放。 */
  sensitivity?: number;
  /** sociability 低于此值时不主动开口。 */
  minSociability?: number;
  /** 耦合矩阵倍率。服务器实测后默认改为 0：频繁事件不该反复放大已有偏差。 */
  coupling?: number;
  baseline?: number;
}

export const defaultEmotionSettings: Required<EmotionSettings> = {
  halfLifeMinutes: 180, sensitivity: 1, minSociability: 35, coupling: 0, baseline: MOOD_BASELINE,
};

/** 衰减、耦合与措辞。无状态，可共享。 */
export class EmotionPolicy {
  readonly tauMs: number;
  readonly sensitivity: number;
  readonly minSociability: number;
  readonly coupling: number;
  readonly baseline: number;
  constructor(settings: EmotionSettings = {}) {
    const merged = { ...defaultEmotionSettings, ...settings };
    this.sensitivity = merged.sensitivity;
    this.minSociability = merged.minSociability;
    this.coupling = merged.coupling;
    this.baseline = merged.baseline;
    this.tauMs = merged.halfLifeMinutes * 60_000 / Math.LN2;
  }
  /** 向基线回落。纯函数：不写回，所以「睡几小时」不需要后台定时器。 */
  decay(mood: Mood, now: number): Mood {
    const elapsed = now - mood.updatedAt;
    if (elapsed <= 0) return mood;
    const factor = Math.exp(-elapsed / this.tauMs);
    const spread = moodValues(mood);
    for (const name of MOOD_DIMENSIONS) spread[name] = this.baseline + (mood[name] - this.baseline) * factor;
    return { ...spread, reason: mood.reason, updatedAt: now };
  }
  /** 先衰减，再加有界增量，最后让耦合矩阵沉降并 clamp。 */
  apply(mood: Mood, deltas: Partial<MoodValues>, reason: string, now: number): Mood {
    const spread = this.addDeltas(this.decay(mood, now), deltas);
    const settled = this.settle(spread);
    return { ...settled, reason: reason.trim().slice(0, 120), updatedAt: now };
  }
  private addDeltas(mood: Mood, deltas: Partial<MoodValues>): MoodValues {
    const spread = moodValues(mood);
    for (const name of MOOD_DIMENSIONS) {
      const raw = Number(deltas[name]);
      if (Number.isFinite(raw) && raw !== 0) spread[name] = clampMood(spread[name] + raw * this.sensitivity);
    }
    return spread;
  }
  private settle(spread: MoodValues): MoodValues {
    for (const source of COUPLING_ORDER) {
      const deviation = spread[source] - this.baseline;
      for (const [target, weight] of Object.entries(MOOD_COUPLING[source])) {
        const name = target as MoodDimension;
        spread[name] = clampMood(spread[name] + weight * this.coupling * deviation);
      }
    }
    return spread;
  }
  narrate(mood: Mood): string {
    const parts = MOOD_DIMENSIONS.map(name => bandFor(name, mood[name]));
    const lines = [`当前心境：${parts.slice(0, 2).join('，')}。${parts.slice(2).join('，')}。`];
    if (mood.reason.trim()) lines.push(`最近的心事：${mood.reason.trim()}。`);
    lines.push(MOOD_HINT);
    return lines.join('\n');
  }
  permitsProactive(mood: Mood): boolean { return mood.sociability >= this.minSociability; }
}
