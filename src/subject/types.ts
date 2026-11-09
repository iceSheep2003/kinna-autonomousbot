import { z } from 'zod';
import { id, text, refs } from '../shared/schema.js';
export const GoalSchema = z.object({
  id, content: text, horizon: z.enum(['short', 'long']), status: z.enum(['active', 'paused', 'completed', 'abandoned']),
  reason: text, evidence: refs, parentId: id.optional(),
});
export type GoalChange = z.infer<typeof GoalSchema>;
export type Goal = GoalChange & { revision: number; updatedAt: number };
export const AppraisalSchema = z.object({
  valence: z.number().min(-1).max(1), arousal: z.number().min(0).max(1), description: text, evidence: refs,
  target: id.optional(), interpretation: text.optional(),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;
export interface AffectState { valence: number; arousal: number; description: string; updatedAt: number }
export interface SelfState {
  id: 'self'; identity: string; tendencies: string[]; direction: string; focus?: string; affect: AffectState; revision: number;
}
export interface SubjectChange { direction?: string; focus?: string; affect?: Appraisal; goals: GoalChange[] }
export interface GoalRevision { previous?: Goal; next: Goal }
