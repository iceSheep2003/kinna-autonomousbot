import type { QqState } from '../../integrations/qq/ports.js';
import type { MediaRef, PlatformOperation, QqEvent, Target, TitleProposal } from '../../integrations/qq/types.js';
import type { Store } from './database.js';
export class SqliteQqState implements QqState {
  constructor(private readonly db: Store) {
    db.db.exec("CREATE INDEX IF NOT EXISTS qq_pending_events ON documents(COALESCE(json_extract(body,'$.published'),0),json_extract(body,'$.receivedAt')) WHERE collection='qq.events'");
  }
  event(id: string) { return this.db.get<QqEvent>('qq.events', id); }
  saveEvent(event: QqEvent) { this.db.put('qq.events', event.id, event); }
  pendingEvents(limit: number) { return this.db.query<QqEvent>('qq.events', "COALESCE(json_extract(body,'$.published'),0)=0 ORDER BY json_extract(body,'$.receivedAt')", [], limit); }
  media(id: string) { return this.db.get<MediaRef>('qq.media', id); }
  saveMedia(media: MediaRef) { this.db.put('qq.media', media.id, media); }
  /** 图片识别结果：同一张图只分析一次。 */
  imageSummary(id: string) { return this.db.get<string>('qq.image.summary', id); }
  saveImageSummary(id: string, summary: string) { this.db.put('qq.image.summary', id, summary.slice(0, 500)); }
  /** 每个标签记最近 6 张：够避免短期重复，又不至于把整个 tag 排除光。 */
  recentMemes(tag: string) { return this.db.get<string[]>('qq.meme.recent', tag) ?? []; }
  rememberMeme(tag: string, id: string) {
    const next = [id, ...(this.recentMemes(tag) ?? []).filter(item => item !== id)].slice(0, 6);
    this.db.put('qq.meme.recent', tag, next);
  }
  knownMessage(id: string) { return this.db.get<{ target: Target }>('qq.messages', id); }
  rememberMessage(id: string, target: Target) { this.db.put('qq.messages', id, { target }); }
  proposal(groupId: string) { return this.db.get<TitleProposal>('qq.proposals', groupId); }
  saveProposal(proposal: TitleProposal) { this.db.put('qq.proposals', proposal.groupId, proposal); }
  operation(id: string) { return this.db.get<PlatformOperation>('qq.operations', id); }
  saveOperation(operation: PlatformOperation) { this.db.put('qq.operations', operation.id, operation); }
}
