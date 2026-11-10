import { QR_CODE, type Session, type SessionRefresher } from '../../integrations/bilibili/session.js';

const PASSPORT = 'https://passport.bilibili.com';
const WWW = 'https://www.bilibili.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** B 站用来派生 correspondPath 的 RSA 公钥（JWK）。它是公开参数，不是密钥。 */
const JWK = {
  kty: 'RSA',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
  e: 'AQAB',
} as const;

interface Envelope<T> { code: number; message?: string; data?: T }
interface QrGenerate { url?: string; qrcode_key?: string }
interface QrPoll { code?: number; message?: string; url?: string; refresh_token?: string; timestamp?: number }
interface CookieInfo { refresh?: boolean; timestamp?: number }

function baseHeaders(cookie?: string): Record<string, string> {
  return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com',
    ...(cookie ? { Cookie: cookie } : {}) };
}

/** 刷新后合并新旧会话：新 cookie 优先，缺的字段沿用旧的，避免半套凭证。 */
export function mergedSession(old: Session, jar: Record<string, string>, refreshToken: string | undefined): Session {
  const token = refreshToken ?? old.refreshToken;
  return {
    sessdata: jar.SESSDATA ?? old.sessdata,
    biliJct: jar.bili_jct ?? old.biliJct,
    obtainedAt: old.obtainedAt,
    verifiedAt: Date.now(),
    source: old.source,
    ...(token ? { refreshToken: token } : {}),
  };
}

/** 把 B 站的状态码翻成四种对外状态；未知码按「还没好」处理，不报成功。 */
function qrStatus(code: number | undefined): 'waiting' | 'scanned' | 'expired' | 'ok' {
  if (code === QR_CODE.success) return 'ok';
  if (code === QR_CODE.scanned) return 'scanned';
  if (code === QR_CODE.expired) return 'expired';
  return 'waiting';
}

/** 从 Set-Cookie 里挑出登录需要的几个字段。 */
export function cookiesFrom(setCookie: string[] | null | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of setCookie ?? []) {
    const pair = line.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return jar;
}

/**
 * 判断是否该刷新 Cookie。B 站只在「该刷新了」的时候才给 true，
 * 所以这个接口可以每天问一次，不消耗 refresh 次数。
 */
export async function shouldRefresh(session: Session, signal: AbortSignal): Promise<boolean> {
  const cookie = `SESSDATA=${session.sessdata}; bili_jct=${session.biliJct}`;
  const response = await fetch(`${PASSPORT}/x/passport-login/web/cookie/info?csrf=${encodeURIComponent(session.biliJct)}`,
    { headers: baseHeaders(cookie), signal });
  const body = await response.json() as Envelope<CookieInfo>;
  if (body.code !== 0) return false; // 未登录/风控：交给上层重新登录，而不是硬刷新
  return body.data?.refresh === true;
}

/**
 * correspondPath = RSA-OAEP(SHA-256) 加密 `refresh_<毫秒时间戳>`，再用小写 base16 编码。
 * 算法来自 B 站前端 wasm 的逆向结论；浏览器与 Node 的 WebCrypto 都直接能做。
 */
export async function correspondPath(timestampMs: number): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', { ...JWK, ext: true }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(`refresh_${timestampMs}`));
  return [...new Uint8Array(encrypted)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 从 correspond 页面里取出实时刷新口令。页面是 SSR 的，口令在 div#1-name 里。 */
export function parseRefreshCsrf(html: string): string | undefined {
  return /<div[^>]*id="1-name"[^>]*>\s*([0-9a-f]{32})\s*<\/div>/i.exec(html)?.[1];
}

/**
 * B 站扫码登录 + Cookie 托管。
 *
 * 为什么不支持账号密码登录：密码登录要过风控和验证码，在服务器上存密码本身也是风险。
 * 扫码登录拿到的是同样的 SESSDATA/bili_jct，外加一个 refresh_token，用完即把密码需求去掉。
 */
export class BilibiliLogin implements SessionRefresher {
  /** correspondPath → 页面里的 refresh_csrf；拿不到就是登录态已经不能用。 */
  private async refreshCsrf(cookie: string, signal: AbortSignal): Promise<string> {
    const path = await correspondPath(Date.now());
    const html = await (await fetch(`${WWW}/correspond/1/${path}`, { headers: baseHeaders(cookie), signal })).text();
    const refreshCsrf = parseRefreshCsrf(html);
    if (!refreshCsrf) throw new Error('没能从 correspond 页面取到 refresh_csrf（可能登录态已失效）');
    return refreshCsrf;
  }

  /** 端口实现：先问 B 站该不该刷新，再决定要不要真的换 Cookie。 */
  async refreshIfNeeded(session: Session, signal: AbortSignal): Promise<Session | undefined> {
    return (await shouldRefresh(session, signal).catch(() => false)) ? this.refresh(session, signal) : undefined;
  }

  /** 生成二维码内容与轮询密钥；二维码 180 秒有效。 */
  async generateQr(signal: AbortSignal): Promise<{ url: string; qrcodeKey: string }> {
    const response = await fetch(`${PASSPORT}/x/passport-login/web/qrcode/generate`, { headers: baseHeaders(), signal });
    const body = await response.json() as Envelope<QrGenerate>;
    if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) throw new Error(`二维码生成失败（code ${body.code}）`);
    return { url: body.data.url, qrcodeKey: body.data.qrcode_key };
  }

  /**
   * 轮询扫码状态。登录成功时从 Set-Cookie 取会话，并保存 refresh_token。
   * 返回状态而不是抛错：未扫码是正常过程，不是失败。
   */
  async pollQr(qrcodeKey: string, signal: AbortSignal): Promise<{ status: 'waiting' | 'scanned' | 'expired' | 'ok'; session?: Session }> {
    const response = await fetch(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      { headers: baseHeaders(), signal });
    const body = await response.json() as Envelope<QrPoll>;
    if (body.code !== 0) throw new Error(`扫码轮询失败（code ${body.code}）`);
    const status = qrStatus(body.data?.code);
    if (status !== 'ok') return { status };
    const jar = cookiesFrom(response.headers.getSetCookie?.() ?? []);
    if (!jar.SESSDATA || !jar.bili_jct) throw new Error('登录成功但没拿到 SESSDATA/bili_jct');
    return { status: 'ok', session: {
      sessdata: jar.SESSDATA, biliJct: jar.bili_jct, obtainedAt: Date.now(), verifiedAt: Date.now(), source: 'qr',
      ...(body.data?.refresh_token ? { refreshToken: body.data.refresh_token } : {}),
    } };
  }

  /**
   * 刷新 Cookie：correspondPath → 取 refresh_csrf → 刷新 → 确认旧口令失效。
   * 先确认再覆盖：失败时保留旧会话，不会因为刷新中途出错把还能用的登录弄丢。
   */
  async refresh(session: Session, signal: AbortSignal): Promise<Session> {
    if (!session.refreshToken) throw new Error('这份登录没有 refresh_token，无法刷新，需要重新扫码登录');
    const cookie = `SESSDATA=${session.sessdata}; bili_jct=${session.biliJct}`;
    const refreshCsrf = await this.refreshCsrf(cookie, signal);
    const form = new URLSearchParams({ csrf: session.biliJct, refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: session.refreshToken });
    const refreshed = await fetch(`${PASSPORT}/x/passport-login/web/cookie/refresh`, {
      method: 'POST', headers: { ...baseHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal,
    });
    const body = await refreshed.json() as Envelope<{ refresh_token?: string }>;
    if (body.code !== 0) throw new Error(`刷新 Cookie 失败（code ${body.code}）`);
    const next = mergedSession(session, cookiesFrom(refreshed.headers.getSetCookie?.() ?? []), body.data?.refresh_token);
    // 确认更新：让旧的 refresh_token 失效。失败不致命，下次可能要用新 token 再试一次。
    await this.confirm(session.refreshToken, next, signal);
    return next;
  }

  /** 让旧的 refresh_token 失效；失败只吞掉，不影响本次刷新结果。 */
  private async confirm(oldToken: string, next: Session, signal: AbortSignal): Promise<void> {
    const form = new URLSearchParams({ csrf: next.biliJct, refresh_token: oldToken });
    await fetch(`${PASSPORT}/x/passport-login/web/confirm/refresh`, {
      method: 'POST', headers: { ...baseHeaders(`SESSDATA=${next.sessdata}; bili_jct=${next.biliJct}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(), signal,
    }).catch(() => undefined);
  }
}
