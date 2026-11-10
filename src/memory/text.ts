/** 中文没有空格词边界，用字符 n-gram 而不是分词。纯函数。 */
const IGNORED = new Set([
  ...' \t\r\n　!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  ...'，。！？、；：（）《》【】…—～·“”‘’',
]);

export function normalizeText(value: string): string {
  return [...value.trim().toLocaleLowerCase()].filter(char => !IGNORED.has(char)).join('');
}

/** 短串退化为整串，否则取连续二元字组。 */
export function charNgrams(value: string, size = 2): Set<string> {
  const cleaned = normalizeText(value);
  if (!cleaned) return new Set();
  if (cleaned.length <= size) return new Set([cleaned]);
  const grams = new Set<string>();
  for (let index = 0; index + size <= cleaned.length; index++) grams.add(cleaned.slice(index, index + size));
  return grams;
}

/** Jaccard 重叠，0..1。用于近重复判定和词面召回。 */
export function similarity(left: string, right: string, size = 2): number {
  const first = charNgrams(left, size);
  const second = charNgrams(right, size);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared++;
  return shared / (first.size + second.size - shared);
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

/** 拉丁词按空白切，CJK 串补二元字组。 */
export function queryTokens(query: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of query.replace(/"/g, ' ').split(/\s+/)) {
    if (word.length > 1) tokens.add(word.toLocaleLowerCase());
    for (const gram of charNgrams(word)) tokens.add(gram);
  }
  return tokens;
}

/**
 * 语料里每个字组的「区分度」：出现得越普遍，越不说明问题。
 *
 * 为什么需要：现在所有二元字组等权，「的」「了」「是他」这类到处都有的组合
 * 会把真正的关键词冲淡——「他喜欢什么」和「他在做什么」算出高度相似，
 * 只因为共享了「什么」。IDF 让稀有组合说话。
 *
 * 用 log(N/df)：在全库都出现的权重为 0，独一份的权重最高。
 */
export function inverseFrequency(documents: readonly string[], size = 2): Map<string, number> {
  const df = new Map<string, number>();
  for (const document of documents) for (const gram of charNgrams(document, size)) df.set(gram, (df.get(gram) ?? 0) + 1);
  const total = Math.max(1, documents.length);
  const weights = new Map<string, number>();
  for (const [gram, count] of df) weights.set(gram, Math.log(1 + total / count));
  return weights;
}

/**
 * 按 IDF 加权的 Jaccard（0..1）。
 *
 * 分母是**并集**权重，不是查询侧权重——这一点很容易写错：
 * 只除以查询侧总和时，共享一个泛词反而会让分数比等权 Jaccard 还高
 * （实测「他喜欢什么」vs「他在做什么」：0.143 → 0.149），等于加权把噪声放大了。
 *
 * 语料里没出现过的字组权重按 0 计，所以查询里带生词不会拉低所有候选。
 */
export function weightedSimilarity(query: string, content: string, weights: Map<string, number>, size = 2): number {
  const left = charNgrams(query, size);
  const right = charNgrams(content, size);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  let union = 0;
  for (const gram of new Set([...left, ...right])) {
    const weight = weights.get(gram);
    if (weight === undefined) continue;
    union += weight;
    if (left.has(gram) && right.has(gram)) shared += weight;
  }
  if (union === 0) return similarity(query, content, size);
  return shared / union;
}
