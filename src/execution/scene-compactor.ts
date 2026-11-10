import type { LanguageModel } from '../shared/model.js';
import type { Experience } from '../memory/types.js';
import { EMPTY_SCENE_STATE, SceneStateSchema, COMPACT_PROMPT, type SceneState } from './scene-compaction.js';
import { renderSceneState } from './scene-compaction.js';

/** 压缩端口：场景只认这个窄接口，具体怎么调模型在下面实现。 */
export interface SceneCompactor {
  compact(input: { prior: SceneState | undefined; rows: readonly Experience[] }): Promise<SceneState>;
}

/**
 * 用模型把一段旧对话压成现场状态。
 *
 * 输入是「已有状态 + 这批原文」，输出是新的状态（不是合并两份列表）：
 * 已经结束的事由模型在新一轮里删掉，代码不替它判断哪些该留。
 */
export class ModelSceneCompactor implements SceneCompactor {
  constructor(private readonly model: LanguageModel) {}

  async compact(input: { prior: SceneState | undefined; rows: readonly Experience[] }): Promise<SceneState> {
    const prior = input.prior ?? EMPTY_SCENE_STATE;
    const lines = input.rows.map(row => formatRow(row));
    const decision = await this.model.decide({
      role: 'execution', schema: SceneStateSchema, instructions: COMPACT_PROMPT,
      context: {
        earlier: renderSceneState(input.prior) || '(还没有更早的状态)',
        transcript: lines.join('\n'),
      },
    });
    return decision as SceneState;
  }
}

/** 一条经验压成一行；不是会话消息的行跳过，避免把系统流水当成对话。 */
function formatRow(row: Experience): string {
  const data = row.data as Record<string, unknown> | undefined;
  const text = [data?.text, data?.message, data?.content].find(value => typeof value === 'string' && value.trim() !== '');
  if (typeof text !== 'string') return '';
  const who = typeof data?.nickname === 'string' ? data.nickname : typeof data?.role === 'string' ? data.role : '?';
  return `${who}: ${text.slice(0, 200)}`;
}
