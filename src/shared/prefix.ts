/** 两个字符串的公共前缀。 */
export function promptPrefix(left: string, right: string): string {
  return left.slice(0, commonLength(left, right));
}

/** 公共前缀占较短者的比例，0..1。用来量化缓存能命中多少。 */
export function prefixRatio(left: string, right: string): number {
  const shortest = Math.min(left.length, right.length);
  return shortest === 0 ? 0 : commonLength(left, right) / shortest;
}

function commonLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

/** 目标缓存命中率：相邻两轮 prompt 的公共前缀至少占八成。 */
export const CACHE_TARGET = 0.8;

/**
 * 会随每次调用变化的字段名。这些必须排到 prompt 末尾。
 *
 * 漏一个就等于缓存全废——所以清单宁可长一点，并且有测试盯着。
 */
export const VOLATILE_KEYS: readonly string[] = [
  'observations', 'transcript', 'recent', 'attempt', 'seq', 'step',
];

/**
 * 最末尾的字段：每轮必变、而且很短。
 *
 * 和 transcript 分开是因为两者虽然都变，但 transcript 是**主体内容**——
 * 把它排在 now 前面，能让稳定前缀多覆盖一点；反过来只是把两段短内容换位，没有收益。
 */
export const TAIL_KEYS: readonly string[] = [
  'now', 'at', 'timestamp', 'time', 'trigger', 'cursor', 'previousAttemptError',
  // 会变的会话状态（summary/cursor/affect）也在这里，别让它插在稳定字段中间。
  'state',
];

/** 稳定字段名：这些排前面，越靠前缓存越值钱。 */
export const STABLE_KEYS: readonly string[] = [
  'session', 'subject', 'capabilities', 'boundaries', 'instructions', 'persona',
];

/**
 * 按「稳定 → 慢变 → 快变」重排 context 的键。
 *
 * 为什么要这一层而不是让每个构造器自己注意顺序：顺序错了**不会报错**，只会悄悄变贵。
 * 放在这里统一处理，就不依赖每个调用点记得。
 *
 * 四段顺序固定：稳定（人格/工具清单）→ 其余（记忆、说话人）→ 易变（transcript）
 * → 最末（now 这类每轮必变的短值）。
 */
export function stableOrder(context: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(context);
  const rank = (key: string): number => {
    if (STABLE_KEYS.includes(key)) return 0;
    if (TAIL_KEYS.includes(key)) return 3;
    if (VOLATILE_KEYS.includes(key)) return 2;
    return 1;
  };
  // 同段内保持原顺序：调用方已经按语义排过，这里只做分段。
  const ordered = keys
    .map((key, index) => ({ key, index, rank: rank(key) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(item => item.key);
  return Object.fromEntries(ordered.map(key => [key, context[key]]));
}
