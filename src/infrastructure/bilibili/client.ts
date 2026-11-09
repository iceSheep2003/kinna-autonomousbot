import type { Credentials } from '../../integrations/bilibili/types.js';
import type { BilibiliRequest, BilibiliTransport, MediaClip } from '../../integrations/bilibili/ports.js';

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
  constructor(private readonly credentials: Credentials | undefined, private readonly ffmpegBin = 'ffmpeg') {}

  async request<T>(request: BilibiliRequest): Promise<T> {
    const prepared = this.prepare(request);
    const response = await fetch(prepared.url, {
      method: request.method, signal: request.signal,
      headers: { ...headers(this.credentials, Boolean(request.csrf)), ...(prepared.json ? { 'Content-Type': 'application/json' } : {}) },
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
    });
    if (!response.ok) throw new BilibiliError(`B 站 HTTP ${response.status}`, response.status);
    return decode<T>(await response.json() as { code?: number; message?: string; data?: unknown });
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

  /** 用 ffmpeg 截取一小段并抽一帧；视频流 URL 两分钟有效，所以必须立即拉。 */
  async clip(request: { url: string; startSeconds: number; endSeconds: number; signal: AbortSignal; dir?: string; name?: string }): Promise<MediaClip> {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = request.dir ?? mkdtempSync(join(tmpdir(), 'bili-frame-'));
    const file = join(dir, request.name ?? 'frame.jpg');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, request.startSeconds)),
        '-i', request.url, '-t', String(Math.max(0.1, request.endSeconds - request.startSeconds)),
        '-frames:v', '1', '-vf', 'scale=720:-2', file,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      request.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      child.once('error', error => reject(new BilibiliError(`无法启动 ffmpeg：${error.message}`, -1)));
      child.once('close', code => code === 0 ? resolve() : reject(new BilibiliError(`抽帧失败（ffmpeg ${code}）：${stderr.slice(0, 300)}`, -1)));
    });
    // 指定了共享目录时只删本帧，目录由调用方统一清理。
    return { path: file, cleanup: () => { try { rmSync(request.dir ? file : dir, { recursive: !request.dir, force: true }); } catch { /* 临时文件已不在 */ } } };
  }
}

/** 从部署环境读登录态；缺一个就当未登录，而不是只配一半。 */
export function credentialsFromEnv(env: Record<string, string | undefined>): Credentials | undefined {
  const sessdata = env.BILIBILI_SESSDATA?.trim();
  const biliJct = env.BILIBILI_BILI_JCT?.trim();
  if (!sessdata || !biliJct) return undefined;
  return { sessdata, biliJct };
}
