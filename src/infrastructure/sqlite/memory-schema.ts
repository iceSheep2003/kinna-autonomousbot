import type { DatabaseSync } from 'node:sqlite';

/**
 * 记忆的关系表。
 *
 * 原来记忆躺在 `documents(collection,id,body)` 里，字段全在 JSON 中——
 * `scope` / `status` / `last_accessed_at` 这些**每次检索都要判断的条件建不了索引**。
 *
 * 改成关系表换来的不是性能（真实一年才四千条，全表扫也只要几毫秒），
 * 而是三件结构性的事：
 * - 过滤条件走索引，而不是在 JSON 上做 `instr`
 * - 能直接 `sqlite3` 查、能写 SQL 统计，而不是看转义后的 JSON
 * - `NOT NULL` 与类型由 schema 兜底，脏数据进不来
 *
 * 为什么不给每个集合都建表：`goals` / `scenes` / `schedules` 只有几十条、
 * 永远按 id 取整条，建表只会多出一堆没人查的列。分而治之，见 docs/memory-storage.md。
 */
export const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'owner',
    subject_user_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'group',
    origin_user_id TEXT,
    kind TEXT NOT NULL DEFAULT 'observation',
    fact_type TEXT,
    mention_policy TEXT,
    persona_summary TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    importance INTEGER NOT NULL DEFAULT 1,
    confidence REAL NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    merged_into TEXT,
    source_event_id TEXT,
    expires_at INTEGER,
    last_accessed_at INTEGER,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]'
  );
  -- 三列一起建：候选池的过滤条件（scope/status）和排序（updated_at）都能用它，
  -- 否则 SQLite 会用临时 B 树排序（EXPLAIN QUERY PLAN 里能看到 USE TEMP B-TREE）。
  CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS memories_subject ON memories(subject_user_id, status);
  CREATE INDEX IF NOT EXISTS memories_stale ON memories(status, last_accessed_at);
  CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at DESC);
  CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY(memory_id, seq)
  );
  CREATE INDEX IF NOT EXISTS memory_evidence_seq ON memory_evidence(seq);
`;

export function ensureMemorySchema(db: DatabaseSync): void {
  db.exec(MEMORY_SCHEMA);
}
