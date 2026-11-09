import { z } from 'zod';
import { id, text, refs } from '../shared/schema.js';
export const IntentSchema = z.object({ intent: text, goalId: id.optional(), tools: z.array(id).max(30) });
export type Intent = z.infer<typeof IntentSchema>;
export const DirectActionSchema = z.object({ name: id, input: z.record(z.string(), z.unknown()), reason: text, goalId: id.optional() });
export type DirectAction = z.infer<typeof DirectActionSchema>;
export interface Execution extends Intent {
  id: string; status: 'active' | 'completed' | 'paused' | 'failed'; progress: string; steps: number; result?: string;
  directAction?: DirectAction;
}
export const ExecutionDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), name: id, input: z.record(z.string(), z.unknown()), progress: text }),
  z.object({ type: z.literal('complete'), result: text, evidence: refs }),
  z.object({ type: z.literal('escalate'), reason: text, evidence: refs }),
]);
export type ExecutionDecision = z.infer<typeof ExecutionDecisionSchema>;
