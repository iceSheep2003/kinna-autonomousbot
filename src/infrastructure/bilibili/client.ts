import type { Credentials } from '../../integrations/bilibili/types.js';
import type { BilibiliRequest, BilibiliTransport } from '../../integrations/bilibili/ports.js';

const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const REFERER = 'https://www.bilibili.com/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class BilibiliError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

/** 参数统一转字符串塞进 URL / 表单，空值不写。 */
function setParams(target: URLSearchParams, values: Record<string, string | number> | undefined): void {
  for (const [key, value] of Object.entries(values ?? {})) if (value !== undefined) target.set(key, String(value));
}

/** B 站统一返回 code=0 才算成功；其他码翻译成人话再抛，不把原始 JSON 塞给上层。 */
function decode<T>(body: { code?: number; message?: string; data?: unknown }): T {
  if (typeof body.code !== 'number') throw new BilibiliError('B 站返回了无法识别的响应', -1);
  if (body.code !== 0) throw new BilibiliError(`B 站拒绝：${body.message || 'unknown'}（code ${body.code}）`, body.code);
  return (body.data ?? {}) as T;
}

/** 只带 SESSDATA / bili_jct 两个 cookie；其余一律不读，也不写日志。 */
function cookieHeader(credentials: Credentials | undefined): string | undefined {
  if (!credentials) return undefined;
  return `SESSDATA=${credentials.sessdata}; bili_jct=${credentials.biliJct}`;
}

function headers(credentials: Credentials | undefined, isWrite: boolean): Record<string, string> {
  const result: Record<string, string> = { 'User-Agent': UA, Referer: REFERER, Origin: 'https://www.bilibili.com' };
  const cookie = cookieHeader(credentials);
  if (cookie) result.Cookie = cookie;
  if (isWrite) result['Content-Type'] = 'application/x-www-form-urlencoded';
  return result;
}

/**
 * B 站 HTTP 传输。凭证只在这里出现：
 * - 读接口匿名也能用，但登录态下能拿到更多（比如 1080P 流）；
 * - 写接口必须带 csrf，值就是 bili_jct，由本层自动附上，调用方永远看不到 cookie。
 */
export class BilibiliHttp implements BilibiliTransport {
  /** 会话可变：扫码登录或刷新后直接换掉，不需要重建传输层。 */
  private credentials: Credentials | undefined;
  constructor(credentials: Credentials | undefined, private readonly onInvalid?: (reason: string) => void) {
    this.credentials = credentials;
  }

  /** 登录/刷新后调用；cookie 只在传输层出现。 */
  setCredentials(credentials: Credentials | undefined): void { this.credentials = credentials; }

  async request<T>(request: BilibiliRequest): Promise<T> {
    const prepared = this.prepare(request);
    const response = await fetch(prepared.url, {
      method: request.method, signal: request.signal,
      headers: { ...headers(this.credentials, Boolean(request.csrf)), ...(prepared.json ? { 'Content-Type': 'application/json' } : {}) },
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
    });
    if (!response.ok) throw new BilibiliError(`B 站 HTTP ${response.status}`, response.status);
    const body = await response.json() as { code?: number; message?: string; data?: unknown };
    // -101 是「账号未登录」：cookie 已失效，交给会话托管者提示重新登录，不在这里重试。
    if (body.code === -101) this.onInvalid?.('SESSDATA 失效（账号未登录）');
    return decode<T>(body);
  }

  /** 弹幕等非 JSON 接口：同样带浏览器头与登录态，但返回原文。 */
  async text(request: BilibiliRequest): Promise<string> {
    const prepared = this.prepare(request);
    const response = await fetch(prepared.url, { method: request.method, signal: request.signal, headers: headers(this.credentials, false) });
    if (!response.ok) throw new BilibiliError(`B 站 HTTP ${response.status}`, response.status);
    return response.text();
  }

  /** URL、表单与 csrf 在这里一次性备好；调用方看不到 cookie。 */
  private prepare(request: BilibiliRequest): { url: URL; body?: string; json: boolean } {
    const url = new URL(request.path, request.base === 'vc' ? VC : API);
    setParams(url.searchParams, request.query);
    const form = new URLSearchParams();
    setParams(form, request.form);
    // 写操作要 CSRF：B 站约定是 cookie 里的 bili_jct，query 与 form 都要带。
    if (request.csrf) {
      const token = this.credentials?.biliJct;
      if (!token) throw new BilibiliError('B 站写操作需要登录态（SESSDATA / bili_jct 未配置）', -101);
      url.searchParams.set('csrf', token);
      if (form.size > 0) form.set('csrf', token);
    }
    const body = request.json ? JSON.stringify(request.json) : form.size > 0 ? form.toString() : undefined;
    return { url, json: Boolean(request.json), ...(body === undefined ? {} : { body }) };
  }
}
