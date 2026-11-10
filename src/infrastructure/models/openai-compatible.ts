import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { LanguageModel, ModelImage, ModelRequest } from '../../shared/model.js';
import type { ModelProfile, ProfileOverrides } from './profiles.js';
import { resolveProfile } from './profiles.js';

interface Completion {
  choices?: { finish_reason?: string; message?: { content?: string } }[];
}
export interface OpenAICompatibleConfig {
  baseUrl: string; apiKey: string; model: string;
  /** 按角色覆盖采样档位；不传用 defaultProfiles。 */
  profiles?: ProfileOverrides;
}

/**
 * 只发当前模式真正生效的字段。思考模式下 temperature / presence_penalty 被静默忽略，
 * 非思考模式下 top_p 恒为 1.0；把「传了但没生效」的参数塞进 body，
 * 只会让配置看起来在起作用，排查时反而误导。
 */
function samplingFields(profile: ModelProfile): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (profile.thinking) body.thinking = { type: profile.thinking };
  if (profile.thinking === 'enabled') {
    body.reasoning_effort = profile.reasoningEffort ?? 'high';
    if (profile.topP !== undefined) body.top_p = profile.topP;
    return body;
  }
  if (profile.temperature !== undefined) body.temperature = profile.temperature;
  if (profile.presencePenalty !== undefined) body.presence_penalty = profile.presencePenalty;
  return body;
}

/** 超时优先级：单请求 sampling > 旧的 request.timeoutMs > 场合档位。 */
function timeoutOf(request: { sampling?: { timeoutMs?: number }; timeoutMs?: number }, profile: ModelProfile): number {
  const single = request.sampling?.timeoutMs ?? request.timeoutMs;
  return single ?? profile.timeoutMs;
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** 图片 URL 太长或没有 URL 时退回内联；格式按扩展名猜，猜不到按 jpeg。 */
async function imageSource(image: ModelImage): Promise<string> {
  // data: URL 本身就是内联数据（可达几百 KB），不受 8192 字符的「外部链接」上限约束。
  if (image.url?.startsWith('data:')) return image.url;
  if (image.url && image.url.length <= 8192) return image.url;
  if (!image.path) throw new Error('图片既没有可用 URL 也没有本地文件');
  const bytes = await readFile(image.path);
  const ext = image.path.slice(image.path.lastIndexOf('.')).toLowerCase();
  return `data:${MIME[ext] ?? 'image/jpeg'};base64,${bytes.toString('base64')}`;
}

/** 一条 user 消息：先文字，再逐张图；每张图前面标一句「这是哪张」。 */
async function userContent(request: ModelRequest<unknown>): Promise<unknown> {
  const text = JSON.stringify(request.context);
  if (!request.images?.length) return text;
  const blocks: unknown[] = [{ type: 'text', text }];
  for (const [index, image] of request.images.entries()) {
    if (image.label) blocks.push({ type: 'text', text: `图 ${index + 1}：${image.label}` });
    blocks.push({ type: 'image_url', image_url: { url: await imageSource(image), ...(image.detail ? { detail: image.detail } : {}) } });
  }
  return blocks;
}

export class OpenAICompatibleModel implements LanguageModel {
  constructor(private readonly config: OpenAICompatibleConfig) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    const profile = resolveProfile(request.role, this.config.profiles, request.sampling);
    const schema = z.toJSONSchema(request.schema, { io: 'input' });
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutOf(request, profile)),
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: profile.maxTokens,
        ...samplingFields(profile),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${request.instructions}\nOutput JSON matching this JSON Schema:\n${JSON.stringify(schema)}` },
          { role: 'user', content: await userContent(request) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const choice = (await response.json() as Completion).choices?.[0];
    // 截断会让 JSON.parse 报 “Unterminated string”，掩盖真正原因；先显式拦下。
    if (choice?.finish_reason === 'length') throw new Error(`LLM output truncated at max_tokens=${profile.maxTokens}`);
    const content = choice?.message?.content;
    if (!content) throw new Error('LLM returned empty content');
    return request.schema.parse(JSON.parse(content));
  }
}
