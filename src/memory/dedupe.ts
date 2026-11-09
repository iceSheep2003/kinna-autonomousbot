/** 写入路径的去重与矛盾判定。纯函数，不碰存储。 */
import type { Memory } from './types.js';
import { similarity } from './text.js';

/** 到这个相似度就当同一句话又说了一遍。 */
export const DUPLICATE_THRESHOLD = 0.85;
/** 在这个区间是换个说法，保留原措辞、加固一次即可。 */
export const PARAPHRASE_THRESHOLD = 0.55;
export type DedupeKind = 'new' | 'duplicate' | 'paraphrase';
export interface DedupeDecision { kind: DedupeKind; memoryId?: string; score: number }

export function decideDedupe(existing: readonly Memory[], content: string): DedupeDecision {
  let best: DedupeDecision = { kind: 'new', memoryId: undefined, score: 0 };
  for (const memory of existing) {
    const score = similarity(memory.content, content);
    if (score > best.score) best = { kind: 'new', memoryId: memory.id, score };
  }
  if (best.score >= DUPLICATE_THRESHOLD) return { ...best, kind: 'duplicate' };
  if (best.score >= PARAPHRASE_THRESHOLD) return { ...best, kind: 'paraphrase' };
  return { kind: 'new', score: best.score };
}

const NEGATIONS = ['不', '没', '别', '讨厌', '拒绝', 'not ', 'no ', "doesn't", "don't"];

/** 低成本矛盾线索：同一个话题，一边带否定一边不带。真正的裁决仍交给人/模型。 */
export function contradiction(left: string, right: string): boolean {
  const lowLeft = left.toLocaleLowerCase();
  const lowRight = right.toLocaleLowerCase();
  const leftNegated = NEGATIONS.some(marker => lowLeft.includes(marker));
  const rightNegated = NEGATIONS.some(marker => lowRight.includes(marker));
  if (leftNegated === rightNegated) return false;
  return similarity(left, right) >= PARAPHRASE_THRESHOLD;
}
