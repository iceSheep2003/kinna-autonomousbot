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
  /** 抽帧：返回本次实际取到的帧数与容器内路径；模型看不到字节。 */
  frames(input: { bvid: string; page: number; count: number; width: number; at?: number[] }, signal: AbortSignal): Promise<{ frames: string[]; durationSeconds: number }>;
}

export interface BilibiliMessages {
  comments(input: { aid: number; bvid: string; limit: number; sort: 'time' | 'hot' }, signal: AbortSignal): Promise<Array<{ rpid: number; text: string; user: string; likes: number; replies: number; at: number }>>;
  postComment(input: { aid: number; bvid: string; message: string; rootRpid?: number; parentRpid?: number }, signal: AbortSignal): Promise<{ rpid: number }>;
  postDynamic(input: { content: string }, signal: AbortSignal): Promise<{ dynamicId: string }>;
}

/** 帧 → 理解。实现方（视觉模型或外部感知服务）返回文字，不返回原始字节。 */
export interface FramePerception {
  describe(input: { bvid: string; frames: string[]; question: string }, signal: AbortSignal): Promise<string>;
}

/** 抽帧后的理解与清理由这个端口统一负责，集成层不直接读删文件。 */
export interface FrameReader {
  describe(input: { bvid: string; frames: string[]; question: string; perception: FramePerception; signal: AbortSignal }): Promise<{ text: string; frames: number }>;
}

export type { Draft, PostKind, PostQuota, VideoMeta };
