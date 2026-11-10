import type { Draft, PostKind, PostQuota, VideoMeta } from './types.js';
import type { HeatSample } from './heat.js';
import type { TodoDay } from './todo.js';

/** 只是 B 站账号的读取与写回执；仓库不由模型可见。 */
export interface BilibiliState {
  draft(id: string): Draft | undefined;
  saveDraft(draft: Draft): void;
  pendingDrafts(now: number, limit: number): Draft[];
  /** 当天已发出的评论/动态数。 */
  quota(day: number): PostQuota;
  saveQuota(quota: PostQuota): void;
  /** 最近发出的公开动作，供主动频率与去重使用。 */
  recentPosts(limit: number): Draft[];
}

/** 每日任务（todo）的读取：只存「今天做了几条」，不存视频内容。 */
export interface BilibiliTodoStore {
  read(): TodoDay | undefined;
  save(day: TodoDay): void;
  /** 最近若干天的记录，用于看板与「昨天为什么没做完」。 */
  history(days: number): TodoDay[];
  lastRemindedAt?(): number;
  markReminded?(at: number): void;
}

/** 一次 B 站 HTTP 调用。凭证由传输层持有，能力与模型都拿不到。 */
export interface BilibiliRequest {
  method: 'GET' | 'POST';
  path: string; // 例如 /x/web-interface/view
  base?: 'api' | 'vc';
  query?: Record<string, string | number>;
  form?: Record<string, string | number>;
  json?: unknown;
  /** 写操作必须带 CSRF（即 bili_jct），由传输层自动附上。 */
  csrf?: boolean;
  signal: AbortSignal;
}

export interface BilibiliTransport {
  request<T>(request: BilibiliRequest): Promise<T>;
  /** 非 JSON 的接口（弹幕 XML）。 */
  text(request: BilibiliRequest): Promise<string>;
}


export interface BilibiliVideo {
  meta(bvid: string, page: number, signal: AbortSignal): Promise<VideoMeta>;
}

/** 找一个可看的视频。self 要靠它挑今天看什么，而不是等别人给 bvid。 */
export interface BilibiliFeed {
  discover(input: { limit: number; source: 'recommend' | 'popular' | 'ranking'; signal: AbortSignal }): Promise<Array<{
    bvid: string; title: string; owner: string; durationSeconds: number; play: number; category: string;
  }>>;
}

/** 按关键词找视频：让 self 能顺着自己记得的事去找，而不是只看平台推荐。 */
export interface BilibiliSearch {
  search(input: { query: string; limit: number; signal: AbortSignal }): Promise<Array<{
    bvid: string; title: string; owner: string; durationSeconds: number; play: number; category: string;
  }>>;
}

export interface BilibiliMessages {
  comments(input: { aid: number; bvid: string; limit: number; sort: 'time' | 'hot' }, signal: AbortSignal): Promise<Array<{ rpid: number; text: string; user: string; likes: number; replies: number; at: number }>>;
  postComment(input: { aid: number; bvid: string; message: string; rootRpid?: number; parentRpid?: number }, signal: AbortSignal): Promise<{ rpid: number }>;
  postDynamic(input: { content: string }, signal: AbortSignal): Promise<{ dynamicId: string }>;
  /** 撤回自己发的评论/动态。只用于纠正错误，不是日常操作。 */
  deleteComment(input: { aid: number; rpid: number }, signal: AbortSignal): Promise<void>;
  deleteDynamic(input: { dynamicId: string }, signal: AbortSignal): Promise<void>;
}

/**
 * 按热度选点，再让无头浏览器在播放页截图。
 *
 * 为什么不用 ffmpeg 抽帧：本地抽帧要装编解码器、要下载视频流，还得把图编码进请求；
 * B 站的播放页本身就是播放器，截图是浏览器自带的能力，截出来的图可以直接给
 * DeepSeek 看（它接受外部 URL 与多图输入）。这一层只返回稳定的图片 URL。
 */
export interface VideoShots {
  /** 在给定的几个秒数上截图；streamUrl 是 playurl 拿到的 DASH 地址。 */
  capture(input: { bvid: string; streamUrl: string; at: number[]; signal: AbortSignal }): Promise<{ shots: Array<{ url: string; at: number }> }>;
}

/**
 * 观众在哪些秒有反应。取弹幕的时间戳（真实行为，不是播放量），失败返回 null。
 * 不依赖 pbp 高能进度条：该接口在本机实测已 404，而弹幕是同一件事的原始证据。
 */
export interface HeatSampler {
  heat(input: { bvid: string; cid: number; aid: number; signal: AbortSignal }): Promise<HeatSample | null>;
}

export type { Draft, PostKind, PostQuota, VideoMeta };
