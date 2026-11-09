import { z } from 'zod';
import type { LanguageModel, ModelRequest } from '../../shared/model.js';

export class OpenAICompatibleModel implements LanguageModel {
  constructor(private readonly config: { baseUrl: string; apiKey: string; model: string }) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    const schema = z.toJSONSchema(request.schema, { io: 'input' });
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${request.instructions}\nOutput JSON matching this JSON Schema:\n${JSON.stringify(schema)}` },
          { role: 'user', content: JSON.stringify(request.context) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty content');
    return request.schema.parse(JSON.parse(content));
  }
}
