import type { AffectState, Appraisal, Goal, GoalRevision, SelfState } from './types.js';
import type { Mood, MoodEvent } from './mood.js';
import type { InteractionReaction } from './reaction.js';
import type { RapportState } from './rapport.js';
export interface SubjectRepository {
  read(): SelfState | undefined;
  save(state: SelfState): void;
  recordAppraisal(appraisal: Appraisal, now: number): void;
  affectFor(target: string): AffectState | undefined;
}
export interface GoalRepository {
  get(id: string): Goal | undefined;
  save(goal: Goal): void;
  relevant(query: string, limit: number): Goal[];
  recordRevision(change: GoalRevision, now: number): void;
}
export interface EvidenceReader { assertExists(refs: number[]): void }

/**
 * 会话层心境 / 互动反应 / 关系状态的私有仓储。
 *
 * 与 SubjectRepository 分开是刻意的：SelfState 属于唯一主体，会随 identity 一起
 * 被修订；这三样是「这会儿」的状态，有自己的衰减、过期和事件日志。删掉整个
 * 情感包不会在主体表里留孤儿字段。
 */
export interface MoodStore {
  loadMood(scope: string): Mood | undefined;
  /** 返回 false 表示这个幂等键已经应用过，调用方不应再记事件。 */
  saveMood(scope: string, mood: Mood, event: MoodEvent, dedupeKey?: string): boolean;
  seenMood(scope: string, key: string): boolean;
  moodEvents(scope: string): MoodEvent[];
}
export interface ReactionStore {
  reaction(scope: string, userId: string): InteractionReaction | undefined;
  putReaction(scope: string, userId: string, value: InteractionReaction | undefined): void;
  claimReaction(scope: string, key: string, at: number): boolean;
}
export interface RapportStore {
  rapport(scope: string, userId: string): RapportState | undefined;
  putRapport(scope: string, userId: string, state: RapportState): void;
}
export interface AffectStore extends MoodStore, ReactionStore, RapportStore {}

/** 上下文层唯一可见的读接口：只拿到已衰减、不含数值的措辞。 */
export interface MoodView {
  describe(scope?: string, userId?: string): string;
  permitsProactive(scope?: string): boolean;
}

export interface ObservationResult { accepted: boolean; reason?: string }
export interface MoodObservation {
  scope?: string; dedupeKey: string; verdict: unknown; now?: number; sourceEventId?: string;
}
export interface ReactionObservation {
  scope?: string; userId: string; dedupeKey: string; label: string;
  intensity: string; reason: string; now?: number; sourceEventId?: string;
}
export interface RapportObservation {
  scope?: string; userId: string; dedupeKey: string; delta: number; reason: string;
  source?: string; now?: number; sourceEventId?: string;
}
/** 工具层只看到这个窄接口，拿不到 store、policy 或主体写权限。 */
export interface AffectObserver {
  observeMood(input: MoodObservation): ObservationResult;
  observeReaction(input: ReactionObservation): ObservationResult;
  observeRapport(input: RapportObservation): ObservationResult;
}
/** 供执行/上下文查询使用；没有任何写接口。 */
export interface SubjectView {
  read(): SelfState;
  goal(id: string): Goal | undefined;
  goals(query: string, limit: number): Goal[];
  requireActiveGoal(id?: string): Goal | undefined;
}
