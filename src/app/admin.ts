import type { IncomingEvent } from '../runtime/types.js';
export const adminCollections = ['goals', 'executions', 'scenes', 'schedules', 'memories', 'dreams', 'operations', 'reflections', 'affect'] as const;
export type AdminCollection = typeof adminCollections[number];
/** HTTP 只拿读模型和事件投递口，不拿仓库或领域写服务。 */
export interface AdminApi {
  self(): unknown;
  list(collection: AdminCollection, limit: number, offset: number): unknown[];
  experiences(after: number, limit: number, source?: string): unknown[];
  turns(id: string, limit: number): unknown[];
  jobs(): unknown[];
  capabilities(): unknown[];
  ingest(event: IncomingEvent): { duplicate: boolean };
}
