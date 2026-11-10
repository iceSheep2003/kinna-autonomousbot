import { RefreshUnavailable, type Session, type SessionRefresher, type SessionStore } from '../integrations/bilibili/session.js';

/** 续期检查的结果。区分「不需要」与「失败」，避免制造误导性告警。 */
export type RefreshOutcome = 'refreshed' | 'not-needed' | 'unavailable' | 'failed' | 'not-due' | 'no-session';

const DAY = 86_400_000;

export interface SessionHostDeps {
  store: SessionStore;
  refresher: SessionRefresher;
  /** 除了「B 站说该刷新了」，也允许超过这么久强制检查一次。 */
  checkIntervalMs?: number;
  now?: () => number;
}

/**
 * 登录会话的托管者。
 *
 * 它只做两件事：启动时把已有会话装载好，每日检查一次「该不该刷新」并刷新。
 * 刷新失败不会丢掉旧会话——旧 Cookie 可能还能用几天，直接清掉等于让账号突然下线。
 * 真正失效（接口返回 -101）时由传输层标记，下一次检查会提示重新扫码。
 */
export class SessionHost {
  private current: Session | undefined;
  private lastCheckedAt = 0;
  constructor(private readonly deps: SessionHostDeps) {
    this.current = deps.store.read();
  }

  private time(): number { return this.deps.now?.() ?? Date.now(); }

  session(): Session | undefined { return this.current; }

  /** 登录后由 HTTP 接口调用：保存并立即生效。 */
  adopt(session: Session): Session {
    this.deps.store.save(session);
    this.current = session;
    this.lastCheckedAt = this.time();
    return session;
  }

  clear(): void { this.deps.store.clear(); this.current = undefined; }

  /** Cookie 已被平台判定失效：只标记，不清库，方便排查和手动替换。 */
  markInvalid(reason: string): void {
    if (!this.current) return;
    this.current = { ...this.current, verifiedAt: 0 };
    void reason;
  }

  /**
   * 该刷新就刷新。三种结果分开报，别把「不需要」说成「失败」：
   * - refreshed：真的换了新 Cookie；
   * - not-needed：B 站认为当前 Cookie 仍然有效（最常见，也是最正常的情况）；
   * - unavailable：平台这次没发放 refresh_csrf，会话仍可用，只是这次续不了。
   * 网络或接口异常时一律保留原会话。
   */
  async ensureFresh(signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<{ outcome: RefreshOutcome; reason?: string }> {
    const session = this.current;
    if (!session) return { outcome: 'no-session', reason: '没有登录会话' };
    if (this.time() - this.lastCheckedAt < (this.deps.checkIntervalMs ?? DAY)) return { outcome: 'not-due', reason: '还没到检查时间' };
    this.lastCheckedAt = this.time();
    if (!session.refreshToken) return { outcome: 'unavailable', reason: '没有 refresh_token，需要重新扫码登录才能续期' };
    try {
      const next = await this.deps.refresher.refreshIfNeeded(session, signal);
      if (!next) return { outcome: 'not-needed', reason: 'B 站认为当前 Cookie 还不需要刷新' };
      this.adopt(next);
      return { outcome: 'refreshed' };
    } catch (error) {
      // 平台没发放续期能力 vs 真的出错：前者不是故障，后者才需要关注。
      const unavailable = error instanceof RefreshUnavailable;
      return { outcome: unavailable ? 'unavailable' : 'failed', reason: (error as Error).message };
    }
  }
}
