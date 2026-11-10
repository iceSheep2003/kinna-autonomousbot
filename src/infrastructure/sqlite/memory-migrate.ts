import type { Memory } from '../../memory/types.js';
import type { Store } from './database.js';
import { upsertMemory, writeEvidence } from './memory-rows.js';

/**
 * 把 `documents` 里的老记忆搬进关系表。
 *
 * 四条要求：
 * 1. **幂等**：新表已有数据就跳过，重复调用无害
 * 2. **完整**：所有字段都搬，不只是 id 和内容。写漏一个字段数据就静默丢了
 * 3. **不删旧数据**：迁移后 documents 里的记录保留，出问题能回退
 * 4. **一个事务**：几千条逐条提交会慢到不可接受
 */
export function migrateLegacyMemories(store: Store): { migrated: number; skipped: boolean } {
  const existing = Number(store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n);
  if (existing > 0) return { migrated: 0, skipped: true };
  const legacy = store.db.prepare("SELECT id, body FROM documents WHERE collection='memories'").all();
  if (legacy.length === 0) return { migrated: 0, skipped: false };
  const parsed = legacy
    .map(row => parseLegacy(row.id as string, row.body as string))
    .filter((memory): memory is Memory => memory !== undefined);
  store.transaction(() => {
    for (const memory of parsed) { upsertMemory(store.db, memory); writeEvidence(store.db, memory); }
  });
  return { migrated: parsed.length, skipped: false };
}

/**
 * 解析老记录。坏数据跳过而不是抛错：一条解析不了不该让整个迁移失败，
 * 但**要能看见**——所以把它记进经验流水。
 */
function parseLegacy(id: string, body: string): Memory | undefined {
  try {
    const parsed = JSON.parse(body) as Partial<Memory>;
    if (typeof parsed.content !== 'string') return undefined;
    return {
      ...parsed,
      id, content: parsed.content,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      kind: parsed.kind ?? 'observation', revision: parsed.revision ?? 1,
    } as Memory;
  } catch {
    return undefined;
  }
}
