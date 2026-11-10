/**
 * 热点分享的配置。
 *
 * 原则同线上：一切都是 opt-in，且默认配置不允许真的发出去——
 * `dryRun` 默认开、每日上限默认 1。半配置好的部署不该开口。
 */
export interface HotShareConfig {
  enabled: boolean;
  /** 只要打开就只生成机会、不投递（观察它想说什么，而不真的说）。 */
  dryRun: boolean;
  /** 多久看一次。 */
  intervalMs: number;
  /** 每天最多分享几条。 */
  dailyLimit: number;
  /** 轮换的关键词；依次取用，避免每次都搜同一个词。 */
  keywords: readonly string[];
  /** 关键词轮换的位置存在状态里，重启不会总从第一个开始。 */
  statePath: string;
}

export const DEFAULT_KEYWORDS: readonly string[] = ['408 考研', '计算机 就业', '考研 复习 方法', '编程 学习'];

export const DEFAULT_HOT_SHARE: HotShareConfig = {
  enabled: false,
  dryRun: true,
  intervalMs: 90 * 60_000,
  dailyLimit: 1,
  keywords: DEFAULT_KEYWORDS,
  statePath: '',
};

const bool = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw.trim() === '' ? fallback : raw.trim().toLowerCase() === 'true';

/**
 * 读一个数字型环境变量。
 * 空字符串必须当成「没配」——`Number('')` 是 0，会让「每天上限」直接变成 0 条，
 * 配置没写反而禁用了功能，这种坑不能留。
 */
function numberOr(raw: string | undefined, fallback: number, clamp: (value: number) => number): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? clamp(value) : fallback;
}

/** 从环境变量读配置；坏值退回默认而不是抛错，缺省即关闭。 */
export function hotShareFromEnv(env: Record<string, string | undefined>): HotShareConfig {
  const keywords = (env.BOT_HOT_SHARE_KEYWORDS ?? '').split(',').map(word => word.trim()).filter(word => word !== '');
  return {
    enabled: bool(env.BOT_HOT_SHARE_ENABLED, false),
    dryRun: bool(env.BOT_HOT_SHARE_DRY_RUN, true),
    // 间隔至少 1 分钟：负数或 0 会让 worker 每轮都跑，等于压测自己的搜索配额。
    intervalMs: numberOr(env.BOT_HOT_SHARE_INTERVAL_MINUTES, DEFAULT_HOT_SHARE.intervalMs / 60_000,
      minutes => (minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_HOT_SHARE.intervalMs)),
    dailyLimit: numberOr(env.BOT_HOT_SHARE_DAILY_LIMIT, DEFAULT_HOT_SHARE.dailyLimit,
      value => Math.min(10, Math.max(0, Math.floor(value)))),
    keywords: keywords.length > 0 ? keywords : DEFAULT_KEYWORDS,
    statePath: env.BOT_HOT_SHARE_STATE_PATH?.trim() ?? '',
  };
}
