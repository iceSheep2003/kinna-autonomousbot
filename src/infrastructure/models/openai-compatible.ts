import { z } from 'zod';
import type { LanguageModel, ModelRequest } from '../../shared/model.js';
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
          { role: 'user', content: JSON.stringify(request.context) },
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
