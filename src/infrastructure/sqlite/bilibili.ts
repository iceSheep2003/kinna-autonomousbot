import type { BilibiliState } from '../../integrations/bilibili/ports.js';
import type { Draft, PostQuota } from '../../integrations/bilibili/types.js';
import type { Store } from './database.js';

/** B 站账号自己的数据：草稿、额度账本、已发记录。主体与记忆仓库都在别的模块。 */
export class SqliteBilibiliState implements BilibiliState {
  constructor(private readonly db: Store) {
    db.db.exec("CREATE INDEX IF NOT EXISTS bilibili_pending_drafts ON documents(json_extract(body,'$.status'),json_extract(body,'$.createdAt')) WHERE collection='bilibili.drafts'");
  }
  draft(id: string) { return this.db.get<Draft>('bilibili.drafts', id); }
  saveDraft(draft: Draft) { this.db.put('bilibili.drafts', draft.id, draft); }
  /** now 参数留给「顺带清理过期草稿」的调用方；查询本身只按状态过滤。 */
  pendingDrafts(_now: number, limit: number) {
    return this.db.query<Draft>('bilibili.drafts', "json_extract(body,'$.status')='pending' ORDER BY json_extract(body,'$.createdAt')", [], limit);
  }
  quota(day: number) { return this.db.get<PostQuota>('bilibili.quota', String(day)) ?? { day, comments: 0, dynamics: 0 }; }
  saveQuota(quota: PostQuota) { this.db.put('bilibili.quota', String(quota.day), quota); }
  recentPosts(limit: number) {
    return this.db.query<Draft>('bilibili.drafts', "json_extract(body,'$.status')='approved' ORDER BY json_extract(body,'$.postedAt') DESC", [], limit);
  }
}
