import { randomUUID } from 'node:crypto';
import type { BilibiliConfig, Draft, PostKind } from './types.js';
import type { BilibiliState, BilibiliMessages } from './ports.js';
import { admitPost, canApprove, checkContent, explainCode, remainingQuota, type Refusal } from './policy.js';

const DAY = 86_400_000;
const dayOf = (now: number): number => Math.floor(now / DAY);

export interface ApprovalResult { ok: boolean; reason?: string; draft?: Draft }
export interface DecideOptions { by?: string; note?: string }

interface PostTarget { targetBvid?: string; targetAid?: number; rootRpid?: number; parentRpid?: number }

/**
 * 公开动作的草稿队列与批准。
 *
 * 模型（self / scene / execution 任一）只能提草稿，批准走 owner 的 HTTP 接口；
 * 真正发出去还要过额度。这样「梦里多想了」最多变成一条等人的草稿，不会变成一条公开评论。
 */
export class DraftQueue {
  constructor(private readonly deps: { state: BilibiliState; config: BilibiliConfig; messages: BilibiliMessages; now?: () => number }) {}

  private time(): number { return this.deps.now?.() ?? Date.now(); }

  /** 提交一条公开动作：内容不合格、策略关闭或额度用完时直接拒绝，不建草稿。 */
  /**
   * 提交一条公开动作。策略为 direct 时在这里直接发出；draft 时只入队等人批。
   * 两条路都要先过正文规则与每日额度。
   */
  async submit(input: { kind: PostKind; content: string; reason: string } & PostTarget): Promise<
    { ok: true; draft: Draft; posted?: string } | { ok: false; reason: string }> {
    const admitted = admitPost(input.kind, { policy: this.policyOf(input.kind), enabled: this.deps.config.enabled });
    if (admitted.stage === 'refuse') return { ok: false, reason: `${input.kind === 'comment' ? '评论' : '动态'}发布已关闭` };
    const refusal = this.validate(input.kind, input.content);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    const draft = this.draftOf(input);
    if (admitted.stage === 'direct') {
      const sent = await this.send(draft, { by: 'direct' });
      if (sent.ok) return { ok: true, draft: sent.draft!, posted: sent.draft!.postedId };
      // 直接发失败：留一条 rejected 记录供事后查，但不留在待批队列里假装还能批。
      this.deps.state.saveDraft({ ...draft, status: 'rejected', decidedAt: this.time(), decisionNote: (sent.reason ?? '发送失败').slice(0, 500) });
      return { ok: false, reason: sent.reason ?? '发送失败' };
    }
    this.deps.state.saveDraft(draft);
    return { ok: true, draft };
  }

  /** 组装草稿记录；目标字段有才写，避免存一堆 undefined。 */
  private draftOf(input: { kind: PostKind; content: string; reason: string } & PostTarget): Draft {
    const now = this.time();
    return {
      id: `draft-${randomUUID()}`, kind: input.kind, content: input.content.trim(),
      reason: input.reason.slice(0, 500), createdAt: now, expiresAt: now + this.deps.config.draftTtlMs, status: 'pending',
      ...(input.targetBvid ? { targetBvid: input.targetBvid } : {}),
      ...(typeof input.targetAid === 'number' ? { targetAid: input.targetAid } : {}),
      ...(typeof input.rootRpid === 'number' ? { rootRpid: input.rootRpid } : {}),
      ...(typeof input.parentRpid === 'number' ? { parentRpid: input.parentRpid } : {}),
    };
  }

  /** 正文规则 + 当日额度；返回拒绝原因，undefined 表示可以发。 */
  private validate(kind: PostKind, content: string): string | undefined {
    const checked = checkContent(kind, content);
    if (!checked.ok) return checked.reason;
    return this.used(kind) >= this.deps.config.maxPostsPerDay ? '今天的公开发布额度已用完' : undefined;
  }

  pending(limit = 20): Draft[] { return this.deps.state.pendingDrafts(this.time(), limit).filter(item => item.status === 'pending'); }

  get(id: string): Draft | undefined { return this.deps.state.draft(id); }

  /**
   * 批准并发送。`on` 与 `draft` 都是「批准后才发」：区别只在于 `on` 允许在没有人工时
   * 由定时任务里的 owner 令牌直接批准（仍然要显式批准请求），`draft` 必须有人点。
   */
  async approve(id: string, options: DecideOptions = {}): Promise<ApprovalResult> {
    const draft = this.deps.state.draft(id);
    const allowed = canApprove(draft, this.time());
    if (!allowed.ok) return { ok: false, reason: allowed.reason };
    if (this.used(draft!.kind) >= this.deps.config.maxPostsPerDay) return { ok: false, reason: '今天的公开发布额度已用完' };
    return this.send(draft!, options);
  }

  reject(id: string, options: DecideOptions = {}): ApprovalResult {
    const draft = this.deps.state.draft(id);
    if (!draft) return { ok: false, reason: '草稿不存在' };
    if (draft.status !== 'pending') return { ok: false, reason: `草稿状态是 ${draft.status}` };
    const next: Draft = { ...draft, status: 'rejected', decidedAt: this.time(), ...(options.by ? { decidedBy: options.by } : {}), ...(options.note ? { decisionNote: options.note } : {}) };
    this.deps.state.saveDraft(next);
    return { ok: true, draft: next };
  }

  /** 把该过期的草稿标掉；由调用方在每次读取时顺手执行。 */
  expire(now = this.time()): number {
    let count = 0;
    for (const draft of this.deps.state.pendingDrafts(now, 100)) {
      if (now >= draft.expiresAt) { this.deps.state.saveDraft({ ...draft, status: 'expired' }); count++; }
    }
    return count;
  }

  used(kind: PostKind): number {
    const quota = this.deps.state.quota(dayOf(this.time()));
    return kind === 'comment' ? quota.comments : quota.dynamics;
  }

  remaining(kind: PostKind): number {
    return remainingQuota(kind, this.used(kind), this.deps.config.maxPostsPerDay);
  }

  private policyOf(kind: PostKind): 'off' | 'draft' | 'direct' {
    return kind === 'comment' ? this.deps.config.commentPolicy : this.deps.config.dynamicPolicy;
  }

  /** 真正发送；回执写回草稿，账本 +1。失败不扣额度，但也不自动重试。 */
  private async send(draft: Draft, options: DecideOptions): Promise<ApprovalResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.config.fetchTimeoutMs);
    timer.unref?.();
    try {
      const postedId = await this.deliver(draft, controller.signal);
      const posted: Draft = { ...draft, status: 'approved', postedAt: this.time(), postedId,
        decidedAt: this.time(), ...(options.by ? { decidedBy: options.by } : {}), ...(options.note ? { decisionNote: options.note } : {}) };
      this.deps.state.saveDraft(posted);
      this.bump(draft.kind);
      return { ok: true, draft: posted };
    } catch (error) {
      const reason = String((error as Error)?.message ?? error);
      // 是平台明确拒绝还是一次结果不明，都写回草稿；结果不明时绝不自动重发。
      this.deps.state.saveDraft({ ...draft, decisionNote: explainCode(0, reason).slice(0, 500) });
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按草稿类型调用对应写接口，统一返回平台回执 id。 */
  private async deliver(draft: Draft, signal: AbortSignal): Promise<string> {
    if (draft.kind === 'dynamic') {
      const receipt = await this.deps.messages.postDynamic({ content: draft.content }, signal);
      return receipt.dynamicId;
    }
    const receipt = await this.deps.messages.postComment({
      aid: draft.targetAid ?? 0, bvid: draft.targetBvid ?? '', message: draft.content,
      ...(draft.rootRpid ? { rootRpid: draft.rootRpid } : {}), ...(draft.parentRpid ? { parentRpid: draft.parentRpid } : {}),
    }, signal);
    return String(receipt.rpid);
  }

  private bump(kind: PostKind): void {
    const day = dayOf(this.time());
    const quota = this.deps.state.quota(day);
    this.deps.state.saveQuota({ day, comments: quota.comments + (kind === 'comment' ? 1 : 0), dynamics: quota.dynamics + (kind === 'dynamic' ? 1 : 0) });
  }
}

export type { Refusal };
