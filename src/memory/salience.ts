import type { Experience } from './types.js';

/**
 * 显著性打分：回答「这一批经历里有没有值得学的东西」。
 *
 * AutoDream 的门控只数数量（24 小时、5 个会话），5 次闲聊和 1 次失败对它没区别。
 * 这里按信息密度加权：失败和纠正是最贵的信号（预测误差大），检索落空说明记忆有缺口，
 * 普通观察只算低权重并封顶，避免「话多」冒充「有事」。
 */
export interface SalienceScore {
  total: number; failures: number; corrections: number; misses: number; novelty: number;
}

const WEIGHT = { failure: 3, correction: 3, miss: 2, novelty: 1 } as const;
/** 普通观察再多也不该单独触发一次整合。 */
const NOVELTY_CAP = 6;
const FAILED = 'failed';
type Signal = keyof typeof WEIGHT;

function statusOf(experience: Experience): string {
  const data = experience.data as { status?: unknown } | null;
  return typeof data?.status === 'string' ? data.status : '';
}

function isFailure(experience: Experience): boolean {
  const kind = experience.kind.toLowerCase();
  return kind.includes('error') || kind.includes('fail') || statusOf(experience) === FAILED;
}

function isCorrection(experience: Experience, kind: string): boolean {
  return experience.source === 'user' || kind.includes('feedback') || kind.includes('correct');
}

function isNovelty(kind: string): boolean {
  return kind === 'note.observation' || kind === 'note.result' || kind.endsWith('.message') || kind.endsWith('.item');
}

/** 经验日志里的 kind 由写入方决定，这里只做保守归类；认不出的不计分。 */
function classify(experience: Experience): Signal | undefined {
  const kind = experience.kind.toLowerCase();
  if (isFailure(experience)) return 'failure';
  if (kind.includes('miss')) return 'miss';
  if (isCorrection(experience, kind)) return 'correction';
  if (isNovelty(kind)) return 'novelty';
  return undefined;
}

export function scoreSalience(experiences: Experience[]): SalienceScore {
  const counts: Record<Signal, number> = { failure: 0, correction: 0, miss: 0, novelty: 0 };
  for (const experience of experiences) {
    const signal = classify(experience);
    if (signal) counts[signal] += 1;
  }
  const novelty = Math.min(counts.novelty, NOVELTY_CAP);
  const total = counts.failure * WEIGHT.failure + counts.correction * WEIGHT.correction
    + counts.miss * WEIGHT.miss + novelty * WEIGHT.novelty;
  return { total, failures: counts.failure, corrections: counts.correction, misses: counts.miss, novelty: counts.novelty };
}
