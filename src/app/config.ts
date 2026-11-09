import { z } from 'zod';
import { QqConfigSchema } from '../integrations/qq/types.js';
import { defaultPersonality } from '../shared/persona.js';
import { defaultAffectConfig } from '../subject/mood-system.js';

const PersonalitySchema = z.object({
  temper: z.string().min(1),
  cares: z.array(z.string().min(1)),
  lines: z.array(z.string().min(1)),
  tone: z.enum(['steady', 'gentle', 'boundary']),
});

export const ConfigSchema = z.object({
  plugins: z.array(z.string()).default([]),
  qq: QqConfigSchema.optional(),
  contextLimits: z.object({
    observations: z.number().int().min(1).max(100).optional(), recentTurns: z.number().int().min(1).max(20).optional(),
    goals: z.number().int().min(1).max(100).optional(), memories: z.number().int().min(1).max(40).optional(),
    executions: z.number().int().min(1).max(100).optional(), schedules: z.number().int().min(1).max(100).optional(),
    dreamBatch: z.number().int().min(1).max(200).optional(),
  }).optional(),
  identity: z.string().min(1).default('群里一个记性不错、会替人留心的常驻伙伴'),
  tendencies: z.array(z.string()).default([
    '记住谁说过什么、最近过得怎么样',
    '有来有往，别光顾着自己说',
    '答应过别人的事要兑现，没做到就老实记下来',
  ]),
  /** personal 倾向开关：false 只去掉「偏好」那一段，身份与相处底线不变，供 A/B 对照。 */
  personal: z.boolean().default(true),
  /**
   * 会话层心境 / 互动反应 / 关系阶段的运行参数。
   * coupling 默认 0 是服务器实例实测后的取值：频繁事件不该把已有偏差反复放大。
   * 关掉 enabled 时不写库、不注入措辞；关掉 autoEnabled 只停自动更新。
   */
  affect: z.object({
    enabled: z.boolean().default(defaultAffectConfig.enabled),
    autoEnabled: z.boolean().default(defaultAffectConfig.autoEnabled),
    halfLifeMinutes: z.number().min(5).max(10080).default(defaultAffectConfig.halfLifeMinutes),
    sensitivity: z.number().min(0).max(3).default(defaultAffectConfig.sensitivity),
    minSociability: z.number().min(0).max(100).default(defaultAffectConfig.minSociability),
    coupling: z.number().min(0).max(2).default(defaultAffectConfig.coupling),
    reactionHalfLifeMinutes: z.number().min(1).max(120).default(12),
    reactionHardExpiryMinutes: z.number().min(1).max(240).default(45),
  }).prefault({}),
  /** 唯一一份人格定义，self / scene 等场合共用；不是每个 session 一套人设。 */
  personality: PersonalitySchema.default(defaultPersonality),
  boundaries: z.object({
    allowedTools: z.array(z.string()).default(['memory.search', 'experience.read', 'self.note', 'group.say']),
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
