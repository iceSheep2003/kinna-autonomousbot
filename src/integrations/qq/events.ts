import { createHash } from 'node:crypto';
import type { QqState } from './ports.js';
import type { MediaRef, QqConfig, QqEvent, Segment, Target } from './types.js';
export function segments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).filter((p): p is Segment => !!p && typeof p === 'object' && typeof p.type === 'string' && !!p.data && typeof p.data === 'object');
}
export function allowedTarget(config: QqConfig, target: Target): void {
  if (target.type === 'group' ? !config.allowedGroups.includes(target.id) : !config.privateEnabled || !config.allowedPrivateUsers.includes(target.id)) throw new Error('QQ target is not allowlisted');
}
export function parseQqEvent(raw: Record<string, unknown>, config: QqConfig, now: number): { event: QqEvent; media: MediaRef[] } | undefined {
  if (String(raw.self_id ?? '') !== config.selfId || raw.post_type === 'meta_event') return;
  const groupId = raw.group_id !== undefined ? String(raw.group_id) : undefined;
  const userId = String(raw.user_id ?? '');
  if (!/^\d+$/.test(userId) || userId === config.selfId) return;
  const target: Target = groupId ? { type: 'group', id: groupId } : { type: 'private', id: userId };
  try { allowedTarget(config, target); } catch { return; }
  if (!['message', 'notice', 'request'].includes(String(raw.post_type))) return;
  if (raw.post_type === 'message' && (!['group', 'private'].includes(String(raw.message_type)) || raw.sub_type === 'self')) return;
  const messageId = raw.message_id !== undefined ? String(raw.message_id) : undefined;
  if (raw.post_type === 'message' && (!messageId || !/^-?\d+$/.test(messageId))) return;
  const hash = createHash('sha256').update(JSON.stringify([raw.post_type, raw.notice_type, raw.request_type, raw.sub_type, groupId, userId, raw.target_id, raw.time, raw.flag, messageId])).digest('hex').slice(0, 32);
  const id = raw.post_type === 'message' ? `qq:${config.selfId}:message:${messageId}` : `qq:${config.selfId}:${hash}`;
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender as Record<string, unknown> : {};
  const isPoke = raw.notice_type === 'notify' && raw.sub_type === 'poke';
  const kind = raw.post_type === 'message' ? 'qq.message' : isPoke ? 'qq.poke' : `qq.${String(raw.notice_type ?? raw.request_type ?? 'event')}`;
  const event: QqEvent = { id, kind, selfId: config.selfId, groupId, userId, messageId,
    time: Number(raw.time ?? 0), receivedAt: now, nickname: String(sender.card || sender.nickname || userId).slice(0, 80),
    text: '', atBot: false, atUsers: [], parts: [], targetId: raw.target_id === undefined ? undefined : String(raw.target_id),
    flag: raw.flag === undefined ? undefined : String(raw.flag).slice(0, 2000), subType: String(raw.sub_type ?? ''), comment: String(raw.comment ?? '').slice(0, 2000) };
  const media: MediaRef[] = [];
  const parts = Array.isArray(raw.message) ? segments(raw.message) : [{ type: 'text', data: { text: String(raw.raw_message ?? '') } }];
  let textBudget = 6000;
  for (const [index, part] of parts.slice(0, 50).entries()) {
    const data = part.data;
    if (part.type === 'text') { const text = String(data.text ?? '').slice(0, textBudget); textBudget -= text.length; event.text += text; if (text) event.parts.push({ kind: 'text', text }); }
    else if (part.type === 'at') { const targetId = String(data.qq ?? ''); event.atUsers.push(targetId); event.parts.push({ kind: 'at', targetId }); }
    else if (part.type === 'reply') { event.replyTo ??= String(data.id ?? ''); event.parts.push({ kind: 'quote', targetId: String(data.id ?? '') }); }
    else if (part.type === 'face') { event.parts.push({ kind: 'face', faceId: String(data.id ?? '') }); event.text += '[QQ表情]'; }
    else if (['image', 'record', 'video', 'mface', 'marketface'].includes(part.type)) {
      if (media.length >= 8) continue;
      const resourceId = `${id}:media:${index}`; const kind = part.type === 'record' ? 'audio' : part.type === 'video' ? 'video' : 'image';
      media.push({ id: resourceId, kind, scope: target, eventId: id, file: String(data.file ?? '').slice(0, 2000), url: String(data.url ?? '').slice(0, 4000) });
      event.parts.push({ kind, resourceId });
      if (part.type === 'mface' || part.type === 'marketface') event.text += `[表情包：${String(data.summary ?? '').slice(0, 40)}]`;
    } else event.parts.push({ kind: 'unknown' });
  }
  event.text = event.text.slice(0, 6000); event.atBot = event.atUsers.includes(config.selfId);
  return { event, media };
}
export function savePlatformEvent(state: QqState, event: QqEvent, media: MediaRef[]): void {
  state.saveEvent(event); for (const ref of media) state.saveMedia(ref);
  if (event.messageId) state.rememberMessage(event.messageId, event.groupId ? { type: 'group', id: event.groupId } : { type: 'private', id: event.userId });
}
