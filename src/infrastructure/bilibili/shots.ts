import type { VideoShots } from '../../integrations/bilibili/ports.js';

export interface ShotOptions {
  /** 截图存到哪：http.server 能读的静态目录，返回的 URL 要能被 DeepSeek 下载。 */
  publicBaseUrl: string;
  outputDir: string;
  viewport?: { width: number; height: number };
  /** 页面加载与播放缓冲各给多久，超时就算这张截失败。 */
  loadTimeoutMs?: number;
  /** 截图后多久删文件；DeepSeek 拉完图就不需要了。 */
  keepMs?: number;
}

/**
 * 用无头浏览器在播放页的指定秒数截图。
 *
 * 为什么是浏览器而不是 ffmpeg：播放器本来就会把画面画在 canvas 上，截图是浏览器自带的能力；
 * 本地抽帧要装编解码器、要下载整段视频流，还要把图编码进请求。截图只保留「看到的那一刻」。
 *
 * 页面里有广告、评论区等无关区域，所以按选择器截播放器本体；找不到播放器就整体截取，
 * 但裁掉评论区——读视频要读的是画面，不是弹幕墙。
 */
export const SHOT_SCRIPT = String.raw`
(async (src) => {
  const { ts, selector } = src;
  const video = document.querySelector('video');
  if (!video) throw new Error('页面里没有 video 元素');
  const seek = () => new Promise((resolve) => {
    if (Math.abs(video.currentTime - ts) < 0.5) return resolve(true);
    const done = () => resolve(true);
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = ts;
    setTimeout(done, 5000);
  });
  video.muted = true;
  try { await video.play(); } catch { /* 自动播放被拦就只 seek */ }
  await seek();
  await new Promise((r) => setTimeout(r, 350));
  return true;
})`;

export class BrowserShots implements VideoShots {
  private browser: TypedBrowser | null = null;
  constructor(private readonly options: ShotOptions) {}

  /** 懒加载 playwright：没装也能用其他能力，只是读视频报一条清楚的错。 */
  private async get(): Promise<TypedBrowser> {
    if (this.browser) return this.browser;
    // 用变量导入：playwright 是可选依赖，没装时不应该让整个项目编译不过。
    const specifier = 'playwright';
    const module = await import(specifier).catch(() => null) as { chromium?: { launch(options: Record<string, unknown>): Promise<TypedBrowser> } } | null;
    if (!module?.chromium) throw new Error('读视频需要无头浏览器：npm i -D playwright && npx playwright install chromium');
    this.browser = await module.chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    return this.browser;
  }

  async capture(input: { bvid: string; timestamp: number; count: number; at?: number[]; signal: AbortSignal }): Promise<{ shots: Array<{ url: string; at: number }>; durationSeconds: number }> {
    const browser = await this.get();
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(this.options.outputDir, { recursive: true });
    const page = await browser.newPage({ viewport: this.options.viewport ?? { width: 1280, height: 720 } });
    const shots: Array<{ url: string; at: number }> = [];
    let durationSeconds = 0;
    try {
      // 第 1 帧先打开页面并把播放器停下来，拿到真实时长；后续只 seek。
      await page.goto(`https://www.bilibili.com/video/${input.bvid}`, { waitUntil: 'domcontentloaded', timeout: this.options.loadTimeoutMs ?? 45000 });
      const probe = await page.evaluate(`(() => { const v = document.querySelector('video'); return v ? { duration: v.duration || 0 } : null; })()`) as { duration: number } | null;
      durationSeconds = Number(probe?.duration ?? input.timestamp);
      const points = input.at?.length ? input.at.slice(0, input.count) : Array.from({ length: input.count }, (_, index) => durationSeconds * (index / Math.max(1, input.count - 1)));
      for (const at of points) {
        input.signal.throwIfAborted();
        await page.evaluate(`${SHOT_SCRIPT}(${JSON.stringify({ ts: Math.max(0, Math.floor(at)), selector: 'video' })})`).catch(() => null);
        const file = join(this.options.outputDir, `${input.bvid}-${Math.floor(at)}-${Date.now()}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 70, clip: await this.viewportOf(page) });
        shots.push({ url: `${this.options.publicBaseUrl.replace(/\/$/, '')}/shots/${file.split('/').pop()}`, at });
        // 图上只有一帧画面，截完就删；保留时间只给 DeepSeek 下载。
        setTimeout(() => { void rm(file, { force: true }); }, this.options.keepMs ?? 10 * 60_000).unref?.();
      }
      return { shots, durationSeconds };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 只截播放器所在区域；没有播放器就退回整个视口。 */
  private async viewportOf(page: TypedPage): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    const box = await page.evaluate(`(() => { const el = document.querySelector('#bilibili-player, .bpx-player-video-wrap'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) as { x: number; y: number; width: number; height: number } | null;
    return box && box.width > 100 && box.height > 100 ? box : undefined;
  }

  async close(): Promise<void> { const browser = this.browser; this.browser = null; await browser?.close().catch(() => {}); }
}

interface TypedPage {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
interface TypedBrowser {
  newPage(options?: Record<string, unknown>): Promise<TypedPage>;
  close(): Promise<void>;
}
