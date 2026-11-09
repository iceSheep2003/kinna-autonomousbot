import type { DreamVersion, Experience, Memory, Reflection } from './types.js';
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
}
export interface ReflectionRepository { save(reflection: Reflection): void; get(id: string): Reflection | undefined }
export interface MemoryView { recall(query: string, limit: number): Memory[] }
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
