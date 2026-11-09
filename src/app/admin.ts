import type { IncomingEvent } from '../runtime/types.js';
export const adminCollections = ['goals', 'executions', 'scenes', 'schedules', 'memories', 'dreams', 'operations', 'reflections', 'affect'] as const;
export type AdminCollection = typeof adminCollections[number];
/**
 * 公开动作的批准入口。模型永远拿不到这个端口，只有 owner 的 HTTP 请求能调用；
 * 它不返回 cookie，也不允许改草稿正文（改过就算新草稿）。
 */
export interface BilibiliApproval {
  list(): unknown[];
  approve(id: string): Promise<{ ok: boolean; reason?: string; postedId?: string }>;
  reject(id: string, note?: string): { ok: boolean; reason?: string };
}

/** HTTP 只拿读模型和事件投递口，不拿仓库或领域写服务。 */
export interface AdminApi {
  self(): unknown;
  list(collection: AdminCollection, limit: number, offset: number): unknown[];
  experiences(after: number, limit: number, source?: string): unknown[];
  turns(id: string, limit: number): unknown[];
  jobs(): unknown[];
  capabilities(): unknown[];
  ingest(event: IncomingEvent): { duplicate: boolean };
  /** 可选：没配置 B 站时不存在，相关路由返回 404。 */
  approvals?(): BilibiliApproval;
}
