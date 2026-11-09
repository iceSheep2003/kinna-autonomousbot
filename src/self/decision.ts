import { z } from 'zod';
import { id, text } from '../shared/schema.js';
import { GoalSchema, AppraisalSchema } from '../subject/types.js';
import { IntentSchema, DirectActionSchema } from '../execution/types.js';
import { ScheduleInputSchema } from '../runtime/types.js';
export const SelfDecisionSchema = z.object({
  reflection: text, direction: text.optional(), focus: text.optional(), affect: AppraisalSchema.optional(),
  goals: z.array(GoalSchema).max(12).default([]), launch: z.array(IntentSchema).max(4).default([]),
  act: z.array(DirectActionSchema).max(4).default([]),
  schedules: z.array(ScheduleInputSchema).max(12).default([]), cancelSchedules: z.array(id).max(20).default([]),
  cancelExecutions: z.array(id).max(20).default([]), dream: z.boolean().default(false), nextWakeAt: z.number().int().positive().optional(),
});
export type SelfDecision = z.infer<typeof SelfDecisionSchema>;
