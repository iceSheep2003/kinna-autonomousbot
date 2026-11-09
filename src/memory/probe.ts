/**
 * 记忆保真度探针：不用 LLM，纯文本统计。
 *
 * 存在的理由是「整合漂移」无法靠感觉发现——每次摘要都丢一点细节、长一点自信的概括，
 * 几轮之后记忆里全是正确的废话。这里量的是：整合前的高频词，整合后还剩多少。
 * 配合 probes/retention 的前后对比，Dream 到底是有损压缩还是有益提炼，才可证伪。
 */
import type { Memory } from './types.js';

const CJK = /[\u4e00-\u9fff]+/g;
const LATIN = /[a-zA-Z]{3,}/g;
/** 高频虚词会把「保留率」抬高到没意义，先剔掉。 */
const STOP = new Set(['这个', '那个', '什么', '自己', '可以', '已经', '因为', '所以', '但是', '就是',
  '一个', '没有', '我们', '他们', '现在', '时候', '觉得', '感觉', '还是', '不是', '有人', '怎么', '比较']);

/** 中文按二元组切，英文按词；够用且不引依赖。 */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) out.push(run.slice(index, index + 2));
  }
  for (const word of text.match(LATIN) ?? []) out.push(word.toLowerCase());
  return out;
}

export function keywordWeights(texts: string[], top = 60): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokens(text)) {
      if (STOP.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top));
}

export interface Retention {
  total: number; kept: number; rate: number; lost: string[];
}

/** 整合前的高频词有多少仍出现在整合后的记忆里。rate 越低，说明压缩丢掉的越多。 */
export function retention(before: string[], after: string[], top = 60): Retention {
  const weights = keywordWeights(before, top);
  const corpus = new Set(tokens(after.join('\n')));
  const lost = [...weights.keys()].filter(token => !corpus.has(token));
  const total = weights.size;
  return { total, kept: total - lost.length, rate: total ? Number(((total - lost.length) / total).toFixed(3)) : 1, lost: lost.slice(0, 20) };
}

export interface CorpusStats {
  memories: number; chars: number; avgChars: number;
  byKind: Record<string, number>; unreferenced: number;
}

export function describeMemories(memories: Memory[]): CorpusStats {
  const byKind: Record<string, number> = {};
  let chars = 0;
  let unreferenced = 0;
  for (const memory of memories) {
    byKind[memory.kind] = (byKind[memory.kind] ?? 0) + 1;
    chars += memory.content.length;
    if (memory.evidence.length < 2) unreferenced += 1;
  }
  const count = memories.length;
  return { memories: count, chars, avgChars: count ? Math.round(chars / count) : 0, byKind, unreferenced };
}
