import type { z } from 'zod';

/**
 * 同一主体此刻在做什么。**不是四种人格／四个角色**，人格只有一份（见 shared/persona.ts）。
 * 这里只是调用场合标签，用来挑思考预算与输出体积：
 * 自己想事情、在群里接话、办一件具体事、夜里回想，负荷天然不同。
 */
export type ModelRole = 'self' | 'execution' | 'scene' | 'dream';

/**
 * 一次调用想要的采样方式。放在 port 层是刻意的：它描述意图，不承诺供应商支持；
 * 适配器只发自己支持、且在当前模式下真正生效的字段，其余忽略。
 */
export interface ModelSampling {
  /** 供应商不支持 thinking 时整体不发；关思考后温度类参数才生效。 */
  thinking?: 'enabled' | 'disabled';
  /** 仅思考模式有效：low / high / max。 */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 仅非思考模式生效。 */
  temperature?: number;
  /** 仅非思考模式生效；压「群发模板」式的套话。 */
  presencePenalty?: number;
  /** 仅部分模型的思考模式生效，有效区间 0.95–1.0。 */
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelRequest<T> {
  role: ModelRole; instructions: string; context: unknown; schema: z.ZodType<T>;
  /** 兼容旧调用：单次超时，优先于角色档位，但低于 sampling.timeoutMs。 */
  timeoutMs?: number;
  /** 单请求覆盖，例如临时关掉某次调用的思考或放宽输出。 */
  sampling?: ModelSampling;
}
export interface LanguageModel { decide<T>(request: ModelRequest<T>): Promise<T> }
