import type { DatabaseSync } from 'node:sqlite';
import type { Memory } from '../../memory/types.js';

/**
 * 记忆的「领域对象 ↔ 关系表行」映射，以及写入语句。
 *
 * 单独抽出来是因为有两处要用：正常写入（publish）和老数据迁移。
 * 迁移时如果复制一份 SQL，两边字段迟早会漂——迁移写漏一个字段，
 * 数据就静默丢了，而且只在迁移那一刻发生，事后很难发现。
 */

/** 列的顺序必须和 INSERT 的占位符一致；迁移也用这一份。 */
const COLUMNS = [
  'id', 'content', 'scope', 'subject_user_id', 'visibility', 'origin_user_id', 'kind', 'fact_type',
  'mention_policy', 'persona_summary', 'status', 'importance', 'confidence', 'revision', 'merged_into',
  'source_event_id', 'expires_at', 'last_accessed_at', 'access_count', 'created_at', 'updated_at', 'evidence',
] as const;

const UPSERT = `INSERT INTO memories (${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(column => column !== 'id').map(column => `${column}=excluded.${column}`).join(',')}`;

/** 领域对象 → 一行值。缺失的可选字段写 null，不让 undefined 进 SQL。 */
export function toRow(memory: Memory, now: number): unknown[] {
  const nullable = (value: string | number | undefined | null): string | number | null => value ?? null;
  return [
    memory.id, memory.content, memory.scope ?? 'owner', nullable(memory.subjectUserId), memory.visibility ?? 'group',
    nullable(memory.originUserId), memory.kind, nullable(memory.factType), nullable(memory.mentionPolicy),
    nullable(memory.personaSummary), memory.status ?? 'active', memory.importance ?? 1, memory.confidence ?? 1,
    memory.revision, nullable(memory.mergedInto), nullable(memory.sourceEventId), nullable(memory.expiresAt),
    nullable(memory.lastAccessedAt), memory.accessCount ?? 0, memory.createdAt ?? now, memory.updatedAt ?? now,
    JSON.stringify(memory.evidence),
  ];
}

/** 一行 → 领域对象。只补默认值，不做取舍：列名就是字段名。 */
export function fromRow(raw: unknown): Memory | undefined {
  if (raw === undefined) return undefined;
  const r = raw as Record<string, unknown>;
  const optional: Partial<Memory> = {};
  // 可选字段只在有值时出现：让「字段是否存在」的判断保持准确。
  const pairs: Array<[keyof Memory, unknown]> = [
    ['scope', r.scope], ['subjectUserId', r.subject_user_id], ['visibility', r.visibility],
    ['originUserId', r.origin_user_id], ['factType', r.fact_type], ['mentionPolicy', r.mention_policy],
    ['personaSummary', r.persona_summary], ['status', r.status], ['mergedInto', r.merged_into],
    ['sourceEventId', r.source_event_id], ['expiresAt', r.expires_at], ['lastAccessedAt', r.last_accessed_at],
  ];
  for (const [key, value] of pairs) {
    if (value === null || value === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (optional as any)[key] = typeof value === 'number' ? value : String(value);
  }
  return {
    id: String(r.id), content: String(r.content), evidence: JSON.parse(String(r.evidence ?? '[]')) as number[],
    kind: String(r.kind) as Memory['kind'], revision: Number(r.revision),
    importance: Number(r.importance), confidence: Number(r.confidence),
    accessCount: Number(r.access_count), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    ...optional,
  };
}

export function upsertMemory(db: DatabaseSync, memory: Memory, now = Date.now()): void {
  const values = toRow(memory, now) as Array<string | number | null>;
  db.prepare(UPSERT).run(...values);
}

/** 证据单独一张表：将来「哪些记忆引用了这条原话」可以按 seq 反查。 */
export function writeEvidence(db: DatabaseSync, memory: Memory): void {
  db.prepare('DELETE FROM memory_evidence WHERE memory_id=?').run(memory.id);
  const insert = db.prepare('INSERT OR IGNORE INTO memory_evidence(memory_id, seq) VALUES (?,?)');
  for (const seq of memory.evidence) insert.run(memory.id, seq);
}
