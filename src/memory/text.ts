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
