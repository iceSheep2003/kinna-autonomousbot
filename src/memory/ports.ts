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
