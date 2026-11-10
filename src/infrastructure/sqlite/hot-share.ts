import type { HotShareState } from '../../features/hot-share/state.js';
import { EMPTY_STATE } from '../../features/hot-share/state.js';
import type { Store } from './database.js';

/** 分享状态落在同一个库里：一份 JSON 文档，够用且不必建表。 */
export class SqliteHotShareStore {
  constructor(private readonly db: Store) {}
  read(): HotShareState { return this.db.get<HotShareState>('features.hot_share', 'state') ?? EMPTY_STATE; }
  save(state: HotShareState): void { this.db.put('features.hot_share', 'state', state); }
}
