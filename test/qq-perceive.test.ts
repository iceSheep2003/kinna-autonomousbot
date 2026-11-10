import test from 'node:test';
import assert from 'node:assert/strict';
import { PERCEIVE_LIMITS, describeImage, describeImagesIn } from '../src/integrations/qq/perceive.js';
import type { MediaRef } from '../src/integrations/qq/types.js';

const ref = (id: string): MediaRef => ({ id, kind: 'image', scope: { type: 'group', id: '123' }, eventId: 'e', url: `https://x/${id}.jpg` });
const bytes = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' };

function deps(overrides: { summary?: string; fail?: boolean; cache?: Map<string, string>; seen?: string[]; caps?: { image: boolean; audio: boolean } } = {}) {
  return {
    media: { async acquire(r: MediaRef) { if (overrides.fail) throw new Error('下载失败'); overrides.seen?.push(r.id); return bytes; } },
    perception: {
      async inspect() { if (overrides.fail) throw new Error('模型不可用'); return overrides.summary ?? '一只猫趴在键盘上'; },
      capabilities: () => overrides.caps ?? { image: true, audio: true },
    },
    ...(overrides.cache === undefined ? {} : { cache: { get: (id: string) => overrides.cache!.get(id), put: (id: string, s: string) => { overrides.cache!.set(id, s); } } }),
  };
}

test('图片描述自动拼进文本——模型不用自己想起去调工具', async () => {
  const out = await describeImagesIn('牢e发来 [图片]', [ref('a')], deps({ summary: '一只猫趴在键盘上' }));
  assert.match(out, /\[图片：一只猫趴在键盘上（识别可能有误）\]/);
});

test('识别结果标明「可能有误」：它是资料，不是事实', async () => {
  const out = await describeImagesIn('[图片]', [ref('a')], deps());
  assert.match(out, /识别可能有误/);
});

test('读不出来的图明确说「未能识别」，而不是留一个空占位让模型以为图是空白', async () => {
  assert.match(await describeImage(ref('a'), deps({ fail: true })), /未能识别/);
  assert.match(await describeImagesIn('[图片]', [ref('a')], deps({ fail: true })), /未能识别/);
});

test('同一张图只分析一次（缓存命中不再下载）', async () => {
  const cache = new Map<string, string>();
  const seen: string[] = [];
  const d = deps({ cache, seen });
  await describeImage(ref('a'), d);
  await describeImage(ref('a'), d);
  assert.deepEqual(seen, ['a'], '第二次应该走缓存');
  assert.equal(cache.get('a'), '一只猫趴在键盘上');
});

test('一条消息最多读 2 张，多出来的明确说明「还有几张未读」', async () => {
  assert.equal(PERCEIVE_LIMITS.maxImages, 2);
  const out = await describeImagesIn('[图片][图片][图片]', [ref('a'), ref('b'), ref('c')], deps());
  assert.match(out, /还有 1 张图未读/);
});

test('没有图片的消息原样返回，不做任何改动', async () => {
  assert.equal(await describeImagesIn('纯文字消息', [], deps()), '纯文字消息');
});

test('语音要转写成文字——只留 [语音] 等于没听见', async () => {
  const audio: MediaRef = { ...ref('v'), kind: 'audio' };
  const out = await describeImagesIn('[语音]', [audio], deps({ summary: '我明天下午到' }));
  assert.match(out, /\[语音：我明天下午到（转写可能有误）\]/);
});

test('视频不当作图片去识别，保留占位', async () => {
  const video: MediaRef = { ...ref('v'), kind: 'video' };
  assert.equal(await describeImagesIn('[视频]', [video], deps()), '[视频]');
});

test('语音转写失败时说「未能转写」，不假装听见了', async () => {
  const audio: MediaRef = { ...ref('v'), kind: 'audio' };
  assert.match(await describeImagesIn('[语音]', [audio], deps({ fail: true })), /未能转写/);
});

test('识别结果为空时不返回空串', async () => {
  assert.match(await describeImage(ref('a'), deps({ summary: '   ' })), /识别结果为空/);
});

test('描述压成一行并限长：超长会把整轮预算吃光', async () => {
  const long = '书名一 27年1月\n书名二 27年5月\n'.repeat(60);
  const out = await describeImage(ref('a'), deps({ summary: long }));
  assert.equal(out.length, PERCEIVE_LIMITS.maxChars + 1, '限长 + 省略号');
  assert.doesNotMatch(out, /\n/, '压成一行，换行只是浪费预算');
  assert.ok(out.endsWith('…'));
});

test('默认提问会要求读出图里的关键信息，而不是只说「这是一张截图」', async () => {
  const out = await describeImagesIn('[图片]', [ref('a')], {
    ...deps({ summary: '现货：基础30讲；题源1000题 27年1月发货' }),
  });
  assert.match(out, /基础30讲/);
  assert.match(out, /27年1月/, '群聊发图多半是分享信息，书名和日期才是重点');
});

test('没配置图片识别能力时说「没有这个能力」，而不是「识别失败」', async () => {
  const out = await describeImage(ref('a'), deps({ caps: { image: false, audio: false } }));
  assert.match(out, /没有配置图片识别能力/);
  assert.doesNotMatch(out, /未能识别/, '没能力 ≠ 这次失败，再试也没用');
});

test('没配置语音转写能力时明确说听不到——DeepSeek 的 file 只收图片、没有转写端点', async () => {
  const out = await describeImagesIn('[语音]', [{ ...ref('v'), kind: 'audio' }], deps({ caps: { image: true, audio: false } }));
  assert.match(out, /没有配置语音转写能力，听不到内容/);
});
