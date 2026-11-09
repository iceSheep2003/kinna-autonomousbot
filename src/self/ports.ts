import type { SelfDecision } from './decision.js';
import type { Experience } from '../memory/types.js';
export interface SelfSessionRepository {
  cursor(): number; advanceCursor(seq: number): void;
  append(turn: { at: number; context: unknown; decision: SelfDecision }): void;
  recentDecisions(limit: number): unknown[];
}
export interface SelfCommitter { apply(decision: SelfDecision, expectedRevision: number, evidence: number[], now: number): void }
export interface SelfInbox {
  read(after: number, limit: number): Experience[];
  continueIfUnread(after: number, now: number): void;
}
