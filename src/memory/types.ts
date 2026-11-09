import { z } from 'zod';
import { id, text, refs } from '../shared/schema.js';
export interface Experience { seq: number; at: number; source: string; kind: string; data: unknown }
export interface Memory { id: string; content: string; evidence: number[]; kind: 'observation' | 'inference' | 'strategy'; revision: number }
export interface Reflection { id: string; sourceRefs: number[]; summary: string; conclusions: string[]; proposedChanges: string[]; at: number }
export const DreamDecisionSchema = z.object({
  summary: text,
  memories: z.array(z.object({ id, content: text, evidence: refs.min(1), kind: z.enum(['observation', 'inference', 'strategy']) })).max(30),
  proposals: z.array(text).max(12),
});
export type DreamDecision = z.infer<typeof DreamDecisionSchema>;
export interface DreamVersion { id: string; cursor: number; cutoff: number; candidate: DreamDecision; status: 'published'; at: number }
