import type { z } from 'zod';
export interface ModelRequest<T> {
  role: 'self' | 'execution' | 'scene' | 'dream'; instructions: string; context: unknown; schema: z.ZodType<T>;
}
export interface LanguageModel { decide<T>(request: ModelRequest<T>): Promise<T> }
