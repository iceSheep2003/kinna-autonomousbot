import type { MediaRef, PlatformOperation, QqEvent, TitleProposal } from './types.js';
export interface OneBotPort {
  start(handler: (event: Record<string, unknown>) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
/** QQ 只拥有平台事件、媒体引用、投票和实际发送记录，无权读取主体仓库。 */
export interface QqState {
  event(id: string): QqEvent | undefined; saveEvent(event: QqEvent): void;
  pendingEvents(limit: number): QqEvent[];
  media(id: string): MediaRef | undefined; saveMedia(media: MediaRef): void;
  knownMessage(id: string): { target: { type: 'group' | 'private'; id: string } } | undefined;
  rememberMessage(id: string, target: { type: 'group' | 'private'; id: string }): void;
  proposal(groupId: string): TitleProposal | undefined; saveProposal(proposal: TitleProposal): void;
  operation(id: string): PlatformOperation | undefined; saveOperation(operation: PlatformOperation): void;
}
export interface MediaBytes { bytes: Uint8Array; mimeType: string }
export interface QqMediaSource { acquire(ref: MediaRef, signal: AbortSignal): Promise<MediaBytes> }
export interface QqPerception { inspect(media: MediaBytes, question: string, signal: AbortSignal): Promise<string> }
export interface QqSpeech { synthesize(text: string, style: string, signal: AbortSignal): Promise<string> }
export interface QqMemeSource { tags(): string[]; pick(tag: string): Promise<string> }
export interface QqChannelPort { request(method: string, path: string, body?: unknown, signal?: AbortSignal, query?: Record<string, string>): Promise<unknown> }
export class OneBotError extends Error {}
export class OneBotNotConnected extends OneBotError {}
export class OneBotUncertain extends OneBotError {}
export class OneBotActionError extends OneBotError {}
