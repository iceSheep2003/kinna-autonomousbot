import type { Draft, PostKind, PostQuota, VideoMeta } from './types.js';

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
  /** 下载视频流的指定时间片段（容器内异步暂存，不返回字节）。 */
  clip(request: { url: string; startSeconds: number; endSeconds: number; signal: AbortSignal; dir?: string; name?: string }): Promise<MediaClip>;
}

export interface MediaClip { path: string; cleanup(): void }

export interface BilibiliVideo {
  meta(bvid: string, page: number, signal: AbortSignal): Promise<VideoMeta>;
}

export interface BilibiliMessages {
  comments(input: { aid: number; bvid: string; limit: number; sort: 'time' | 'hot' }, signal: AbortSignal): Promise<Array<{ rpid: number; text: string; user: string; likes: number; replies: number; at: number }>>;
  postComment(input: { aid: number; bvid: string; message: string; rootRpid?: number; parentRpid?: number }, signal: AbortSignal): Promise<{ rpid: number }>;
  postDynamic(input: { content: string }, signal: AbortSignal): Promise<{ dynamicId: string }>;
}

/**
 * 按热度选点，再让无头浏览器在播放页截图。
 *
 * 为什么不用 ffmpeg 抽帧：本地抽帧要装编解码器、要下载视频流，还得把图编码进请求；
 * B 站的播放页本身就是播放器，截图是浏览器自带的能力，截出来的图可以直接给
 * DeepSeek 看（它接受外部 URL 与多图输入）。这一层只返回稳定的图片 URL。
 */
export interface VideoShots {
  /** 截几个点；at 为空时由实现按热度自行选点。 */
  capture(input: { bvid: string; timestamp: number; count: number; at?: number[]; signal: AbortSignal }): Promise<{ shots: Array<{ url: string; at: number }>; durationSeconds: number }>;
}

/**
 * 高能进度条：B 站按采样间隔统计「每秒弹幕发送量」，也就是观众在哪些时刻最密集。
 * 它不是播放量的热度，而是**注意力**的热度：大部分人拖回去看、或者发弹幕的时刻都在里面。
 */
export interface HeatSampler {
  heat(input: { bvid: string; cid: number; signal: AbortSignal }): Promise<{ stepSeconds: number; points: number[] } | null>;
}

export type { Draft, PostKind, PostQuota, VideoMeta };
