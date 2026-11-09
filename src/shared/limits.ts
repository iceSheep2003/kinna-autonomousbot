export interface Boundaries {
  allowedTools: string[]; maxModelCallsPerHour: number; maxExecutionSteps: number; maxPendingJobs: number;
}
export interface ContextLimits { observations: number; recentTurns: number; goals: number; memories: number; executions: number; schedules: number; dreamBatch: number }
export const defaultContextLimits: ContextLimits = { observations: 20, recentTurns: 4, goals: 20, memories: 8, executions: 12, schedules: 20, dreamBatch: 80 };
/** 单次载荷预算：字符数上限，和“上下文取多少条”分开，避免散落在各模块里。 */
export const payloadBudget = {
  eventChars: 24000,
  toolResultChars: 24000,
  recallQueryChars: 3000,
} as const;
