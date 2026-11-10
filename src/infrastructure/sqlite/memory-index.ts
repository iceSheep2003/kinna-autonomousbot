import type { MemoryIndex } from '../../memory/index-layer.js';
import type { Store } from './database.js';

/** 每个 scope 一份索引，存在同一个集合里，按 scope 当 id。 */
export const INDEX_COLLECTION = 'memory.index';

export function readIndex(db: Store, scope: string): MemoryIndex | undefined {
  return db.get<MemoryIndex>(INDEX_COLLECTION, scope);
}

/** 读出所有已生成的索引，供上下文按需取用。 */
export function readIndexes(db: Store): MemoryIndex[] {
  return db.list<MemoryIndex>(INDEX_COLLECTION, 50);
}

export function writeIndex(db: Store, index: MemoryIndex): void {
  db.put(INDEX_COLLECTION, index.scope, index);
}
