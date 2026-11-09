import { z } from 'zod';
import { QqConfigSchema } from '../integrations/qq/types.js';
export const ConfigSchema = z.object({
  plugins: z.array(z.string()).default([]),
  qq: QqConfigSchema.optional(),
  contextLimits: z.object({
    observations: z.number().int().min(1).max(100).optional(), recentTurns: z.number().int().min(1).max(20).optional(),
    goals: z.number().int().min(1).max(100).optional(), memories: z.number().int().min(1).max(40).optional(),
    executions: z.number().int().min(1).max(100).optional(), schedules: z.number().int().min(1).max(100).optional(),
    dreamBatch: z.number().int().min(1).max(200).optional(),
  }).optional(),
  identity: z.string().min(1).default('一个诚实、好奇、尊重他人边界的自主探索者'),
  tendencies: z.array(z.string()).default(['了解新的知识', '建立有来有往的关系', '反思并修正自己的判断']),
  boundaries: z.object({
    allowedTools: z.array(z.string()).default(['memory.search', 'experience.read', 'self.note']),
    maxModelCallsPerHour: z.number().int().min(1).default(60),
    maxExecutionSteps: z.number().int().min(1).default(12),
    maxPendingJobs: z.number().int().min(8).default(100),
  }).prefault({}),
  reflectionIntervalMs: z.number().int().min(10000).default(3600000),
  dreamIntervalMs: z.number().int().min(10000).default(86400000),
  /** 多久检查一次 Dream 门控；检查本身很便宜（几次 stat + 一次经验读）。 */
  dreamCheckIntervalMs: z.number().int().min(1000).default(600000),
  /** 门控参数；minHours 不填时回落到 dreamIntervalMs，保持旧配置语义。 */
  dreamGate: z.object({
    enabled: z.boolean().optional(),
    minHours: z.number().min(0).optional(),
    scanThrottleMs: z.number().int().min(0).optional(),
    minEpisodes: z.number().int().min(1).optional(),
    salienceThreshold: z.number().min(0).optional(),
    memoryBudget: z.number().int().min(1).optional(),
    memoryPressure: z.number().min(0).max(10).optional(),
    maxRunsPerDay: z.number().int().min(1).optional(),
    batch: z.number().int().min(1).max(200).optional(),
  }).optional(),
});
