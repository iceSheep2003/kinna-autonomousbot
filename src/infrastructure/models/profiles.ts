import type { ModelRole, ModelSampling } from '../../shared/model.js';

/**
 * 按场合分开的采样参数。系统里只有**一个主体**（见 shared/persona.ts），
 * 这里分的不是四套人格，而是同一个人在四种场合下该给多少思考预算。
 *
 * DeepSeek V4 系列官方《思考模式》文档有两个硬约束，决定了这里不能一刀切：
 *
 * 1. 思考模式**不支持** `temperature` / `presence_penalty` / `frequency_penalty`：
 *    传了不报错，但完全不生效。想调温度就必须关思考，两者互斥。
 * 2. `top_p` 对 `deepseek-flash` 只在思考模式下生效，有效区间 0.95–1.0；
 *    非思考模式恒为 1.0，传入值被忽略。
 *
 * 另外思维链计入 `max_tokens`，所以「先想 1800 token 再回一句哈哈」既贵又慢，
 * 还会把聊天腔调带成书面报告。日常交流不该开思考。
 */
export type ModelProfile = ModelSampling & { maxTokens: number; timeoutMs: number };
export type ProfileOverrides = Partial<Record<ModelRole, Partial<ModelProfile>>>;

/** 四种场合的负荷不同，思考预算也就不同；人格始终只有一份，不在这里定义。 */
export const defaultProfiles: Record<ModelRole, ModelProfile> = {
  // 方向与跨任务取舍：要权衡承诺、证据和边界，需要想，但不必满格推理。
  self: { thinking: 'enabled', reasoningEffort: 'low', topP: 0.95, maxTokens: 8_000, timeoutMs: 90_000 },
  // 整合提炼：几十条经验交叉印证、裁决矛盾，最重的一档，给足预算和时间。
  dream: { thinking: 'enabled', reasoningEffort: 'high', topP: 0.95, maxTokens: 16_000, timeoutMs: 180_000 },
  // 有界执行的局部步骤：选工具、填参数、判断完成，不需要长思维链，要稳。
  execution: { thinking: 'disabled', temperature: 0.3, presencePenalty: 0.2, maxTokens: 2_000, timeoutMs: 30_000 },
  // 群里的日常交流：要快、要自然、要有活人味。关思考后 temperature 才真正生效。
  scene: { thinking: 'disabled', temperature: 0.85, presencePenalty: 0.4, maxTokens: 1_500, timeoutMs: 25_000 },
};

const ROLES: ModelRole[] = ['self', 'dream', 'execution', 'scene'];

/** 合并顺序：角色默认档 → 构造时覆盖 → 单请求覆盖。 */
export function resolveProfile(role: ModelRole, overrides: ProfileOverrides | undefined, sampling: ModelSampling | undefined): ModelProfile {
  return { ...defaultProfiles[role], ...overrides?.[role], ...sampling };
}

/** 关思考时要把只在思考模式有效的字段清掉，并给原本没温度的档位补一个。 */
function overrideFor(role: ModelRole, mode: 'on' | 'off'): Partial<ModelProfile> {
  const base = defaultProfiles[role];
  if (mode === 'off') return {
    thinking: 'disabled', reasoningEffort: undefined, topP: undefined,
    temperature: base.temperature ?? 0.6, presencePenalty: base.presencePenalty ?? 0.3,
  };
  return {
    thinking: 'enabled', temperature: undefined, presencePenalty: undefined,
    reasoningEffort: base.reasoningEffort ?? 'low', topP: base.topP ?? 0.95,
  };
}

/**
 * 环境变量只管最常见的两件事，避免 .env 变成第二套配置语言：
 * `LLM_THINKING=off` 全角色关思考（换非推理模型或省思维链 token），
 * `LLM_THINKING=on` 全角色开思考。更细的微调走 AGENT_CONFIG 或代码里的 profiles。
 */
export function profilesFromEnv(env: Record<string, string | undefined> = process.env): ProfileOverrides {
  const mode = env.LLM_THINKING?.toLowerCase();
  if (mode !== 'on' && mode !== 'off') return {};
  const result: ProfileOverrides = {};
  for (const role of ROLES) result[role] = overrideFor(role, mode);
  return result;
}
