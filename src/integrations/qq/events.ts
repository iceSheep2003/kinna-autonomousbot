import { createHash } from 'node:crypto';
import { qqBudget } from './budget.js';
import type { QqState } from './ports.js';
import type { MediaRef, QqConfig, QqEvent, Segment, Target } from './types.js';

const TEXT_BUDGET = 6000;
const MEDIA_TYPES = new Set(['image', 'record', 'video', 'mface', 'marketface']);
/**
 * 结构化片段在文本里的占位。
 *
 * 这些类型没有文件可下载，但有语义：合并转发、卡片、骰子……
 * 全部丢掉的话消息会变成空字符串，模型只会觉得「他发了个空消息」。
 */
const STRUCTURED: Record<string, string> = {
  forward: '[合并转发]', json: '[卡片消息]', xml: '[卡片消息]', music: '[音乐分享]',
  location: '[位置]', contact: '[名片]', shake: '[窗口抖动]', dice: '[骰子]',
  rps: '[猜拳]', touch: '[双击头像]', markdown: '[富文本]',
};

/** 媒体在文本里的占位：不占位的话「发来一张图」在 text 上完全看不出来。 */
const MEDIA_LABEL: Record<string, string> = { image: '[图片]', record: '[语音]', video: '[视频]', mface: '[表情包]', marketface: '[表情包]' };
const MESSAGE_TYPES = new Set(['group', 'private']);
const POST_TYPES = new Set(['message', 'notice', 'request']);

export function segments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).filter((p): p is Segment => !!p && typeof p === 'object' && typeof p.type === 'string' && !!p.data && typeof p.data === 'object');
}
export function allowedTarget(config: QqConfig, target: Target): void {
  if (target.type === 'group' ? !config.allowedGroups.includes(target.id) : !config.privateEnabled || !config.allowedPrivateUsers.includes(target.id)) throw new Error('QQ target is not allowlisted');
}

/** 事件信封：先把“是谁、在哪个会话、什么事件”定下来，再解析消息片段。 */
interface Envelope { target: Target; groupId?: string; userId: string; messageId?: string; id: string; kind: string }
interface PartSink { event: QqEvent; media: MediaRef[]; target: Target; id: string; budget: { text: number } }

export function parseQqEvent(raw: Record<string, unknown>, config: QqConfig, now: number): { event: QqEvent; media: MediaRef[] } | undefined {
  const envelope = readEnvelope(raw, config);
  if (!envelope) return;
  const event = baseEvent(raw, config, envelope, now);
  const media: MediaRef[] = [];
  fillParts(raw, { event, media, target: envelope.target, id: envelope.id, budget: { text: TEXT_BUDGET } });
  event.text = event.text.slice(0, TEXT_BUDGET);
  event.atBot = event.atUsers.includes(config.selfId);
  return { event, media };
}

function readEnvelope(raw: Record<string, unknown>, config: QqConfig): Envelope | undefined {
  if (String(raw.self_id ?? '') !== config.selfId || raw.post_type === 'meta_event') return;
  const target = readTarget(raw, config);
  if (!target) return;
  const identity = readMessageId(raw);
  if (!identity.ok) return;
  return { ...target, messageId: identity.messageId, id: readEventId(raw, config, target, identity.messageId), kind: readKind(raw) };
}

/** 只接受白名单会话里、由他人发起的真实事件。 */
function readTarget(raw: Record<string, unknown>, config: QqConfig): { target: Target; groupId?: string; userId: string } | undefined {
  const groupId = raw.group_id !== undefined ? String(raw.group_id) : undefined;
  const userId = String(raw.user_id ?? '');
  if (!/^\d+$/.test(userId) || userId === config.selfId) return;
  const target: Target = groupId ? { type: 'group', id: groupId } : { type: 'private', id: userId };
  try { allowedTarget(config, target); } catch { return; }
  return { target, groupId, userId };
}

function readMessageId(raw: Record<string, unknown>): { ok: boolean; messageId?: string } {
  const postType = String(raw.post_type);
  if (!POST_TYPES.has(postType)) return { ok: false };
  if (postType !== 'message') return { ok: true };
  if (!MESSAGE_TYPES.has(String(raw.message_type)) || raw.sub_type === 'self') return { ok: false };
  const messageId = raw.message_id === undefined ? '' : String(raw.message_id);
  return /^-?\d+$/.test(messageId) ? { ok: true, messageId } : { ok: false };
}

function readKind(raw: Record<string, unknown>): string {
  if (raw.post_type === 'message') return 'qq.message';
  if (raw.notice_type === 'notify' && raw.sub_type === 'poke') return 'qq.poke';
  return `qq.${String(raw.notice_type ?? raw.request_type ?? 'event')}`;
}

/** 消息用平台 message_id 做稳定 ID；其余事件按字段指纹去重。 */
function readEventId(raw: Record<string, unknown>, config: QqConfig, target: { groupId?: string; userId: string }, messageId?: string): string {
  if (raw.post_type === 'message') return `qq:${config.selfId}:message:${messageId}`;
  const hash = createHash('sha256').update(JSON.stringify([raw.post_type, raw.notice_type, raw.request_type, raw.sub_type,
    target.groupId, target.userId, raw.target_id, raw.time, raw.flag, messageId])).digest('hex').slice(0, 32);
  return `qq:${config.selfId}:${hash}`;
}

function baseEvent(raw: Record<string, unknown>, config: QqConfig, envelope: Envelope, now: number): QqEvent {
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender as Record<string, unknown> : {};
  return { id: envelope.id, kind: envelope.kind, selfId: config.selfId, groupId: envelope.groupId, userId: envelope.userId,
    messageId: envelope.messageId, time: Number(raw.time ?? 0), receivedAt: now,
    nickname: String(sender.card || sender.nickname || envelope.userId).slice(0, 80),
    text: '', atBot: false, atUsers: [], parts: [],
    targetId: raw.target_id === undefined ? undefined : String(raw.target_id),
    flag: raw.flag === undefined ? undefined : String(raw.flag).slice(0, 2000),
    subType: String(raw.sub_type ?? ''), comment: String(raw.comment ?? '').slice(0, 2000) };
}

function fillParts(raw: Record<string, unknown>, sink: PartSink): void {
  const parts = Array.isArray(raw.message) ? segments(raw.message) : [{ type: 'text', data: { text: String(raw.raw_message ?? '') } }];
  parts.slice(0, qqBudget.partsPerMessage).forEach((part, index) => applyPart(part, index, sink));
}

function applyPart(part: Segment, index: number, sink: PartSink): void {
  if (part.type === 'text') return applyText(part, sink);
  if (part.type === 'at') return applyAt(part, sink);
  if (part.type === 'reply') return applyReply(part, sink);
  if (part.type === 'face') return applyFace(part, sink);
  if (MEDIA_TYPES.has(part.type)) return applyMedia(part, index, sink);
  // 认得的「非文字但也不是文件」类型：至少让模型知道发生了什么。
  // 静默丢掉的话，那条消息在文本里就是个空字符串——线上 21% 的消息
  // 退化成 `[非文字消息]` 就是这么来的。
  if (part.type in STRUCTURED) { sink.event.text += STRUCTURED[part.type]; sink.event.parts.push({ kind: 'structured', type: part.type }); return; }
  // 真不认识的也留个记号，而不是让它消失。带上类型名，排查时能知道是哪种。
  const label = `[消息类型:${part.type.slice(0, 20)}]`.slice(0, 40);
  sink.event.text += label;
  sink.event.parts.push({ kind: 'unknown', type: part.type.slice(0, 20) });
}

function applyText(part: Segment, sink: PartSink): void {
  const text = String(part.data.text ?? '').slice(0, sink.budget.text);
  sink.budget.text -= text.length;
  sink.event.text += text;
  if (text) sink.event.parts.push({ kind: 'text', text });
}

function applyAt(part: Segment, sink: PartSink): void {
  const targetId = String(part.data.qq ?? '');
  sink.event.atUsers.push(targetId);
  sink.event.parts.push({ kind: 'at', targetId });
}

function applyReply(part: Segment, sink: PartSink): void {
  sink.event.replyTo ??= String(part.data.id ?? '');
  sink.event.parts.push({ kind: 'quote', targetId: String(part.data.id ?? '') });
}

function applyFace(part: Segment, sink: PartSink): void {
  sink.event.parts.push({ kind: 'face', faceId: String(part.data.id ?? '') });
  sink.event.text += '[QQ表情]';
}

/** 媒体只保存引用；带签名的 URL 留在平台侧，不进记忆。 */
function applyMedia(part: Segment, index: number, sink: PartSink): void {
  if (sink.media.length >= qqBudget.mediaPerMessage) return;
  const resourceId = `${sink.id}:media:${index}`;
  const kind = part.type === 'record' ? 'audio' : part.type === 'video' ? 'video' : 'image';
  sink.media.push({ id: resourceId, kind, scope: sink.target, eventId: sink.id, file: String(part.data.file ?? '').slice(0, 2000), url: String(part.data.url ?? '').slice(0, 4000) });
  sink.event.parts.push({ kind, resourceId });
  // 文本里留一个占位符：否则「发来一张图」在 text 上完全看不出来，
  // 模型只会看到一条空消息，然后答非所问。
  sink.event.text += MEDIA_LABEL[part.type] ?? '[附件]';
  if (part.type === 'mface' || part.type === 'marketface') sink.event.text += `[表情包：${String(part.data.summary ?? '').slice(0, 40)}]`;
}

export function savePlatformEvent(state: QqState, event: QqEvent, media: MediaRef[]): void {
  state.saveEvent(event); for (const ref of media) state.saveMedia(ref);
  if (event.messageId) state.rememberMessage(event.messageId, event.groupId ? { type: 'group', id: event.groupId } : { type: 'private', id: event.userId });
}
