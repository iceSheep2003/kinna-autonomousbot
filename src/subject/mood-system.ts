/**
 * 应用实际接线的唯一对象：会话层心境 + 互动反应 + 关系阶段。
 *
 * 对齐服务器 emotion/system.py 的四个出口（current / narration /
 * permits_proactive / history），再加上 CONTEXTUAL_AFFECT 的短时反应与
 * relationships 的阶段措辞。这里明确区分三种信息：
 *   - 稳定人设：shared/persona.ts，不在这里改；
 *   - 会话层五维心境：会自己衰减，可回放；
 *   - 按 scope+user 隔离的互动反应：45 分钟硬过期，不进长期记忆。
 *
 * 数字一律不进提示词。时钟是注入的，测试可以用固定时钟复现整天的心境曲线。
 */
import { z } from 'zod';
import type { AffectObserver, AffectStore, MoodObservation, MoodView,
  ObservationResult, RapportObservation, ReactionObservation } from './ports.js';
import { EmotionPolicy, baselineMood, moodFromRow, type Mood, type MoodSnapshot } from './mood.js';
import { replay, timeline } from './mood-history.js';
import { parseMoodVerdict } from './mood-verdict.js';
import { REACTION_INTENSITIES, REACTION_LABELS, isReactionFresh, narrateReaction,
  type InteractionReaction } from './reaction.js';
import { applyRapport, blankRapport, narrateRapport, type RapportSource } from './rapport.js';

export interface AffectConfig {
  enabled: boolean;
  /** 关掉自动更新，但保留已落库状态与上下文措辞。 */
  autoEnabled: boolean;
  halfLifeMinutes: number;
  sensitivity: number;
  minSociability: number;
  /** 服务器实测后默认 0：频繁事件不该反复放大已有偏差。 */
  coupling: number;
  reactionHalfLifeMs: number;
  reactionHardExpiryMs: number;
}

export const defaultAffectConfig: AffectConfig = {
  enabled: true, autoEnabled: true, halfLifeMinutes: 180, sensitivity: 1,
  minSociability: 35, coupling: 0,
  reactionHalfLifeMs: 12 * 60_000, reactionHardExpiryMs: 45 * 60_000,
};

export interface MoodSystemDependencies {
  store: AffectStore;
  clock?: () => number;
  config?: Partial<AffectConfig>;
  /** 没有会话信息时使用的默认 scope（长期 self 会话）。 */
  scope?: string;
}

const ReactionSchema = z.object({
  label: z.enum(REACTION_LABELS), intensity: z.enum(REACTION_INTENSITIES),
  reason: z.string().min(2).max(120),
});
const RapportSchema = z.object({
  delta: z.number().int().min(-3).max(3), reason: z.string().min(2).max(160),
  source: z.enum(['evaluator', 'main_reply', 'manual', 'import']).default('main_reply'),
});

export class MoodSystem implements MoodView, AffectObserver {
  private readonly store: AffectStore;
  private readonly clock: () => number;
  private readonly config: AffectConfig;
  private readonly defaultScope: string;
  readonly policy: EmotionPolicy;
  constructor(deps: MoodSystemDependencies) {
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
    this.config = { ...defaultAffectConfig, ...deps.config };
    this.defaultScope = deps.scope ?? 'self';
    this.policy = new EmotionPolicy({
      halfLifeMinutes: this.config.halfLifeMinutes, sensitivity: this.config.sensitivity,
      minSociability: this.config.minSociability, coupling: this.config.coupling,
    });
  }
  private scopeOf(scope?: string): string { return scope || this.defaultScope; }
  now(): number { return this.clock(); }

  /** 存储值按当前时刻衰减后的心境，不写回：睡几小时不需要后台 ticker。 */
  current(scope?: string): Mood {
    return this.policy.decay(moodFromRow(this.store.loadMood(this.scopeOf(scope))), this.now());
  }
  narration(scope?: string): string { return this.policy.narrate(this.current(scope)); }
  permitsProactive(scope?: string): boolean {
    if (!this.config.enabled) return true;
    return this.policy.permitsProactive(this.current(scope));
  }
  history(scope?: string): MoodSnapshot[] { return timeline(this.policy, this.store.moodEvents(this.scopeOf(scope))); }
  moodAt(when: number, scope?: string): Mood {
    return replay(this.policy, this.store.moodEvents(this.scopeOf(scope)), when);
  }

  /** 上下文层唯一入口：三种信息拼成一段有界中文，全都不含数值。 */
  describe(scope?: string, userId?: string): string {
    if (!this.config.enabled) return '';
    const key = this.scopeOf(scope);
    const parts = [this.narration(key)];
    if (userId) {
      const reaction = this.freshReaction(key, userId);
      if (reaction) parts.push(narrateReaction(reaction, this.now(), this.config.reactionHalfLifeMs));
      parts.push(this.rapportFor(key, userId));
    }
    return parts.join('\n');
  }

  private freshReaction(scope: string, userId: string): InteractionReaction | undefined {
    const reaction = this.store.reaction(scope, userId);
    if (!reaction) return;
    const halfLife = this.config.reactionHalfLifeMs;
    const fresh = isReactionFresh(reaction, this.now(), halfLife) &&
      this.now() - reaction.at < this.config.reactionHardExpiryMs;
    return fresh ? reaction : undefined;
  }
  rapportFor(scope: string, userId: string): string {
    return narrateRapport(this.store.rapport(scope, userId)?.score ?? blankRapport().score);
  }

  /** 已付费主回合交回的有界观察；畸形输出静默丢弃，幂等键不占用。 */
  observeMood(input: MoodObservation): ObservationResult {
    if (!this.writable()) return { accepted: false, reason: 'disabled' };
    const verdict = parseMoodVerdict(input.verdict);
    if (!verdict) return { accepted: false, reason: 'invalid verdict' };
    const scope = this.scopeOf(input.scope);
    if (this.store.seenMood(scope, input.dedupeKey)) return { accepted: false, reason: 'duplicate' };
    const now = input.now ?? this.now();
    const before = this.current(scope);
    const after = this.policy.apply(before, verdict.deltas, verdict.reason, now);
    const event = { at: now, deltas: verdict.deltas, reason: verdict.reason };
    const saved = this.store.saveMood(scope, after, event, input.dedupeKey);
    return saved ? { accepted: true } : { accepted: false, reason: 'duplicate' };
  }

  observeReaction(input: ReactionObservation): ObservationResult {
    if (!this.writable()) return { accepted: false, reason: 'disabled' };
    const parsed = ReactionSchema.safeParse(input);
    if (!parsed.success) return { accepted: false, reason: 'invalid reaction' };
    const scope = this.scopeOf(input.scope);
    const now = input.now ?? this.now();
    if (!this.store.claimReaction(scope, input.dedupeKey, now)) return { accepted: false, reason: 'duplicate' };
    const value: InteractionReaction = { scope, userId: input.userId, label: parsed.data.label,
      intensity: parsed.data.intensity, reason: parsed.data.reason, at: now, sourceEventId: input.sourceEventId };
    this.store.putReaction(scope, input.userId, value);
    return { accepted: true };
  }

  observeRapport(input: RapportObservation): ObservationResult {
    if (!this.writable()) return { accepted: false, reason: 'disabled' };
    const parsed = RapportSchema.safeParse(input);
    if (!parsed.success || parsed.data.delta === 0) return { accepted: false, reason: 'invalid proposal' };
    const scope = this.scopeOf(input.scope);
    const now = input.now ?? this.now();
    const key = `rapport:${input.dedupeKey}`;
    if (!this.store.claimReaction(scope, key, now)) return { accepted: false, reason: 'duplicate' };
    const state = this.store.rapport(scope, input.userId) ?? blankRapport();
    const outcome = applyRapport(state, {
      scope, userId: input.userId, delta: parsed.data.delta, reason: parsed.data.reason,
      source: parsed.data.source as RapportSource, sourceEventId: input.sourceEventId,
    }, now);
    if (!outcome.accepted) return { accepted: false, reason: outcome.reason };
    this.store.putRapport(scope, input.userId, outcome.state);
    return { accepted: true };
  }

  private writable(): boolean { return this.config.enabled && this.config.autoEnabled; }
}

/** 供诊断使用：一条从未发生过变化的心境，等于基线本身。 */
export function untouchedMood(): Mood { return baselineMood(); }
