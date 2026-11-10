import type { MemoryIndex } from './index-layer.js';
import type { DreamVersion, Experience, Memory, MemoryContext, MemoryProposal,
  MemoryWriteOutcome, Opportunity, RecallRequest, Reflection } from './types.js';
export interface ExperienceRepository {
  append(source: string, kind: string, data: unknown, now: number): number;
  read(after: number, limit: number, source?: string): Experience[];
  recent(source: string, limit: number): Experience[];
  exists(seq: number): boolean;
  countAfter(source: string, after: number): number;
}
export interface MemoryRepository {
  get(id: string): Memory | undefined;
  search(query: string, limit: number): Memory[];
  recent(limit: number): Memory[];
  count(): number;
  publish(memory: Memory): void;
  cursor(): number;
  publishDream(version: DreamVersion): void;
  /** 可选：最近几次整合版本，用来跨批次去重机会。老实现不提供时不跨批次去重。 */
  recentDreams?(limit: number): DreamVersion[];
  /** 可选：硬过滤后的候选池。老实现不提供时，服务退回 search + recent。 */
  candidates?(request: RecallRequest): Memory[];
  /** 可选：被注入过的记录记一次访问，供排序的 access 信号使用。 */
  reinforce?(ids: string[], now: number): void;
  /** 可选：按事实主体取（走 subject_user_id 索引）。老实现不提供时由服务层退回候选池筛。 */
  factsAbout?(userId: string, scope: string, limit: number): Memory[];
  /** 可选：某个作用域的索引；不传 scope 取 owner。老实现不提供则不启用索引层。 */
  index?(scope?: string): MemoryIndex | undefined;
  publishIndex?(index: MemoryIndex): void;
}
export interface ReflectionRepository { save(reflection: Reflection): void; get(id: string): Reflection | undefined }
/**
 * 上下文层看得到的读接口。
 * C1 `preheat` 在决策之前读，C2 `related` 在决策之后按需读；两者都是本地代码，
 * 不新增 LLM 调用。旧的最小实现只需提供 recall。
 */
export interface MemoryView {
  /** scope 不传时用服务默认（owner）；传 `group:xxx` 时能读到 owner + 这个群。 */
  recall(query: string, limit: number, scope?: string, options?: { includeArchived?: boolean }): Memory[];
  context?(request: RecallRequest): MemoryContext;
  preheat?(request: RecallRequest): MemoryContext;
  related?(request: RecallRequest): MemoryContext;
  /** 提炼写入去重/加固/替代；没有写权限的调用方拿不到这个方法。 */
  observe?(proposal: MemoryProposal, now: number): MemoryWriteOutcome;
  /** 把一条只在某个场合成立的记忆提到通用层；判断由模型做，这里只执行与结构拦截。 */
  promote?(id: string, why: string, now: number): { ok: boolean; reason?: string };
  /** 记忆索引（Claude 式 MEMORY.md）：注入时先看它，细节再按需展开。 */
  index?(scope?: string): MemoryIndex | undefined;
  /** 渲染好的索引文本（owner + 指定场景）；上下文直接用它。 */
  indexText?(scope?: string): string;
  /** 按 id 取全文，供 memory.expand 展开索引条目。 */
  expand?(ids: readonly string[]): Memory[];
  /**
   * 按 QQ 号取「关于这个人的事实」。
   * 走 subject_user_id 索引，不靠检索排序碰运气——用户认人靠号，不靠名字。
   */
  factsAbout?(userId: string, scope: string, limit: number): Memory[];
}
export interface ExperienceView {
  read(after: number, limit: number, source?: string): Experience[];
  recent(source: string, limit: number): Experience[];
  assertExists(refs: number[]): void;
}
export interface ExperienceLog extends ExperienceView { record(source: string, kind: string, data: unknown, now: number): number }
/**
 * 整合完成时通知 self。机会（想做但还没做的事）是素材，不是命令：
 * self 看到之后自己决定现在做、等一等还是不做。
 */
export interface DreamReport {
  id: string; summary: string; proposals: string[]; now: number; opportunities: Opportunity[];
}
export interface DreamFeedback { completed(report: DreamReport): void }
/** 门控自己的状态：上次整合、上次扫描、当天次数、各门控拦截次数。 */
export interface DreamState {
  lastAt: number; lastScanAt: number; runsToday: number; runDay: number; blocked: Record<string, number>;
}
export interface DreamStateRepository { read(): DreamState; write(state: DreamState): void }
/** 跨进程互斥；实现放在基础设施层，核心模块只依赖这个契约。 */
export interface DreamLock { acquire(): boolean; release(): void; held(): boolean }
