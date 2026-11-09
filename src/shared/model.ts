import type { z } from 'zod';
export interface ModelRequest<T> {
  role: 'self' | 'execution' | 'scene' | 'dream'; instructions: string; context: unknown; schema: z.ZodType<T>;
  /** 单次调用超时；整理一批经验比一轮自我决策重得多，需要单独放宽。 */
  timeoutMs?: number;
}
export interface LanguageModel { decide<T>(request: ModelRequest<T>): Promise<T> }
