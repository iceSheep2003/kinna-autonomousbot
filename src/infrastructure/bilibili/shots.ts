import type { VideoShots } from '../../integrations/bilibili/ports.js';

export interface ShotOptions {
  /** 截图存到哪个目录（http.server 可读）；文件会在 keepMs 后删除。 */
  outputDir: string;
  /** 对外可访问的地址前缀；不配置时用 data URL 内联返回，本地免架隧道。 */
  publicBaseUrl?: string;
  viewport?: { width: number; height: number };
  /** 打开页面与跳到指定时间各给多久。 */
  loadTimeoutMs?: number;
  seekTimeoutMs?: number;
  /** 截图保留多久；DeepSeek 拉完图就不再需要。 */
  keepMs?: number;
}

/** 本地渲染用的最小播放页：一个静音 video，按 query 加载流。 */
const PLAYER_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}video{display:block;width:100vw;height:100vh;object-fit:contain}</style>
<video id="v" muted playsinline preload="auto"></video>`;

/**
 * 用无头浏览器截图。
 *
 * 不在 B 站播放页里截图：播放页有广告、弹幕层、登录框和风控，选择器一变就全挂，
 * 实测无头打开播放页还会卡住。改成自己渲染：拿 playurl 给的真实 DASH 地址，
 * 在本地最小页面里 seek 到指定秒，截图。
 *
 * 二进制不需要跟着 playwright 版本走：优先用 `BILIBILI_CHROME_PATH`，
 * 否则让 playwright 用自己的 Chromium（服务器上 `npx playwright install chromium`）。
 */
export class BrowserShots implements VideoShots {
  private browser: TypedBrowser | null = null;
  constructor(private readonly options: ShotOptions) {}

  private async get(): Promise<TypedBrowser> {
    if (this.browser) return this.browser;
    // 变量导入：playwright 是可选依赖，没装时不该让整个项目编译失败。
    const specifier = 'playwright';
    const module = await import(specifier).catch(() => null) as { chromium?: { launch(options: Record<string, unknown>): Promise<TypedBrowser> } } | null;
    if (!module?.chromium) throw new Error('读视频需要无头浏览器：npm i -D playwright && npx playwright install chromium');
    const executablePath = process.env.BILIBILI_CHROME_PATH?.trim();
    this.browser = await module.chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
      ...(executablePath ? { executablePath } : {}),
    });
    return this.browser;
  }

  async capture(input: {
    bvid: string; streamUrl: string; at: number[]; pageUrl: string; signal: AbortSignal;
  }): Promise<{ shots: Array<{ url: string; at: number }> }> {
    const browser = await this.get();
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const page = await browser.newPage({ viewport: this.options.viewport ?? { width: 1280, height: 720 } });
    const shots: Array<{ url: string; at: number }> = [];
    try {
      // 用 bilibili.com 域下的本地页面：防盗链看 Referer，file:// 会被拒。
      // 这个页面完全由本地提供（route.fulfill），不会真的访问 bilibili.com；
      // 但 URL 仍挂在该域下，这样视频请求带上的 Referer 才过得了防盗链。
      const localPage = 'https://www.bilibili.com/local-player.html';
      await page.route(localPage, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PLAYER_HTML }));
      // 只给视频/图片等资源挂 Referer；页面本身已由上面的 route 直接 fulfill。
      await page.route(/bilivideo\.(com|cn)|hdslb\.com/, route =>
        route.continue({ headers: { ...route.request().headers(), referer: 'https://www.bilibili.com/' } }).catch(() => {}));
      await page.goto(localPage, { waitUntil: 'domcontentloaded', timeout: this.options.loadTimeoutMs ?? 30000 });
      // 视频流地址通过 page.evaluate 注入，避免把签名参数写进页面 URL 日志。
      await page.evaluate(`(() => { const v = document.getElementById('v'); v.src = ${JSON.stringify(input.streamUrl)}; return true; })()`);
      await page.evaluate(`new Promise((resolve, reject) => {
        const v = document.getElementById('v');
        const done = () => resolve(v.duration);
        if (v.readyState >= 1) return done();
        v.addEventListener('loadedmetadata', done, { once: true });
        v.addEventListener('error', () => reject(new Error('video error ' + (v.error && v.error.code))), { once: true });
        setTimeout(() => reject(new Error('video metadata timeout')), ${this.options.loadTimeoutMs ?? 30000});
      })`);
      await mkdir(this.options.outputDir, { recursive: true });
      for (const at of input.at) {
        input.signal.throwIfAborted();
        await page.evaluate(`new Promise((resolve) => {
          const v = document.getElementById('v');
          v.pause();
          const finish = () => setTimeout(resolve, 250);
          v.addEventListener('seeked', finish, { once: true });
          v.currentTime = ${Math.max(0, Math.floor(at))};
          setTimeout(finish, ${this.options.seekTimeoutMs ?? 8000});
        })`);
        const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
        const name = `${input.bvid}-${Math.floor(at)}-${Date.now()}-${shots.length}.jpg`;
        const file = join(this.options.outputDir, name);
        await writeFile(file, buffer);
        shots.push({ url: this.publicUrl(name, buffer), at });
        this.scheduleCleanup(file);
      }
      void input.pageUrl;
      return { shots };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 配了公网前缀就给 URL（DeepSeek 自己下载）；没配就内联 data URL，本地免隧道。 */
  private publicUrl(name: string, buffer: Uint8Array): string {
    const base = this.options.publicBaseUrl?.replace(/\/$/, '');
    if (base) return `${base}/shots/${name}`;
    return `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
  }

  private scheduleCleanup(file: string): void {
    void import('node:fs/promises').then(({ rm }) => {
      setTimeout(() => { void rm(file, { force: true }).catch(() => {}); }, this.options.keepMs ?? 10 * 60_000).unref?.();
    });
  }

  async close(): Promise<void> { const browser = this.browser; this.browser = null; await browser?.close().catch(() => {}); }
}

interface TypedPage {
  route(pattern: string | RegExp, handler: (route: TypedRoute) => unknown): Promise<unknown>;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: Record<string, unknown>): Promise<Uint8Array>;
  close(): Promise<void>;
}
interface TypedRoute { request(): { url(): string; headers(): Record<string, string> }; fulfill(options: Record<string, unknown>): Promise<unknown>; continue(options?: Record<string, unknown>): Promise<unknown> }
interface TypedBrowser {
  newPage(options?: Record<string, unknown>): Promise<TypedPage>;
  close(): Promise<void>;
}
