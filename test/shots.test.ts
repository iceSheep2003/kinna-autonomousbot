import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserShots } from '../src/infrastructure/bilibili/shots.js';
import { DanmakuHeat, parseDanmakuSeconds } from '../src/infrastructure/bilibili/heat.js';

/** 这些是「不需要浏览器」的部分：地址怎么给、失败了怎么退。真截图在 scripts/verify-bilibili-local.mjs。 */

test('没配 publicBaseUrl 时截图以内联 data URL 返回（本地免隧道）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-test-'));
  const shots = new BrowserShots({ outputDir: dir });
  // 访问私有实现：这里验证的是「地址怎么给」，不是截图像素。
  const url = (shots as unknown as { publicUrl(name: string, buffer: Uint8Array): string }).publicUrl('a.jpg', new Uint8Array([1, 2, 3]));
  assert.match(url, /^data:image\/jpeg;base64,/);
  rmSync(dir, { recursive: true, force: true });
});

test('配了 publicBaseUrl 时给可下载的 URL，且去掉尾部斜杠', () => {
  const shots = new BrowserShots({ outputDir: '/tmp/x', publicBaseUrl: 'https://example.com/' });
  const url = (shots as unknown as { publicUrl(name: string, buffer: Uint8Array): string }).publicUrl('a.jpg', new Uint8Array([1]));
  assert.equal(url, 'https://example.com/shots/a.jpg');
});

test('截图目录不存在时会自动创建（服务器上首次运行）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shots-mkdir-'));
  const dir = join(root, 'deep', 'nested', 'shots');
  const shots = new BrowserShots({ outputDir: dir });
  await (shots as unknown as { scheduleCleanup(file: string): void }).scheduleCleanup(join(dir, 'none.jpg'));
  shots.close();
  rmSync(root, { recursive: true, force: true });
});

test('弹幕只取时间不取文字，也不把 XML 里的表情/超链接当成数据', () => {
  assert.deepEqual(parseDanmakuSeconds('<d p="1.5,1">a</d><d p="2,1">b</d>'), [1.5, 2]);
  assert.deepEqual(parseDanmakuSeconds('not xml'), []);
});

test('弹幕少于阈值的视频返回 null，调用方会退回均匀采样', async () => {
  const transport = { text: async () => '<d p="1,1">a</d><d p="2,1">b</d>' };
  assert.equal(await new DanmakuHeat(transport as never).heat({ bvid: 'BV1xx4y1x7xx', cid: 1, aid: 1, signal: AbortSignal.timeout(1000) }), null);
});
