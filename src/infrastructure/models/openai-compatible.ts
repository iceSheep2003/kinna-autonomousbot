import { z } from 'zod';
import type { LanguageModel, ModelRequest } from '../../shared/model.js';

/** 推理模型的思维链也计入 max_tokens；给 4000 会在长推理时把 JSON 截断成语法错误。 */
const MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;
interface Completion {
  choices?: { finish_reason?: string; message?: { content?: string } }[];
}

export class OpenAICompatibleModel implements LanguageModel {
  constructor(private readonly config: { baseUrl: string; apiKey: string; model: string }) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    const schema = z.toJSONSchema(request.schema, { io: 'input' });
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, max_tokens: MAX_OUTPUT_TOKENS,
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
    if (choice?.finish_reason === 'length') throw new Error(`LLM output truncated at max_tokens=${MAX_OUTPUT_TOKENS}`);
    const content = choice?.message?.content;
    if (!content) throw new Error('LLM returned empty content');
    return request.schema.parse(JSON.parse(content));
  }
}
