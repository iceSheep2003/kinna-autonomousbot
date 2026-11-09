import { z } from 'zod';
import { id, text } from '../shared/schema.js';
export interface Job {
  id: string; kind: string; key: string; payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed'; attempts: number; dueAt: number; error?: string;
}
export const EventSchema = z.object({ id, source: id, kind: id, data: z.unknown(),
  route: z.discriminatedUnion('type', [z.object({ type: z.literal('self') }), z.object({ type: z.literal('experience') }),
    z.object({ type: z.literal('session'), sessionId: id, environment: id, scope: z.record(z.string().max(50), z.string().max(120)) }),
    z.object({ type: z.literal('execution'), executionId: id })]),
});
export type IncomingEvent = z.infer<typeof EventSchema>;
export const ScheduleInputSchema = z.object({ id, dueAt: z.number().int().positive(), goalId: id.optional(),
  action: z.discriminatedUnion('type', [z.object({ type: z.literal('wake'), reason: text }),
    z.object({ type: z.literal('execute'), intent: text, tools: z.array(id).max(30) }),
    z.object({ type: z.literal('tool'), name: id, input: z.record(z.string(), z.unknown()), reason: text })]),
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export interface Schedule extends ScheduleInput { goalRevision?: number; status: 'pending' | 'fired' | 'cancelled' }
