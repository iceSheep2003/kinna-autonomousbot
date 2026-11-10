import type { MemoryIndex } from '../../memory/index-layer.js';
import type { Store } from './database.js';

/** 索引只有一份，存在 meta 集合里；不需要按 id 查。 */
export const INDEX_COLLECTION = 'memory.index';

export function readIndex(db: Store): MemoryIndex | undefined {
  return db.get<MemoryIndex>(INDEX_COLLECTION, 'current');
}

export function writeIndex(db: Store, index: MemoryIndex): void {
  db.put(INDEX_COLLECTION, 'current', index);
}
