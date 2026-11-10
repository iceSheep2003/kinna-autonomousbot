import type { HotShareConfig } from './config.js';
import { canShare, firstUnseen, nextKeyword, remember, rollDay, EMPTY_STATE, type HotShareState } from './state.js';
import { pick, type SearchFn, type SearchHit } from './search.js';
import { sharePrompt } from './prompt.js';

/** 状态读写由上层注入：worker 只关心「上一次轮到哪」。 */
export interface HotShareStore {
  read(): HotShareState;
  save(state: HotShareState): void;
}

export interface HotShareDeps {
  config: HotShareConfig;
  search: SearchFn;
  store: HotShareStore;
  /** 把候选交给主体；不在这里直接发群。 */
  offer: (offer: HotShareOffer, now: number) => void;
  /** 只用于日志与「今天」的计算。 */
  now?: () => number;
  timezone?: string;
  log?: (message: string) => void;
}

export interface HotShareOffer {
  keyword: string;
  hit: SearchHit;
  /** 给模型看的建议说法；空串表示没什么可说。 */
  prompt: string;
  dryRun: boolean;
}

export interface HotShareResult {
  ran: boolean;
  reason?: string;
  keyword?: string;
  offered?: boolean;
}

const localDay = (now: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

/**
 * 热点分享。
 *
 * 每次运行只做一件事：搜一个关键词，挑一条没见过的，交给主体。
 * 不做热度打分、不做定时播报——**模型是过滤器**：它觉得没意思就不说话，
 * 不说就什么都不发。dryRun 时不投递，只记录它本来会收到什么。
 */
export class HotShareWorker {
  private lastRun = 0;
  constructor(private readonly deps: HotShareDeps) {}

  private time(): number { return this.deps.now?.() ?? Date.now(); }

  /** 到点才跑；由外部定时器驱动，不自己起 timer，便于测试与优雅停止。 */
  async tick(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<HotShareResult> {
    const gate = this.gate();
    if (gate.kind === 'stop') return gate.result;
    const { now, state } = gate;
    const rotated = nextKeyword(state, this.deps.config.keywords);
    if (rotated.keyword === '') return { ran: false, reason: '没有关键词' };
    const hits = await this.search(rotated.keyword, signal);
    if (hits === null) return { ran: false, reason: '搜索失败', keyword: rotated.keyword };
    const hit = firstUnseen(hits, state);
    if (!hit) {
      // 没有新链接：关键词照常推进（这个词眼下没东西），但不记 count。
      this.deps.store.save(rotated.state);
      this.deps.log?.(`hot_share 关键词「${rotated.keyword}」没有新链接`);
      return { ran: false, reason: '没有新链接', keyword: rotated.keyword };
    }
    this.emit(rotated.keyword, hit, now);
    // 记下这条并推进关键词。计数口径是「今天提了几次」，不是「发了几条」：
    // 真正发不发由主体决定，这里限制的是别让它一天收到几十条候选。
    this.deps.store.save(remember(rotated.state, hit.url, { shared: !this.deps.config.dryRun }));
    return { ran: true, keyword: rotated.keyword, offered: !this.deps.config.dryRun };
  }

  /** 前置条件：启用、到间隔、今天还有额度。任一不满足都不跑。 */
  private gate(): { kind: 'go'; now: number; state: HotShareState } | { kind: 'stop'; result: HotShareResult } {
    const { config } = this.deps;
    if (!config.enabled) return { kind: 'stop', result: { ran: false, reason: '未启用' } };
    const now = this.time();
    if (now - this.lastRun < config.intervalMs) return { kind: 'stop', result: { ran: false, reason: '还没到间隔' } };
    this.lastRun = now;
    const state = rollDay(this.deps.store.read() ?? EMPTY_STATE, localDay(now, this.deps.timezone ?? 'Asia/Shanghai'));
    if (!canShare(state, config.dailyLimit, config.dryRun)) return { kind: 'stop', result: { ran: false, reason: '今天够了' } };
    return { kind: 'go', now, state };
  }

  /** 搜索失败返回 null 而不是抛错：失败不该推进关键词，下次照同一个词再试。 */
  private async search(keyword: string, signal: AbortSignal): Promise<SearchHit[] | null> {
    try {
      return pick(await this.deps.search(keyword, signal));
    } catch (error) {
      this.deps.log?.(`hot_share 搜索失败：${(error as Error).message}`);
      return null;
    }
  }

  /** dryRun 只记日志；真要分享才把候选交给主体。 */
  private emit(keyword: string, hit: SearchHit, now: number): void {
    if (this.deps.config.dryRun) {
      this.deps.log?.(`[dryRun] 本来会提：${hit.title}`);
      return;
    }
    this.deps.offer({ keyword, hit, prompt: sharePrompt(keyword, hit), dryRun: false }, now);
  }
}
