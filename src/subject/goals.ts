import { GoalSchema, type Goal, type GoalChange, type GoalRevision } from './types.js';
import type { EvidenceReader, GoalRepository } from './ports.js';

export class GoalService {
  constructor(private readonly repository: GoalRepository, private readonly evidence: EvidenceReader) {}
  get(id: string) { return this.repository.get(id); }
  recall(query: string, limit: number) { return this.repository.relevant(query, limit); }
  requireActive(id?: string): Goal | undefined {
    if (!id) return;
    const goal = this.get(id);
    if (!goal || goal.status !== 'active') throw new Error(`Goal is not active: ${id}`);
    return goal;
  }
  revise(changes: GoalChange[], now: number): GoalRevision[] {
    const proposed = new Map<string, Goal>();
    for (const raw of changes) {
      const change = GoalSchema.parse(raw);
      if (proposed.has(change.id)) throw new Error(`Duplicate goal change: ${change.id}`);
      this.evidence.assertExists(change.evidence);
      proposed.set(change.id, { ...change, revision: (this.get(change.id)?.revision ?? 0) + 1, updatedAt: now });
    }
    // 在写入之前验证完整父链，覆盖同批新增目标之间的循环。
    for (const goal of proposed.values()) {
      const seen = new Set<string>([goal.id]); let parent = goal.parentId;
      while (parent) {
        if (seen.has(parent)) throw new Error('Goal parent cycle');
        seen.add(parent);
        const ancestor = proposed.get(parent) ?? this.get(parent);
        if (!ancestor) throw new Error(`Unknown parent goal: ${parent}`);
        parent = ancestor.parentId;
      }
    }
    const revisions = [...proposed.values()].map(next => ({ previous: this.get(next.id), next }));
    for (const revision of revisions) { this.repository.save(revision.next); this.repository.recordRevision(revision, now); }
    return revisions;
  }
}
