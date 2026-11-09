import { readFile } from 'node:fs/promises';
import type { FramePerception } from '../../integrations/bilibili/ports.js';

export interface VisionConfig { baseUrl: string; apiKey: string; model: string }

/**
 * 抽帧读视频的画面理解：把几帧拼成一条多模态消息问视觉模型。
 *
 * 为什么不走 LanguageModel 端口：它只接受 JSON 上下文、返回结构化对象，
 * 而这里需要的是「看图片」，属于另一类调用；把图片塞进 JSON 会变成 base64 文本，
 * 既不省 token 也容易让模型把编码当成内容读。所以单独做一个窄接口。
 */
export class OpenAiVision implements FramePerception {
  constructor(private readonly config: VisionConfig) {}

  async describe(input: { bvid: string; frames: string[]; question: string }, signal: AbortSignal): Promise<string> {
    const images = await Promise.all(input.frames.map(async file => ({
      type: 'image_url' as const,
      image_url: { url: `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}` },
    })));
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model, max_tokens: 800,
        messages: [
          { role: 'system', content: '你在看一个视频的若干帧截图（按时间顺序）。只描述画面里确实有的东西：场景、人物、动作、屏幕上的文字。不要猜测视频主题，也不要脑补没出现的画面。' },
          { role: 'user', content: [...images, { type: 'text', text: input.question }] },
        ],
      }),
    });
    if (!response.ok) throw new Error(`视觉模型 HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('视觉模型没有返回内容');
    return text.slice(0, 6000);
  }
}

export function visionFromEnv(env: Record<string, string | undefined>): OpenAiVision | undefined {
  const baseUrl = env.BILIBILI_VISION_BASE_URL?.trim();
  const apiKey = env.BILIBILI_VISION_API_KEY?.trim();
  const model = env.BILIBILI_VISION_MODEL?.trim();
  return baseUrl && apiKey && model ? new OpenAiVision({ baseUrl, apiKey, model }) : undefined;
}
