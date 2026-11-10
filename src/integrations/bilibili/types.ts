import { z } from 'zod';

/** B 站账号相关配置。登录态只从部署环境读取，不落配置文件、不进模型上下文。 */
export const BilibiliConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 只允许读这些 UP 主的视频（mid）。空表示任何视频都能读。 */
  allowedMids: z.array(z.string().regex(/^\d{1,20}$/)).default([]),
  /** 发评论：off = 不发；draft = 只存草稿等人批；direct = 校验通过就直接发。 */
  commentPolicy: z.enum(['off', 'draft', 'direct']).default('draft'),
  /** 发动态：同上。 */
  dynamicPolicy: z.enum(['off', 'draft', 'direct']).default('draft'),
  /** 一天最多真正发出多少条评论/动态，防止一次回放把话说完。 */
  maxPostsPerDay: z.number().int().min(0).max(50).default(5),
  /** 是否启用无头浏览器读视频（需要 playwright）；关掉后只能读评论、出草稿。 */
  readVideo: z.boolean().default(true),
  /** 每日任务：每天要看完并评论几条视频。0 表示不做日常。 */
  dailyVideos: z.number().int().min(0).max(10).default(3),
  /** 读视频时最多截几张图。每张图按 DeepSeek 的计费上限约 1024 token。 */
  maxFrames: z.number().int().min(1).max(8).default(6),
  /** 截图文件对外可访问的地址前缀；DeepSeek 自己下载，所以必须是公网可达的。 */
  publicBaseUrl: z.string().url().optional(),
  /** 传给 ffmpeg 的超时；视频流最长两分钟有效，下载必须快。 */
  fetchTimeoutMs: z.number().int().min(5000).max(120000).default(60000),
  /** 评论草稿 > 24h 自动过期，避免深夜的草稿白天还被人批准。 */
  draftTtlMs: z.number().int().min(60000).max(7 * 86_400_000).default(24 * 3_600_000),
});
export type BilibiliConfig = z.infer<typeof BilibiliConfigSchema>;

export const CredentialsSchema = z.object({
  sessdata: z.string().min(1),
  biliJct: z.string().min(1),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export type PostKind = 'comment' | 'dynamic';

/** 一条待批准的公开动作。只存文本和引用，不存 cookie。 */
export interface Draft {
  id: string;
  kind: PostKind;
  /** 评论：目标的 bvid + aid + 被回复的评论 rpid；动态：无。 */
  targetBvid?: string;
  targetAid?: number;
  rootRpid?: number;
  parentRpid?: number;
  /** 正文。动态的正文里可含视频链接。 */
  content: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  /** 被谁批准 / 拒绝，以及理由，只存 id 不存密钥。 */
  decidedAt?: number;
  decidedBy?: string;
  decisionNote?: string;
  /** 真正发出后的平台回执（评论 rpid / 动态 id）。 */
  postedAt?: number;
  postedId?: string;
}

export interface PostReceipt {
  kind: PostKind;
  id: string;
  at: number;
}

/** B 站账号的「今天发了几条」账本；按自然日重置。 */
export interface PostQuota {
  day: number; comments: number; dynamics: number;
}

export const VIDEO_REF = /^BV[0-9A-Za-z]{10}$/;

export interface VideoMeta {
  bvid: string; aid: number; cid: number; title: string; ownerMid: string; ownerName: string;
  durationSeconds: number; desc: string; pages: Array<{ cid: number; title: string; page: number }>;
}
