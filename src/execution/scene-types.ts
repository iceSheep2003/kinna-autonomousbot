import { z } from 'zod';
import type { SceneState } from './scene-compaction.js';
import { id, text, refs } from '../shared/schema.js';
export interface SceneDescriptor { id: string; environment: string; scope: Record<string, string> }
export interface SceneSessionState extends SceneDescriptor {
  cursor: number; steps: number; summary: string; updatedAt: number;
  /** 已经压缩到哪个游标；之前的内容不再读原文，只看现场状态。 */
  compactedThrough?: number;
  /** 压缩出的现场状态；没有就是还没压过。 */
  sceneState?: SceneState;
}
export const SceneDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), name: id, input: z.record(z.string(), z.unknown()), progress: text }),
  z.object({ type: z.literal('wait'), summary: text.optional() }),
  z.object({ type: z.literal('reflect'), trigger: z.enum(['goal_conflict', 'important_discovery', 'direction_review', 'relationship_change', 'persistent_failure']), summary: text, evidence: refs.min(1) }),
]);
export type SceneDecision = z.infer<typeof SceneDecisionSchema>;
export interface SceneStep { decision: SceneDecision; context: unknown; through: number }
