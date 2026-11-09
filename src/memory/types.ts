import { z } from 'zod';
import { id, text, refs } from '../shared/schema.js';

export interface Experience { seq: number; at: number; source: string; kind: string; data: unknown }

/** 群整体事实的主体，而不是某个人。 */
export const GROUP_SUBJECT = '_group_';
export const FACT_TYPES = ['fact', 'preference', 'relation', 'event', 'boundary', 'open_loop', 'promise'] as const;
export type FactType = (typeof FACT_TYPES)[number];
/** 一条记忆可以被怎样提起；召回路径必须原样保留，不能一律念出来。 */
export const MENTION_POLICIES = ['direct', 'soft_echo', 'tone_only', 'avoid_unless_asked'] as const;
export type MentionPolicy = (typeof MENTION_POLICIES)[number];
/** `revise`：回放里发现这句不再对，改成新说法；`replay`：回放确认它仍然成立，只是补了证据。 */
export const REVISION_REASONS = ['revise', 'replay'] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];
export const MEMORY_STATUSES = ['active', 'candidate', 'archived', 'expired', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryVisibility = 'group' | 'personal';
/** 低于此把握的事实先当候选，不直接进上下文。 */
export const CANDIDATE_CONFIDENCE = 0.6;
export const MEMORY_CONTENT_MAX_CHARS = 300;

/**
 * 长期记忆。
 *
 * 头五个字段沿用 Dream 的产出契约；其余字段全部可选，这样旧库里的记忆、
 * Dream 生成的记忆、以及服务器式提炼写入的记忆可以共存。
 * subjectUserId 表示「事实关于谁」，visibility 表示「谁能看」，两者不是一回事。
 */
export interface Memory {
  id: string; content: string; evidence: number[];
  kind: 'observation' | 'inference' | 'strategy'; revision: number;
  scope?: string;
  subjectUserId?: string;
  personaSummary?: string;
  mentionPolicy?: MentionPolicy;
  factType?: FactType;
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  visibility?: MemoryVisibility;
  sourceEventId?: string;
  originUserId?: string;
  expiresAt?: number;
  lastAccessedAt?: number;
  accessCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface Reflection { id: string; sourceRefs: number[]; summary: string; conclusions: string[]; proposedChanges: string[]; at: number }

/**
 * 某个整合会话里的一轮「回放 → 修订」。
 * Claude Code 的 dream 是带工具、能多轮读会话记录的子代理；这里用 R1..Rn 的开环
 * 迭代补上同一个能力：每轮都能看见上一轮写下的记忆，并修改、合并或撤回它们，
 * 而不是只做一次「读完 → 一次性输出」。回合对模型只读，修订才是它的产出。
 */
/**
 * Dream 回放里翻出来的「一次机会」：想做但还没做的事。
 *
 * Dream 只负责翻出来，不负责做——它看不到目标、对方在不在线、今天开过几次口。
 * 机会作为素材进 self 的 inbox，由 self 在下一轮决定现在做、等一等还是不做。
 */
export const OPPORTUNITY_KINDS = ['follow_up', 'check_in', 'share', 'observe'] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];
export const OPPORTUNITY_URGENCIES = ['now', 'today', 'when_idle'] as const;
export type OpportunityUrgency = (typeof OPPORTUNITY_URGENCIES)[number];

/** 给出机会时，同一条证据最多说几次，避免一次回放把同一句话反复报成新机会。 */
export const OPPORTUNITY_MAX_ITEMS = 6;

export const OpportunitySchema = z.object({
  id,
  kind: z.enum(OPPORTUNITY_KINDS),
  /** 关于谁 / 什么事，带社交锚点，self 才知道该找谁。 */
  about: text.max(120),
  why: text.max(600),
  urgency: z.enum(OPPORTUNITY_URGENCIES).default('when_idle'),
  /** 必须能指回本批具体经验；没有证据的「机会」就是凭空想出来的任务。 */
  evidence: refs.min(1),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export interface DreamLoop {
  episode: { fromExclusive: number; throughInclusive: number; live: number[] };
  workspace: Array<{ id: string; content: string; kind: Memory['kind']; evidence: number[]; status: string }>;
  round: number;
}

export const DreamRoundSchema = z.object({
  /** 本轮相对上一轮改了什么，写给人和日志看。 */
  note: text.max(2000).optional(),
  /** 本轮新写的记忆。 */
  memories: z.array(z.object({ id, content: text, evidence: refs.min(1), kind: z.enum(['observation', 'inference', 'strategy']) })).max(30).optional(),
  /** 对已有记忆的修改：改内容、补证据，或把一条并入另一条（mergeInto）。 */
  revisions: z.array(z.object({
    id, reason: z.enum(REVISION_REASONS),
    content: text.optional(), evidence: refs.optional(), kind: z.enum(['observation', 'inference', 'strategy']).optional(),
    mergeInto: id.optional(),
  })).max(30).optional(),
  /** 撤回：回放后发现这句不成立。 */
  retractions: z.array(z.object({ id, reason: text.max(500).optional() })).max(30).optional(),
  /** 翻出来的机会：想做但还没做的事。只给 self 当素材，不会直接变成任何动作。 */
  opportunities: z.array(OpportunitySchema).max(OPPORTUNITY_MAX_ITEMS).optional(),
  failedApproaches: z.array(text).max(20).optional(),
  proposals: z.array(text).max(12).optional(),
});
export type DreamRound = z.infer<typeof DreamRoundSchema>;

/** 兼容旧名：字段与 DreamRound 相同。 */
export const DreamDecisionSchema = DreamRoundSchema;
export type DreamDecision = DreamRound;

export interface DreamVersion {
  id: string; cursor: number; cutoff: number; candidate: DreamDecision;
  status: 'published'; at: number;
  /** 几轮回放、是否收敛（模型主动说「没别的要改」）。旧版一次性整合没有这两个字段。 */
  rounds?: number; converged?: boolean;
  /** 本次翻出来、已投递给 self 的机会（不含被合并、被内联原文挡掉、被去重的）。 */
  opportunities?: Opportunity[];
}

export const MemoryProposalSchema = z.object({
  id: id.optional(),
  content: z.string().min(5).max(MEMORY_CONTENT_MAX_CHARS),
  subjectUserId: z.string().min(1).max(120).default(GROUP_SUBJECT),
  personaSummary: z.string().max(120).default(''),
  mentionPolicy: z.enum(MENTION_POLICIES).default('soft_echo'),
  factType: z.enum(FACT_TYPES).default('fact'),
  kind: z.enum(['observation', 'inference', 'strategy']).default('observation'),
  confidence: z.number().min(0).max(1).default(0.65),
  importance: z.number().int().min(1).max(5).default(1),
  visibility: z.enum(['group', 'personal']).default('personal'),
  evidence: refs.default([]),
  scope: z.string().max(120).optional(),
  sourceEventId: z.string().max(120).optional(),
  originUserId: z.string().max(120).optional(),
  expiresAt: z.number().int().positive().optional(),
  supersedes: z.boolean().default(false),
});
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

/** 一条记忆为什么被选中，给人和实验记录看。 */
export interface RetrievalHit { memory: Memory; score: number; reasons: string[] }
export type ConfidenceLabel = 'high' | 'medium' | 'low';
export interface MemoryContextItem {
  id: string; fact: string; type: FactType; personaHint: string;
  mentionPolicy: MentionPolicy; confidence: ConfidenceLabel; subject: string;
}
export interface MemoryContext {
  items: MemoryContextItem[];
  usageRule: string;
  explain: string[];
  /** 因预算或过长被整条跳过的记录数；不做截断前半句。 */
  omitted: number;
}
export interface RecallRequest {
  query: string; limit: number; now: number;
  scope?: string; subjectUserId?: string;
  includeCandidates?: boolean; budgetChars?: number;
}
export type MemoryWriteOutcome = { kind: 'inserted' | 'reinforced' | 'superseded' | 'duplicate'; id: string };
