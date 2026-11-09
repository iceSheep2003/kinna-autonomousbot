/**
 * 混合排序：词面 + 重要度 + 新鲜度 + 访问次数 + 主体匹配 + 置信度。
 *
 * 对齐服务器 memory/ranking.py，但有意不引入向量服务：词面用中文二元字组
 * Jaccard，候选集内做 min-max 归一化。每条被选中的记忆都带 reasons，
 * 这样「为什么这句进了上下文」是可解释、可写进实验记录的。
 *
 * 纯函数，无 I/O、无时钟读取（now 由调用方给）。
 */
import { GROUP_SUBJECT, type Memory, type RetrievalHit } from './types.js';
import { similarity } from './text.js';

export interface RankingWeights {
  lexical: number; importance: number; recency: number;
  access: number; subject: number; confidence: number; halfLifeDays: number;
}
export const defaultRankingWeights: RankingWeights = {
  lexical: 1.0, importance: 0.35, recency: 0.25, access: 0.15,
  subject: 0.4, confidence: 0.4, halfLifeDays: 30,
};
export interface RankOptions {
  now: number; query: string; limit: number;
  subjectUserId?: string; weights?: Partial<RankingWeights>;
}

/** 候选集内归一化；全一样时都给满分，避免除以 0 把整批记忆打成 0 分。 */
function lexicalScores(rows: readonly Memory[], query: string): Map<string, number> {
  const raw = rows.map(memory => ({ id: memory.id, score: similarity(memory.content, query) }));
  const scores = raw.map(item => item.score);
  const best = Math.max(0, ...scores);
  const worst = Math.min(...scores, best);
  const spread = best - worst;
  return new Map(raw.map(item => [item.id, spread < 1e-9 ? 1 : (item.score - worst) / spread]));
}

function recency(createdAt: number | undefined, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - (createdAt ?? now)) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.5));
}

function confidenceOf(memory: Memory): number { return memory.confidence ?? 1; }

/** 单条打分；reasons 与分数一起返回，注入时可解释。 */
function scoreOne(memory: Memory, lexical: number, options: RankOptions, weights: RankingWeights): RetrievalHit {
  const reasons: string[] = [`lexical=${lexical.toFixed(2)}`];
  let score = weights.lexical * lexical;
  const importance = memory.importance ?? 1;
  score += weights.importance * (importance / 5);
  reasons.push(`importance=${importance}`);
  const fresh = recency(memory.createdAt, options.now, weights.halfLifeDays);
  score += weights.recency * fresh;
  reasons.push(`age=${((options.now - (memory.createdAt ?? options.now)) / 86_400_000).toFixed(1)}d`);
  const accesses = memory.accessCount ?? 0;
  if (accesses > 0) {
    score += weights.access * Math.min(1, Math.log1p(accesses) / Math.log1p(10));
    reasons.push(`accesses=${accesses}`);
  }
  const subject = memory.subjectUserId ?? GROUP_SUBJECT;
  if (subject === GROUP_SUBJECT) reasons.push('group_shared');
  else if (options.subjectUserId && subject === options.subjectUserId) {
    score += weights.subject;
    reasons.push('subject_match');
  }
  score += weights.confidence * confidenceOf(memory);
  reasons.push(`confidence=${confidenceOf(memory).toFixed(2)}`);
  if (memory.status === 'candidate') reasons.push('candidate');
  return { memory, score, reasons };
}

export function rankMemories(rows: readonly Memory[], options: RankOptions): RetrievalHit[] {
  const weights = { ...defaultRankingWeights, ...options.weights };
  const lexical = lexicalScores(rows, options.query);
  const hits = rows.map(memory => scoreOne(memory, lexical.get(memory.id) ?? 0, options, weights));
  hits.sort((left, right) => right.score - left.score
    || (right.memory.createdAt ?? 0) - (left.memory.createdAt ?? 0)
    || left.memory.id.localeCompare(right.memory.id));
  return hits.slice(0, Math.max(0, options.limit));
}

export function explainHits(hits: readonly RetrievalHit[]): string[] {
  return hits.map(hit => `memory ${hit.memory.id} score=${hit.score.toFixed(3)} because ${hit.reasons.join('; ')}`);
}
