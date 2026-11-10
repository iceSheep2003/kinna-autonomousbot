import type { ModelSampling, LanguageModel } from '../shared/model.js';
import type { Commit } from '../shared/transaction.js';
import type { ContextLimits } from '../shared/limits.js';
import type { DreamFeedback, ExperienceLog, MemoryRepository } from './ports.js';
import { DreamRoundSchema, type DreamLoop, type DreamRound, type DreamVersion, type Memory, type Opportunity } from './types.js';
import { lived } from './lived.js';
import { promoteMemories, writeMemoryIndex, type DreamPromotion } from './dream-effects.js';
import type { IndexEntry } from './index-layer.js';
import { screenOpportunities } from './opportunity.js';
import { checkMemory, guardScope, judge, loopOf, snapshotOf, type Workbook } from './replay-rules.js';
import { DREAM_INSTRUCTIONS, DREAM_REPLAY_NOTES } from './dream-prompts.js';

/** 提示词从 dream-prompts.ts 拆出，但调用方仍从本模块取，避免破坏既有引用。 */
export { DREAM_INSTRUCTIONS, DREAM_REPLAY_NOTES };

export type DreamMemory = Omit<Memory, 'revision'>;

export interface DreamDependencies {
  repository: MemoryRepository;
  experience: ExperienceLog;
  model: LanguageModel;
  feedback: DreamFeedback;
  limits: ContextLimits;
  /** 回放上限与采样档位；缺省见 DREAM_POLICY。 */
  policy?: Partial<typeof DREAM_POLICY>;
  /** 是否把翻出来的机会交给 self（A/B 对照与回滚用）；关闭后机会字段照收但不投递。 */
  opportunities?: boolean;
}

/**
 * 回放策略。
 *
 * Claude Code 的 dream 子代理带着工具、多轮读会话记录；这里用「同一个批次回放
 * R1..Rn 遍」补上同样的过程：第 1 遍先写，之后每遍都带着上一遍的结果再看一遍，
 * 改、合并、撤回，直到某遍模型明确说「没别的要改」（converged）或到达上限。
 *
 * 为什么不能只做一次：一次性的「读 → 一次性输出」会让模型在同一批素材里
 * 写出三句互相重复、互相矛盾的话，因为它从没回头看过自己刚写了什么。
 *
 * 为什么要有上限：每多一遍就是一次模型调用。第 2 遍拿一次性的「是否收敛」作
 * 判断，避免把有限的预算花在先写后改同样的内容上；R1/R2/R3 三遍已经覆盖
 * 「写 → 改 → 定格」的基本节奏。
 */
export const DREAM_POLICY = {
  /** 最多回放几遍：1 = 退回一次性整合，2..8 = 先写再改。 */
  maxRounds: 3,
  /** 每一遍的采样档位：第 1 遍偏发散，修订遍压低温度（有些模型不接受 temperature 时由适配器忽略）。 */
  sampling: [
    { thinking: 'enabled', reasoningEffort: 'high' } as ModelSampling,
    { thinking: 'enabled', reasoningEffort: 'low', temperature: 0.3 } as ModelSampling,
  ] as ModelSampling[],
} as const;

/** 一次 Dream 提交需要的全部信息。 */
interface DreamResult {
  id: string; cursor: number; cutoff: number; revisions: Map<string, number>; now: number;
  /** 最终工作副本与库之间的差异：提交时一次原子落库。 */
  ops: DreamOp[];
  rounds: number; converged: boolean;
  /** 一批全是系统流水时只推进游标，不叫醒 self 汇报「我什么都没想起来」。 */
  notify: boolean; summary: string; proposals: string[]; failedApproaches: string[];
  /** 已通过「够不够格」校验的机会，随完成通知一起投递给 self。 */
  opportunities: Opportunity[];
  /** 模型判断该提到通用层的记忆。 */
  promotions: DreamPromotion[];
  /** 模型给出的记忆索引；undefined 表示这次不动索引。 */
  index?: IndexEntry[];
}

/**
 * 只拥有记忆发布权；没有 subject、目标或执行的写接口。
 *
 * 一次整合内部是完整的开环迭代：
 *   R1 先写   →  R2 带着 R1 的结果再回放一次，改/并/撤回  →  R3 复核并定格
 * 回合（回放到的经验）对模型只读，产出是记忆的修订；每一遍都校验证据与版本，
 * 提交时把所有修订作为一次原子操作落库，并记录回放了几遍、是否收敛。
 */
export class DreamService {
  private readonly repository: MemoryRepository;
  private readonly experience: ExperienceLog;
  private readonly model: LanguageModel;
  private readonly feedback: DreamFeedback;
  private readonly limits: ContextLimits;
  private readonly policy: typeof DREAM_POLICY;
  private readonly collectOpportunities: boolean;
  /** 本次整合里已经写下的记忆 id：回放只能 revision 它们，不能整个替换。 */
  private readonly publishedThisDream = new Set<string>();
  constructor(deps: DreamDependencies) {
    this.repository = deps.repository; this.experience = deps.experience; this.model = deps.model;
    this.feedback = deps.feedback; this.limits = deps.limits;
    this.policy = { ...DREAM_POLICY, ...(deps.policy ?? {}) } as typeof DREAM_POLICY;
    this.collectOpportunities = deps.opportunities !== false;
  }
  async prepare(id: string, error: string | undefined, now: number): Promise<Commit> {
    const cursor = this.repository.cursor();
    const batch = this.experience.read(cursor, this.limits.dreamBatch);
    if (!batch.length) return () => {};
    // 游标按全量推进：系统流水不进上下文，但必须被消耗掉，否则会卡在同一批反复读。
    const cutoff = batch.at(-1)!.seq;
    const experiences = lived(batch);
    const prior = this.repository.recent(this.limits.memories * 5);
    const revisions = new Map(prior.map(m => [m.id, m.revision]));
    if (!experiences.length) {
      return () => this.commit({
        id, cursor, cutoff, revisions, ops: [], rounds: 0, converged: true, now, notify: false,
        summary: '这段时间没有值得记下的事', proposals: [], failedApproaches: [], opportunities: [], promotions: [],
      });
    }
    const loop = await this.replay({ cursor, cutoff, experiences, prior, error, revisions });
    return () => this.commit({
      id, cursor, cutoff, revisions, ops: loop.ops, rounds: loop.rounds, converged: loop.converged, now,
      notify: true, summary: loop.summary, proposals: loop.proposals, failedApproaches: loop.failedApproaches,
      promotions: loop.promotions, ...(loop.index ? { index: loop.index } : {}),
      opportunities: loop.opportunities,
    });
  }

  /**
   * 回放 R1..Rn：每遍都把同一批经验和同一个 workspace 交给模型，模型只做增量修订。
   * 提交时按最终工作副本与库里的差异一次原子落库。
   */
  private async replay(input: Omit<ReplaySession, 'allowed' | 'book' | 'seen' | 'retracted'>): Promise<ReplayOutcome> {
    const { cursor, cutoff, experiences, prior } = input;
    // 允许引用整批序号（旧记忆可能引用早期流水），但模型只看得到 lived 那部分。
    const allowed = new Set([...experiences.map(e => e.seq), ...prior.flatMap(m => m.evidence)]);
    const book = new Map<string, Workbook>(prior.map(m => [m.id, { ...m, evidence: [...m.evidence], status: 'active', origin: 'prior' }]));
    const session: ReplaySession = { ...input, allowed, book, seen: new Set(), retracted: new Set() };
    const outcome: ReplayOutcome = { rounds: 0, converged: false, summary: '', proposals: [], failedApproaches: [], opportunities: [], ops: [], promotions: [] };
    for (let round = 1; round <= this.policy.maxRounds; round++) {
      outcome.rounds = round;
      const raw = await this.roundOf(session, round);
      if (!this.applyRound(session, raw, round, outcome)) break;
    }
    outcome.ops = this.diff(session);
    outcome.opportunities = this.opportunities(session, outcome.opportunities);
    const kept = [...session.book.values()].filter(m => m.status === 'active').length;
    outcome.summary = kept ? `回放 ${outcome.rounds} 遍，记住 ${kept} 件事` : '这段时间没有值得记下的事';
    return outcome;
  }

  /** 跑一次回放：同一个批次、同一个 workspace，第 2 遍起附带回放说明。 */
  private roundOf(session: ReplaySession, round: number): Promise<DreamRound> {
    const { cursor, cutoff, experiences } = session;
    const replaying = round > 1;
    const workspace = [...session.book.values()].filter(m => m.status === 'active').map(m => snapshotOf(m));
    return this.model.decide({
      role: 'dream',
      schema: DreamRoundSchema,
      context: {
        // 每一遍都是同一批经验，按时间顺序排列；回合对模型只读。
        fromExclusive: cursor, throughInclusive: cutoff, experiences, workspace,
        previousAttemptError: session.error,
        ...(replaying ? { replay: loopOf(round, { fromExclusive: cursor, throughInclusive: cutoff, live: experiences.map(e => e.seq) }, workspace) } : {}),
      },
      instructions: replaying ? `${DREAM_INSTRUCTIONS}\n\n${DREAM_REPLAY_NOTES}` : DREAM_INSTRUCTIONS,
      // 超时与输出预算由 dream 档位统一给；只在回放遍上改思考档位与温度。
      sampling: this.policy.sampling[Math.min(round - 1, this.policy.sampling.length - 1)],
    }).then(raw => DreamRoundSchema.parse(raw));
  }

  /** 应用一遍的修订；返回 false 表示到此收敛，不再回放。 */
  private applyRound(session: ReplaySession, raw: DreamRound, round: number, outcome: ReplayOutcome): boolean {
    if (raw.note) this.experience.record('dream', 'dream.round.note', { round, note: raw.note }, Date.now());
    if (round > 1 && judge.quiet(raw)) { outcome.converged = true; return false; }
    this.write(session, raw, round === 1);
    this.applyEdits(session, raw);
    this.collect(raw, outcome);
    // 第 1 遍一条有效的记忆都没有：没有可回放的内容，不必再花钱看一遍。
    if (round === 1 && ![...session.book.values()].some(m => m.status === 'active')) { outcome.converged = true; return false; }
    return true;
  }

  /** 收下这一遍给出的建议与机会：后一遍的说法覆盖前一遍，机会与提升按 id 合并。 */
  private collect(raw: DreamRound, outcome: ReplayOutcome): void {
    if (raw.proposals?.length) outcome.proposals = [...raw.proposals];
    if (raw.failedApproaches?.length) outcome.failedApproaches = [...raw.failedApproaches];
    // 索引是「最后一遍为准」：后面的回放看到的内容更全，前面那版自然被取代。
    if (raw.index !== undefined) outcome.index = raw.index;
    if (raw.promotions?.length) {
      // 多遍取并集：同一 id 以后一遍的理由为准（它看到了更多上下文）。
      outcome.promotions = mergeById(outcome.promotions, raw.promotions.map(item => ({ id: item.id, why: item.why })));
    }
    if (raw.opportunities?.length) outcome.opportunities = mergeById(outcome.opportunities, raw.opportunities);
  }

  /** 本遍新写的记忆放进工作副本；第 2 遍起不允许换个名字重写已有的记忆。 */
  private write(session: ReplaySession, raw: DreamRound, first: boolean): void {
    for (const memory of raw.memories ?? []) {
      if (session.seen.has(memory.id)) {
        throw new Error(first ? 'Duplicate memory in Dream' : 'Replay pass tried to rewrite an existing memory; use revisions');
      }
      session.seen.add(memory.id);
      checkMemory(memory, session.allowed);
      guardScope(memory.id, { revisions: session.revisions, stored: id => this.repository.get(id) });
      // 写下之后这条就属于 workspace 了，后面的回放只能通过 revisions 改它。
      this.publishedThisDream.add(memory.id);
      session.book.set(memory.id, { ...memory, evidence: [...memory.evidence], status: 'active', origin: 'round' });
    }
  }

  /** 修订、合并、撤回。撤回优先于修订；被合并的条不再单独写回。 */
  private applyEdits(session: ReplaySession, raw: DreamRound): void {
    session.retracted = new Set((raw.retractions ?? []).map(drop => drop.id));
    for (const edit of raw.revisions ?? []) {
      const memory = session.book.get(edit.id);
      if (!memory) throw new Error('Replay revised a memory it was not shown');
      guardScope(edit.id, { revisions: session.revisions, stored: id => this.repository.get(id) });
      if (edit.mergeInto) this.merge(session, memory, edit.mergeInto);
      else this.revise(session, memory, edit);
    }
    // 撤回优先于修订：同一遍里两者同时出现时，被改过的条也会在这里被标成撤回。
    for (const drop of raw.retractions ?? []) {
      const memory = session.book.get(drop.id);
      if (!memory) throw new Error('Replay retracted a memory it was not shown');
      memory.status = 'retracted';
    }
  }

  /** 合并只搬证据：内容以被并入的那条为准。 */
  private merge(session: ReplaySession, memory: Workbook, intoId: string): void {
    const into = session.book.get(intoId);
    if (!into || into === memory) throw new Error('Replay mergeInto must point at another shown memory');
    into.evidence = [...new Set([...into.evidence, ...memory.evidence])];
    memory.status = 'merged'; memory.mergedInto = into.id;
    checkMemory(into, session.allowed);
  }

  /**
   * 修订一条已有记忆：改内容、改类别、补证据。
   * 补证据只做并集——回放给出更窄的证据不能把已有证据抹掉；
   * 改完仍要过证据门槛，所以把一条观察改成推论时得同时补上第二条证据。
   */
  private revise(session: ReplaySession, memory: Workbook, edit: DreamRoundRevision): void {
    if (memory.status !== 'active') return;
    if (edit.content !== undefined) memory.content = edit.content;
    if (edit.kind !== undefined) memory.kind = edit.kind;
    if (edit.evidence !== undefined) memory.evidence = [...new Set([...memory.evidence, ...edit.evidence])];
    checkMemory(memory, session.allowed);
    // 同一遍里修订与撤回同时出现时以撤回为准。
    if (session.retracted.has(memory.id)) memory.status = 'retracted';
  }

  /** 提交按最终工作副本与库里的差异生成：哪一遍改的都不重要，重要的是最后它长什么样。 */
  private diff(session: ReplaySession): DreamOp[] {
    const ops: DreamOp[] = [];
    for (const memory of session.book.values()) {
      const current = this.repository.get(memory.id);
      if (memory.status === 'retracted') { if (current) ops.push({ kind: 'retract', id: memory.id }); continue; }
      if (memory.status === 'merged') { if (current) ops.push({ kind: 'merge', id: memory.id, into: memory.mergedInto! }); continue; }
      const next = snapshotOf(memory);
      if (current && judge.same(current, next)) continue;
      ops.push({ kind: 'write', memory: next });
    }
    return ops;
  }

  /** 机会过筛子再给 self；不开机会时照收不投递，被挡的原因记进经验日志便于事后看 Dream 为什么总在瞎提。 */
  private opportunities(session: ReplaySession, candidates: Opportunity[]): Opportunity[] {
    if (!candidates.length || !this.collectOpportunities) return [];
    const screened = screenOpportunities({ candidates, evidence: session.allowed, material: session.experiences,
      recentVersions: this.repository.recentDreams?.(5) });
    if (screened.rejected.length) this.experience.record('dream', 'dream.opportunity.rejected', { rejected: screened.rejected }, Date.now());
    return screened.accepted;
  }

  private commit(result: DreamResult): void {
    const { id, cursor, cutoff, revisions, ops, now } = result;
    if (this.repository.cursor() !== cursor) throw new Error('Dream cursor conflict');
    for (const op of ops) {
      if (op.kind === 'write') this.publish(op.memory, revisions);
      // 撤回/合并在库里只留一个最小痕迹：不删历史（source 链要保持可回溯），标记状态。
      else this.retire(op.id, 'superseded', revisions);
    }
    // 副作用交给独立模块：回放决定「记什么」，这里决定「怎么组织」，后者失败不影响前者。
    const effects = { repository: this.repository, experience: this.experience };
    promoteMemories(effects, result.promotions, now);
    writeMemoryIndex(effects, result.index, now);
    const version: DreamVersion = {
      id, cursor, cutoff, status: 'published', at: now, rounds: result.rounds, converged: result.converged,
      candidate: {
        proposals: [...result.proposals], failedApproaches: [...result.failedApproaches],
        memories: ops.flatMap(op => op.kind === 'write' ? [{ ...op.memory }] : []),
        opportunities: [...result.opportunities],
      },
      opportunities: [...result.opportunities],
    };
    this.repository.publishDream(version);
    this.experience.record('dream', 'dream.completed', this.metrics(cursor, cutoff, ops), now);
    if (result.notify) this.feedback.completed({ id, summary: result.summary, proposals: result.proposals, now, opportunities: result.opportunities });
  }

  /** 记录整合本身的体积变化与回放成本，供事后分析「压缩比」「回放值不值」。 */
  private metrics(cursor: number, cutoff: number, ops: DreamOp[]) {
    const byKind: Record<string, number> = {};
    let chars = 0;
    for (const op of ops) {
      if (op.kind !== 'write') continue;
      byKind[op.memory.kind] = (byKind[op.memory.kind] ?? 0) + 1;
      chars += op.memory.content.length;
    }
    return {
      batch: cutoff - cursor, memories: ops.filter(o => o.kind === 'write').length, chars, byKind,
      retracted: ops.filter(o => o.kind === 'retract').length, merged: ops.filter(o => o.kind === 'merge').length,
    };
  }

  private publish(memory: DreamMemory, revisions: Map<string, number>): void {
    const old = this.repository.get(memory.id);
    if ((old?.revision ?? 0) !== (revisions.get(memory.id) ?? 0)) throw new Error('Memory version conflict');
    this.repository.publish({ ...memory, revision: (old?.revision ?? 0) + 1 });
  }

  /** 撤回与合并：不删记录，只改状态到 superseded 并递增 revision，让读取侧按状态过滤。 */
  private retire(id: string, status: Memory['status'], revisions: Map<string, number>): void {
    const old = this.repository.get(id);
    if (!old) return;
    if (old.revision !== (revisions.get(id) ?? 0)) throw new Error('Memory version conflict');
    this.repository.publish({ ...old, status, revision: old.revision + 1 });
  }
}

type ReplaySession = {
  cursor: number; cutoff: number; experiences: ReturnType<typeof lived>; prior: Memory[];
  error: string | undefined; revisions: Map<string, number>;
  allowed: Set<number>; book: Map<string, Workbook>; seen: Set<string>;
  /** 正在应用的那一遍里被撤回的 id：同一遍里修订与撤回同时出现时按撤回处理。 */
  retracted: Set<string>;
};

type ReplayOutcome = {
  rounds: number; converged: boolean; summary: string;
  proposals: string[]; failedApproaches: string[]; opportunities: Opportunity[]; ops: DreamOp[];
  /** 模型判断「这条不该只在这个场合成立」；由 commit 复制到 owner 层。 */
  promotions: DreamPromotion[];
  /** 模型给出的记忆索引；最后一遍为准（它看到的内容最全）。 */
  index?: IndexEntry[];
};

/** 按 id 合并两批：后来的覆盖前面的，顺序按首次出现。 */
function mergeById<T extends { id: string }>(prior: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(prior.map(item => [item.id, item]));
  for (const item of next) merged.set(item.id, item);
  return [...merged.values()];
}

type DreamRoundRevision = NonNullable<DreamRound['revisions']>[number];

type DreamOp =
  | { kind: 'write'; memory: DreamMemory }
  | { kind: 'retract'; id: string }
  | { kind: 'merge'; id: string; into: string };
