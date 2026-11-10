import type { Session, SessionRefresher, SessionStore } from '../integrations/bilibili/session.js';

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
   * 该刷新就刷新。返回是否发生了刷新；网络或接口异常时保留原会话。
   * 没有 refresh_token 的会话（来自环境变量）不会尝试刷新。
   */
  async ensureFresh(signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<{ refreshed: boolean; reason?: string }> {
    const session = this.current;
    if (!session) return { refreshed: false, reason: '没有登录会话' };
    if (this.time() - this.lastCheckedAt < (this.deps.checkIntervalMs ?? DAY)) return { refreshed: false, reason: '还没到检查时间' };
    this.lastCheckedAt = this.time();
    if (!session.refreshToken) return { refreshed: false, reason: '没有 refresh_token，需要重新扫码登录才能续期' };
    try {
      const next = await this.deps.refresher.refreshIfNeeded(session, signal);
      if (!next) return { refreshed: false, reason: 'B 站认为当前 Cookie 还不需要刷新' };
      this.adopt(next);
      return { refreshed: true };
    } catch (error) {
      // 保留旧会话：刷新失败不代表旧 Cookie 立刻失效。
      return { refreshed: false, reason: `刷新失败：${(error as Error).message}` };
    }
  }
}
