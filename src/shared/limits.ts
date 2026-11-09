export interface Boundaries {
  allowedTools: string[]; maxModelCallsPerHour: number; maxExecutionSteps: number; maxPendingJobs: number;
}
export interface ContextLimits { observations: number; recentTurns: number; goals: number; memories: number; executions: number; schedules: number; dreamBatch: number }
export const defaultContextLimits: ContextLimits = { observations: 20, recentTurns: 4, goals: 20, memories: 8, executions: 12, schedules: 20, dreamBatch: 80 };
