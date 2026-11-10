import type { Credentials } from './types.js';

/**
 * 一份可托管的登录会话。
 *
 * 只保存登录真正需要的字段：两个 Cookie、一个持久化 refresh_token、登录时间。
 * 不保存密码——密码登录要过风控验证码，不适合无人值守；扫码登录拿到的东西一样多，
 * 而且不需要在服务器上存密码。
 */
export interface Session {
  sessdata: string;
  biliJct: string;
  /** 登录时返回的 ac_time_value，刷新 Cookie 时要用；没有它就只能等 Cookie 自然过期。 */
  refreshToken?: string;
  /** 登录/刷新时的毫秒时间戳。 */
  obtainedAt: number;
  /** 最近一次成功刷新或校验通过的时间。 */
  verifiedAt?: number;
  /** 一次都没有 refreshToken 时，只能靠登录者自己的会话有效期。 */
  source: 'qr' | 'env' | 'manual';
}

export interface SessionStore {
  read(): Session | undefined;
  save(session: Session): void;
  clear(): void;
}

export function credentialsOf(session: Session | undefined): Credentials | undefined {
  if (!session?.sessdata || !session.biliJct) return undefined;
  return { sessdata: session.sessdata, biliJct: session.biliJct };
}

/** 从环境变量来的会话只能读不能刷新：没有 refresh_token，过期就得重新登录。 */
export function sessionFromEnv(env: Record<string, string | undefined>, now = Date.now()): Session | undefined {
  const sessdata = env.BILIBILI_SESSDATA?.trim();
  const biliJct = env.BILIBILI_BILI_JCT?.trim();
  if (!sessdata || !biliJct) return undefined;
  return { sessdata, biliJct, obtainedAt: now, source: 'env',
    ...(env.BILIBILI_REFRESH_TOKEN?.trim() ? { refreshToken: env.BILIBILI_REFRESH_TOKEN.trim() } : {}) };
}

/** 二维码登录的轮询状态码；数字是 B 站定义的，别改。 */
export const QR_CODE = {
  success: 0,
  expired: 86038,
  scanned: 86090,
  waiting: 86101,
} as const;

/** 会话托管需要的刷新能力；实现由基础设施层提供，应用层只认这个窄接口。 */
export interface SessionRefresher {
  /** 该刷新就刷新，返回新会话；不需要或失败返回 undefined，由调用方决定是否保留旧会话。 */
  refreshIfNeeded(session: Session, signal: AbortSignal): Promise<Session | undefined>;
}
