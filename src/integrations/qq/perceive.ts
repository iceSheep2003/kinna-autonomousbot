import type { MediaRef } from './types.js';
import type { QqMediaSource, QqPerception } from './ports.js';

/**
 * 收到图片时把「图里是什么」读出来，拼进消息文本。
 *
 * 为什么必须自动做，而不是等模型调 `inspect_media`：
 * 模型看到的消息只有 `[图片]` 两个字。它要么猜（答非所问），要么得先意识到
 * 「应该去读一下这张图」再发一次工具调用——实际对话里它多半直接猜。
 * 线上的做法也是自动注入：`[图片｜编号 x] 初次概括…`。
 *
 * 三条边界：
 * 1. **限张数**：一条消息最多读 2 张，多了会拖慢整轮。
 * 2. **有超时**：读图超过 8 秒就放弃，标成「未能识别」而不是让消息卡住。
 * 3. **标明是识别结果**：`（模型识别，可能有误）`——它是资料，不是事实。
 */
export const PERCEIVE_LIMITS = {
  maxImages: 2,
  timeoutMs: 8000,
  /**
   * 描述最多这么多字。
   * 实测让它「把关键信息读出来」时会写一大段（书单截图能列出十几行）；
   * 描述是资料不是正文，太长会把整轮预算吃光，反而挤掉对话本身。
   */
  maxChars: 400,
} as const;

/**
 * 默认提问。
 *
 * 一开始只写「简要描述画面」，实测对群聊里最常见的**文字截图**没用：
 * 它回「这是一张书单截图」，而图里真正有用的是那些书名和日期。
 * 群聊发图多半是在分享信息（截图、表格、聊天记录、题目），
 * 所以要求它把关键信息读出来，而不是只说「这是一张图」。
 */
export const DEFAULT_IMAGE_QUESTION =
  '这是一张群聊里发的图。用一两句话说清它是什么；'
  + '如果图里有文字（截图、表格、聊天记录、题目、公告等），把关键信息也读出来'
  + '（书名/数字/日期/结论这类），不要只说「这是一张截图」。';

export interface PerceiveDeps {
  media: QqMediaSource;
  perception: QqPerception;
  /** 读过的图存起来：同一张图不重复分析。 */
  cache?: { get(id: string): string | undefined; put(id: string, summary: string): void };
  signal?: AbortSignal;
}

/** 压成一行并限长：换行在上下文里只是浪费预算，超长描述会挤掉对话。 */
function clip(summary: string): string {
  const oneLine = summary.replace(/\s+/g, ' ').trim();
  return oneLine.length <= PERCEIVE_LIMITS.maxChars ? oneLine : `${oneLine.slice(0, PERCEIVE_LIMITS.maxChars)}…`;
}

/** 一张图的描述；失败返回带说明的占位，不返回空串（空串会让模型以为没有图）。 */
export async function describeImage(ref: MediaRef, deps: PerceiveDeps, question = DEFAULT_IMAGE_QUESTION): Promise<string> {
  const cached = deps.cache?.get(ref.id);
  if (cached !== undefined) return cached;
  if (deps.perception.capabilities?.().image === false) return '[图片：当前没有配置图片识别能力，看不到内容]';
  try {
    const signal = deps.signal === undefined
      ? AbortSignal.timeout(PERCEIVE_LIMITS.timeoutMs)
      : AbortSignal.any([deps.signal, AbortSignal.timeout(PERCEIVE_LIMITS.timeoutMs)]);
    const bytes = await deps.media.acquire(ref, signal);
    const raw = (await deps.perception.inspect(bytes, question, signal)).trim();
    if (raw === '') return '[图片：识别结果为空]';
    const summary = clip(raw);
    deps.cache?.put(ref.id, summary);
    return summary;
  } catch {
    // 超时/下载失败/模型不可用都可能。给一句明确的说明，别让模型以为图是空白。
    return '[图片：未能识别]';
  }
}

/**
 * 语音转写成文字。
 *
 * 语音和图片一样是「非文字消息」：只留一个 `[语音]` 等于没听见。
 * 转写失败也明确说「听不出来」，不假装听见了。
 */
export async function transcribeVoice(ref: MediaRef, deps: PerceiveDeps): Promise<string> {
  const cached = deps.cache?.get(ref.id);
  if (cached !== undefined) return cached;
  // 先说清「做不到」还是「这次失败」：前者再试也没用，后者可以重试。
  // 实测 DeepSeek 的文件类型只收图片（webp/png/jpeg/gif）、没有转写端点，
  // 所以默认部署里语音就是听不到的——不能假装听见了。
  if (deps.perception.capabilities?.().audio === false) return '[语音：当前没有配置语音转写能力，听不到内容]';
  try {
    const signal = deps.signal === undefined
      ? AbortSignal.timeout(PERCEIVE_LIMITS.timeoutMs)
      : AbortSignal.any([deps.signal, AbortSignal.timeout(PERCEIVE_LIMITS.timeoutMs)]);
    const bytes = await deps.media.acquire(ref, signal);
    const transcript = (await deps.perception.inspect(bytes, '把这段语音原样转写成文字；听不清的词用 [?] 标出', signal)).trim();
    if (transcript === '') return '[语音：转写结果为空]';
    deps.cache?.put(ref.id, transcript);
    return transcript;
  } catch {
    return '[语音：未能转写]';
  }
}

/**
 * 把一条消息里的非文字占位换成真实内容：图片 → 描述，语音 → 转写。
 *
 * 只处理前 `maxImages` 个图片；多出来的明确说明还有几张——
 * 让模型知道「还有没看的」，而不是以为只有一张。
 */
export async function describeImagesIn(text: string, refs: readonly MediaRef[], deps: PerceiveDeps): Promise<string> {
  const images = refs.filter(ref => ref.kind === 'image');
  const audios = refs.filter(ref => ref.kind === 'audio');
  if (images.length === 0 && audios.length === 0) return text;
  let out = text;
  const picked = images.slice(0, PERCEIVE_LIMITS.maxImages);
  const summaries = await Promise.all(picked.map(ref => describeImage(ref, deps)));
  for (const summary of summaries) out = out.replace('[图片]', `[图片：${summary}（识别可能有误）]`);
  const rest = images.length - picked.length;
  if (rest > 0) out = out.replace('[图片]', `[图片][还有 ${rest} 张图未读]`);
  // 语音同样要转写：一条语音只显示 [语音] 等于没听见。
  for (const audio of audios.slice(0, PERCEIVE_LIMITS.maxImages)) {
    out = out.replace('[语音]', `[语音：${await transcribeVoice(audio, deps)}（转写可能有误）]`);
  }
  return out;
}
