import type { DreamVersion, Experience, Memory, MemoryContext, MemoryProposal,
  MemoryWriteOutcome, RecallRequest, Reflection } from './types.js';
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
  /** 可选：硬过滤后的候选池。老实现不提供时，服务退回 search + recent。 */
  candidates?(request: RecallRequest): Memory[];
  /** 可选：被注入过的记录记一次访问，供排序的 access 信号使用。 */
  reinforce?(ids: string[], now: number): void;
}
export interface ReflectionRepository { save(reflection: Reflection): void; get(id: string): Reflection | undefined }
/**
 * 上下文层看得到的读接口。
 * C1 `preheat` 在决策之前读，C2 `related` 在决策之后按需读；两者都是本地代码，
 * 不新增 LLM 调用。旧的最小实现只需提供 recall。
 */
export interface MemoryView {
  recall(query: string, limit: number): Memory[];
  context?(request: RecallRequest): MemoryContext;
  preheat?(request: RecallRequest): MemoryContext;
  related?(request: RecallRequest): MemoryContext;
  /** 提炼写入去重/加固/替代；没有写权限的调用方拿不到这个方法。 */
  observe?(proposal: MemoryProposal, now: number): MemoryWriteOutcome;
}
export interface ExperienceView {
  read(after: number, limit: number, source?: string): Experience[];
  recent(source: string, limit: number): Experience[];
  assertExists(refs: number[]): void;
}
export interface ExperienceLog extends ExperienceView { record(source: string, kind: string, data: unknown, now: number): number }
export interface DreamFeedback { completed(id: string, summary: string, proposals: string[], now: number): void }
/** 门控自己的状态：上次整合、上次扫描、当天次数、各门控拦截次数。 */
export interface DreamState {
  lastAt: number; lastScanAt: number; runsToday: number; runDay: number; blocked: Record<string, number>;
}
export interface DreamStateRepository { read(): DreamState; write(state: DreamState): void }
/** 跨进程互斥；实现放在基础设施层，核心模块只依赖这个契约。 */
export interface DreamLock { acquire(): boolean; release(): void; held(): boolean }
