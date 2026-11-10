import { readFileSync } from 'node:fs';
import { Store } from './dist/src/infrastructure/sqlite/database.js';
import { SqliteMemoryRepository } from './dist/src/infrastructure/sqlite/memory.js';
import { MemoryService } from './dist/src/memory/service.js';

const raw = JSON.parse(readFileSync('./test/fixtures/memories.json', 'utf8'));
const store = new Store(':memory:');
const repo = new SqliteMemoryRepository(store);
const NOW = 1794288000000;
const KIND = { preference: 'strategy', boundary: 'strategy', fact: 'observation', event: 'observation', open_loop: 'inference', promise: 'inference', relation: 'observation' };
for (const row of raw) {
  repo.publish({
    id: `real-${row.id}`, content: String(row.content).slice(0, 300), evidence: [1],
    kind: KIND[row.fact_type] ?? 'observation', revision: 1,
    scope: row.scope, subjectUserId: row.user_id ?? undefined,
    factType: row.fact_type, importance: row.importance, confidence: row.confidence,
    status: row.status === 'active' ? 'active' : 'candidate',
    visibility: row.visibility, originUserId: row.origin_user_id ?? undefined,
    createdAt: row.created_at * 1000, updatedAt: row.created_at * 1000,
  });
}
const service = new MemoryService(repo, { clock: () => NOW });
console.log('导入真实记忆:', store.list('memories', 400).length, '条');
for (const scope of ['group:330707267', 'group:866795853', 'owner']) {
  const ctx = service.context({ query: '考研 复习 计划 学习', limit: 12, now: NOW, scope });
  const all = [...ctx.general, ...ctx.scoped];
  const leaked = all.filter(i => { const m = repo.get(i.id); return m && !['owner', scope].includes(m.scope ?? 'owner'); });
  console.log(`\n=== 从 ${scope} 看`);
  console.log('  取到', all.length, '条 | 通用层', ctx.general.length, '| 场景层', ctx.scoped.length);
  console.log('  越界泄漏:', leaked.length === 0 ? '无 ✓' : leaked.map(i => i.id).join(','));
  console.log('  样例:', all.slice(0, 3).map(i => i.fact.slice(0, 24)).join(' | '));
}
store.close();
