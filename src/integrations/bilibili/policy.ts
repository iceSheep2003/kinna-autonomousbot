/**
 * B 站公开动作的规则，全部是纯函数：谁能发、发之前要什么、一天发几条。
 *
 * 为什么这么严：群聊里说错一句话，最多是这一个群的人看到；B 站评论和动态
 * 是挂在真实账号上的公开内容，发出去就删不干净。所以这里没有「self 想发就发」
 * 的路径，只有「出草稿 → 有人批准 → 还在额度内」三条同时满足才真的发出去。
 */
import type { Draft, PostKind } from './types.js';

export const COMMENT_MAX_CHARS = 1000;
export const DYNAMIC_MAX_CHARS = 2000;
/** 公开言论里出现这些就该停下来等人看，而不是自己发。 */
const SENSITIVE = ['身份证', '手机号', '银行卡', '密码', '住址', '微信号', 'qq号', '私聊我'];

export type Refusal = { ok: true } | { ok: false; reason: string };

/** 正文规则：长度、空白、明显不该公开的内容。 */
export function checkContent(kind: PostKind, content: string): Refusal {
  const text = content.trim();
  if (text === '') return { ok: false, reason: '内容为空' };
  const limit = kind === 'comment' ? COMMENT_MAX_CHARS : DYNAMIC_MAX_CHARS;
  if (text.length > limit) return { ok: false, reason: `超过 ${limit} 字` };
  // 纯链接、纯表情也算「没话说」，不替账号刷存在感。
  if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) return { ok: false, reason: '内容里没有实际文字' };
  if (text.includes('http') && kind === 'comment') return { ok: false, reason: '评论里不放外链' };
  const hit = SENSITIVE.filter(word => text.includes(word));
  if (hit.length) return { ok: false, reason: `含不适合公开的个人信息：${hit.join('、')}` };
  return { ok: true };
}

/** 这条视频让不让读。空白名单表示不限制。 */
export function canReadVideo(ownerMid: string, allowedMids: readonly string[]): Refusal {
  if (allowedMids.length === 0) return { ok: true };
  return allowedMids.includes(ownerMid) ? { ok: true } : { ok: false, reason: `这个 UP 主(${ownerMid})不在读取白名单里` };
}

export type PostPolicy = 'off' | 'draft' | 'direct';
export interface DecideInput {
  policy: PostPolicy;
  /** 当前批次的评论/动态是否 enabled；关掉后连草稿都不写。 */
  enabled: boolean;
}

/**
 * 决定一次公开动作现在能走到哪一步：
 * - off：直接拒绝，连草稿都不建；
 * - draft：只建草稿，等人批准后再发；
 * - direct：正文与额度校验通过后直接发出，不建草稿。
 *
 * 注意 direct 仍然要过 `checkContent`（长度、空白、个人信息）与每日额度，
 * 「直接发」不等于「不检查」。
 */
export function admitPost(kind: PostKind, input: DecideInput): { stage: 'refuse' } | { stage: 'draft' | 'direct' } {
  void kind;
  if (!input.enabled || input.policy === 'off') return { stage: 'refuse' };
  return { stage: input.policy === 'direct' ? 'direct' : 'draft' };
}

/** 今天还能不能发。返回还要发的额度，0 表示用完了。 */
export function remainingQuota(kind: PostKind, used: number, maxPerDay: number): number {
  void kind;
  return Math.max(0, maxPerDay - used);
}

/** 草稿过期不批就作废：深夜写的草稿，白天醒来不该被一句话批准发出去。 */
export function isExpired(draft: Draft, now: number): boolean {
  return draft.status === 'pending' && now >= draft.expiresAt;
}

/** 批准前的最后一道检查：草稿可能已经被别处改过内容。 */
export function canApprove(draft: Draft | undefined, now: number): Refusal {
  if (!draft) return { ok: false, reason: '草稿不存在' };
  if (draft.status !== 'pending') return { ok: false, reason: `草稿状态是 ${draft.status}，不能批准` };
  if (isExpired(draft, now)) return { ok: false, reason: '草稿已过期' };
  return checkContent(draft.kind, draft.content);
}

export const COMMENT_REFUSALS: Record<number, string> = {
  [-101]: '账号未登录（SESSDATA 失效）',
  [-111]: 'csrf 校验失败（bili_jct 不对）',
  [-509]: '请求过于频繁',
  12002: '评论区已关闭',
  12003: '禁止回复',
  12006: '没有该评论',
  12009: '评论主体类型不合法',
  12015: '需要评论验证码',
  12016: '内容包含敏感信息',
  12025: '评论字数过多',
  12035: '被 UP 主列入评论黑名单',
  12051: '重复评论，请勿刷屏',
};

/** 把 B 站返回码翻译成人话；未知码原样报出，不假装成功。 */
export function explainCode(code: number, fallback: string): string {
  return COMMENT_REFUSALS[code] ?? `${fallback}（code ${code}）`;
}

/**
 * 抽帧时间点：避开片头（标题卡）和片尾（关注引导），只看中间的正文。
 * 帧数已在前一层限定，这里只负责「落在有效区间、均匀分布」。
 */
export function exploreRange(durationSeconds: number, count: number): number[] {
  const seconds = Math.max(1, durationSeconds);
  const n = Math.max(1, Math.min(24, count));
  return Array.from({ length: n }, (_, index) => seconds * (0.05 + 0.9 * (index / Math.max(1, n - 1))));
}

/**
 * 画面理解一致性检查：模型交回来的「细节」必须真的出现在画面理解里，
 * 否则就是它在脑补——这是「读视频」最容易被当成看图说话的地方。
 * 返回写进答案的细节列表，以及被丢掉的细节。
 */
export function groundedPoints(points: readonly string[], frameReading: string): { kept: string[]; dropped: string[] } {
  const material = frameReading.replace(/\s+/g, '');
  const kept: string[] = []; const dropped: string[] = [];
  for (const point of points) {
    const tokens = [...point.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')];
    if (tokens.length <= 6) { (material.includes(tokens.join('')) ? kept : dropped).push(point); continue; }
    const hit = tokens.filter((_, index) => index % 3 === 0).filter(token => material.includes(token)).length;
    (hit / Math.max(1, Math.ceil(tokens.length / 3)) >= 0.6 ? kept : dropped).push(point);
  }
  return { kept, dropped };
}
