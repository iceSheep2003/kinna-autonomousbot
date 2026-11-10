/**
 * 分享状态：说过哪些链接、今天说了几条、关键词轮到哪。
 *
 * 去重按 URL 做——同一个链接第二次搜到没有新东西可说，
 * 但**同一话题的不同文章**要允许：读者想知道的是「发生了什么」，不是「同一篇」。
 */
export interface HotShareState {
  /** 已经分享/尝试过的 URL，避免反复提同一条。 */
  seen: string[];
  /** 当天已真正分享的条数（dryRun 不计入）。 */
  day: string;
  count: number;
  /** 关键词轮换位置。 */
  cursor: number;
}

export const EMPTY_STATE: HotShareState = { seen: [], day: '', count: 0, cursor: 0 };

const MAX_SEEN = 200;

/** 按本地日期算「今天」；跨日归零计数，但保留去重记录与轮换位置。 */
export function rollDay(state: HotShareState, day: string): HotShareState {
  return state.day === day ? state : { ...state, day, count: 0 };
}

/** 取下一个关键词并推进轮换；关键词列表变了也不会越界。 */
export function nextKeyword(state: HotShareState, keywords: readonly string[]): { keyword: string; state: HotShareState } {
  if (keywords.length === 0) return { keyword: '', state };
  const index = state.cursor % keywords.length;
  return { keyword: keywords[index]!, state: { ...state, cursor: (index + 1) % keywords.length } };
}

/** 是否还能再说一条。dryRun 不占额度——它本来就没发出去。 */
export function canShare(state: HotShareState, dailyLimit: number, dryRun: boolean): boolean {
  return dryRun || state.count < dailyLimit;
}

/** 记下「这条处理过了」；超量时丢最早的，避免状态无限长。 */
export function remember(state: HotShareState, url: string, options: { shared: boolean }): HotShareState {
  const seen = state.seen.includes(url) ? state.seen : [...state.seen, url].slice(-MAX_SEEN);
  return { ...state, seen, count: options.shared ? state.count + 1 : state.count };
}

/** 挑一条没见过的：优先有摘要的，优先新日期。 */
export function firstUnseen<T extends { url: string; summary: string; date: string }>(hits: readonly T[], state: HotShareState): T | undefined {
  const fresh = hits.filter(hit => !state.seen.includes(hit.url));
  return fresh.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.summary.length - a.summary.length)[0];
}
