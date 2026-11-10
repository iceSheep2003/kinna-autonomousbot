import { z } from 'zod';

/**
 * 记忆索引层（对齐 Claude 的 MEMORY.md）。
 *
 * 问题：owner 层越来越厚时，注入靠「按预算截断」砍掉尾巴——被砍的可能恰恰是
 * 最该常驻的那几条，而且砍掉之后模型完全不知道它们存在过。
 *
 * Claude 的做法是索引 + 按需展开：`MEMORY.md` 每次会话都加载（上限 200 行 / 25KB），
 * 里面每条只有一行左右，指向真正的主题文件；细节等用到才读。
 *
 * 这里照这个结构实现，但**索引由 Dream 生成**而不是代码统计出来：
 * 哪些条目值得进索引、怎么归类、一句话怎么说，是判断题，只有读过全部记忆的模型能做。
 *
 * 三条硬约束（和 Claude 对齐）：
 * 1. **有条数上限**：索引是常驻的，不能变成第二份全量记忆；
 * 2. **有字符上限**：超了就得合并或丢弃，这个取舍交给模型（`fitIndex` 只做最后一道保险）；
 * 3. **每条必须指向真实记忆**：指向不存在的 id 等于写了个想不起来的东西。
 */
export const INDEX_LIMITS = {
  /** 最多几条。和 Claude 的 200 行不同——它的行很短，我们的每条带摘要，40 条已经够用。 */
  maxEntries: 40,
  /** 每条摘要最多多少字：索引要能一眼扫完。 */
  maxSummary: 60,
  /** 索引整体最多多少字符，注入时不能超过它。 */
  maxChars: 4_000,
} as const;

export const IndexEntrySchema = z.object({
  /** 这一条归到哪个主题下。 */
  topic: z.string().min(1).max(40),
  /** 一句话说清这条记忆是什么——不是全文，是让人判断「要不要展开」的钩子。 */
  summary: z.string().min(1).max(INDEX_LIMITS.maxSummary),
  /** 指向哪几条记忆。至少一条，否则这条索引没有可展开的东西。 */
  memoryIds: z.array(z.string().min(1).max(64)).min(1).max(20),
  /** 价值排序用：越重要越该留下。0..5。 */
  weight: z.number().min(0).max(5).default(3),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const MemoryIndexSchema = z.object({
  /** 索引更新时递增；用来判断是不是新版本。 */
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  entries: z.array(IndexEntrySchema).max(INDEX_LIMITS.maxEntries),
});
export type MemoryIndex = z.infer<typeof MemoryIndexSchema>;

export const EMPTY_INDEX: MemoryIndex = { version: 0, updatedAt: 0, entries: [] };

const HEADER = '## 我记得的事（先看这里，细节用 memory.expand 展开）';

/** 一条索引渲染成一行：主题 + 摘要 + 可展开的 id。 */
function lineOf(entry: IndexEntry): string {
  return `- [${entry.topic}] ${entry.summary}（展开: ${entry.memoryIds.join(',')}）`;
}

/** 估算渲染出来有多大，用来判断是否超预算。 */
export function indexSize(index: MemoryIndex): number {
  return index.entries.reduce((total, entry) => total + lineOf(entry).length + 1, 0);
}

/**
 * 渲染成给模型看的文本。超预算就按 weight 从低到高丢——**丢的是索引行，不是记忆本身**，
 * 那些记忆仍然可以被 memory.search 找到。
 */
export function renderIndex(index: MemoryIndex, maxChars: number = INDEX_LIMITS.maxChars): { text: string; dropped: number } {
  if (index.entries.length === 0) return { text: '', dropped: 0 };
  const sorted = [...index.entries].sort((a, b) => b.weight - a.weight);
  const kept: string[] = [];
  // 标题也算预算：不然 4000 的上限会实际变成 4000 + 标题长度。
  let used = HEADER.length + 1;
  let dropped = 0;
  for (const entry of sorted) {
    const line = lineOf(entry);
    if (used + line.length + 1 > maxChars) { dropped += 1; continue; }
    kept.push(line); used += line.length + 1;
  }
  if (kept.length === 0) return { text: '', dropped };
  // 渲染顺序按主题排，便于扫读；权重只用来决定丢谁。
  return { text: [HEADER, ...kept.sort()].join('\n'), dropped };
}

/**
 * 最后一道保险：把超限的索引裁到合法。
 *
 * 为什么需要：模型偶尔会超（40 条它可能给 45 条）。这里不重新组织内容，
 * 只按 weight 丢掉尾部，并且**保留模型没说错的部分**——它写的每一条都算数，
 * 少的只是没挤进预算的那些。
 */
export function fitIndex(entries: readonly IndexEntry[], version: number, now: number): MemoryIndex {
  const sorted = [...entries].sort((a, b) => b.weight - a.weight).slice(0, INDEX_LIMITS.maxEntries);
  return { version, updatedAt: now, entries: sorted.map(entry => ({
    ...entry,
    summary: entry.summary.slice(0, INDEX_LIMITS.maxSummary),
    memoryIds: entry.memoryIds.slice(0, 20),
  })) };
}

/** 索引里指向的所有 id，用于校验它们真的存在。 */
export function referencedIds(index: MemoryIndex): string[] {
  return [...new Set(index.entries.flatMap(entry => entry.memoryIds))];
}

/**
 * 丢掉指向不存在记忆的条目。
 *
 * 索引是常驻的，一条指向空处的索引比没有更糟：模型会以为那件事自己记得。
 */
export function pruneDangling(index: MemoryIndex, exists: (id: string) => boolean): { index: MemoryIndex; dropped: number } {
  const entries = index.entries
    .map(entry => ({ ...entry, memoryIds: entry.memoryIds.filter(exists) }))
    .filter(entry => entry.memoryIds.length > 0);
  return { index: { ...index, entries }, dropped: index.entries.length - entries.length };
}
