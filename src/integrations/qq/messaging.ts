import { setTimeout as delay } from 'node:timers/promises';
import { qqBudget } from './budget.js';
import type { OneBotPort, QqState } from './ports.js';
import { OneBotUncertain } from './ports.js';
import type { QqConfig, Segment, SendReceipt, Target } from './types.js';
import { allowedTarget, segments } from './events.js';

/** 一条待发送的 QQ 消息；分段、@、引用和媒体都在这里声明。 */
export interface SendInput {
  target: Target; text?: string; atUsers?: string[]; replyTo?: string;
  image?: string; voice?: string; face?: string; native?: 'dice' | 'rps';
}

export function onebotId(value: string): number { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('OneBot ID is not a safe integer'); return n; }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OneBot object'); return value as Record<string, unknown>; }
export function splitText(text: string, chars: number, maxParts: number): string[] {
  const result: string[] = []; let rest = text.trim();
  while (rest) {
    if (result.length >= maxParts) throw new Error('QQ text exceeds part budget');
    let cut = Math.min(chars, rest.length);
    if (rest.length > chars) {
      const found = [...rest.slice(0, chars).matchAll(/[。！？!?；;\n]/g)].at(-1);
      if (found && found.index! >= chars / 2) cut = found.index! + 1;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? '')) cut--;
    }
    result.push(rest.slice(0, cut)); rest = rest.slice(cut).trim();
  }
  return result;
}
export async function oncePlatform<T>(state: QqState, id: string, kind: string, invoke: () => Promise<T>): Promise<T> {
  const old = state.operation(id);
  if (old?.status === 'completed') return old.result as T;
  if (old) throw new OneBotUncertain('QQ operation needs reconciliation; it will not be resent');
  state.saveOperation({ id, kind, status: 'started' });
  try { const result = await invoke(); state.saveOperation({ id, kind, status: 'completed', result }); return result; }
  catch (error) { state.saveOperation({ id, kind, status: 'uncertain' }); throw error; }
}

export class QqMessaging {
  constructor(private readonly config: QqConfig, private readonly gateway: OneBotPort, private readonly state: QqState) {}
  async message(target: Target, id: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    allowedTarget(this.config, target);
    const known = this.state.knownMessage(id);
    if (known && (known.target.type !== target.type || known.target.id !== target.id)) throw new Error('Message is outside requested scope');
    const result = object(await this.gateway.call('get_msg', { message_id: onebotId(id) }, signal));
    const group = result.group_id === undefined ? '' : String(result.group_id);
    if (target.type === 'group' ? group !== target.id : group || ![result.user_id, result.target_id].some(v => String(v) === target.id)) throw new Error('Message is outside requested scope');
    this.state.rememberMessage(id, target);
    return result;
  }
  async quote(target: Target, id: string, signal: AbortSignal) {
    let current = id; const seen = new Set<string>(); const chain: unknown[] = [];
    for (let depth = 0; depth < qqBudget.quoteDepth && current && !seen.has(current); depth++) {
      seen.add(current); const result = await this.message(target, current, signal);
      const parts = segments(result.message); const text = parts.filter(p => p.type === 'text').map(p => String(p.data.text ?? '')).join('').slice(0, qqBudget.messageChars);
      chain.push({ ...this.view(target, current, result), text });
      current = String(parts.find(p => p.type === 'reply')?.data.id ?? '');
    }
    return { chain };
  }
  view(target: Target, messageId: string, message: Record<string, unknown>) {
    let budget = qqBudget.messageChars; let mediaCount = 0;
    const parts = segments(message.message).slice(0, qqBudget.partsPerMessage).map((part, index) => {
      if (part.type === 'text') { const text = String(part.data.text ?? '').slice(0, budget); budget -= text.length; return { kind: 'text', text }; }
      if (['image', 'record', 'mface', 'marketface'].includes(part.type) && mediaCount++ < qqBudget.mediaPerMessage) {
        const id = `qq:${this.config.selfId}:fetched:${messageId}:media:${index}`;
        const kind = part.type === 'record' ? 'audio' as const : 'image' as const;
        this.state.saveMedia({ id, kind, scope: target, eventId: `fetched:${messageId}`, url: String(part.data.url ?? '').slice(0, 4000), file: String(part.data.file ?? '').slice(0, 2000) });
        return { kind, resourceId: id };
      }
      return { kind: part.type, targetId: String(part.data.id ?? part.data.qq ?? '').slice(0, 40) };
    });
    const sender = message.sender && typeof message.sender === 'object' ? message.sender as Record<string, unknown> : {};
    return { messageId, sender: { userId: String(sender.user_id ?? message.user_id ?? ''), nickname: String(sender.card ?? sender.nickname ?? '').slice(0, 80) }, parts };
  }
  async send(input: SendInput, operationId: string, signal: AbortSignal): Promise<SendReceipt> {
    const chunks = await this.prepare(input, signal);
    return oncePlatform(this.state, operationId, 'message.send', () => this.deliver(input, chunks, operationId, signal));
  }
  /** 发送前的全部校验与引用解析；顺序影响报错优先级，不要随意调整。 */
  private async prepare(input: SendInput, signal: AbortSignal): Promise<string[]> {
    allowedTarget(this.config, input.target);
    const chunks = splitText(input.text ?? '', this.config.textPartChars, this.config.maxTextParts);
    if (!chunks.length && !hasMedia(input)) throw new Error('Empty QQ message');
    this.assertMentionTarget(input);
    await this.resolveReferences(input, signal);
    return chunks;
  }
  private assertMentionTarget(input: SendInput): void {
    if ((input.atUsers?.length || input.replyTo) && input.target.type !== 'group') throw new Error('At/reply segments require group target');
  }
  private async resolveReferences(input: SendInput, signal: AbortSignal): Promise<void> {
    if (input.replyTo) await this.message(input.target, input.replyTo, signal);
    for (const userId of input.atUsers ?? []) await this.gateway.call('get_group_member_info', { group_id: onebotId(input.target.id), user_id: onebotId(userId), no_cache: false }, signal);
  }
  /** 每条消息单独记账；只有拿到真实 message_id 才算发出。 */
  private async deliver(input: SendInput, chunks: string[], operationId: string, signal: AbortSignal): Promise<SendReceipt> {
    const messageIds: string[] = [];
    const frameCount = Math.max(1, chunks.length);
    for (let index = 0; index < frameCount; index++) {
      signal.throwIfAborted();
      const message = this.frame(input, chunks[index], index, frameCount);
      const sent = object(await oncePlatform(this.state, `${operationId}:part:${index}`, 'message.part', () => this.dispatch(input.target, message, signal)));
      const id = String(sent.message_id ?? '');
      if (!/^-?\d+$/.test(id)) throw new OneBotUncertain('QQ did not return a message receipt');
      messageIds.push(id); this.state.rememberMessage(id, input.target);
      if (index + 1 < frameCount && this.config.sendIntervalMs) await delay(this.config.sendIntervalMs, undefined, { signal });
    }
    return { messageIds, target: input.target, sentParts: frameCount };
  }
  private frame(input: SendInput, text: string | undefined, index: number, frameCount: number): Segment[] {
    const message: Segment[] = [];
    if (index === 0) {
      if (input.replyTo) message.push({ type: 'reply', data: { id: input.replyTo } });
      for (const qq of input.atUsers ?? []) message.push({ type: 'at', data: { qq } });
    }
    if (text) message.push({ type: 'text', data: { text } });
    if (index === frameCount - 1) appendMedia(message, input);
    return message;
  }
  private dispatch(target: Target, message: Segment[], signal: AbortSignal): Promise<unknown> {
    return this.gateway.call(target.type === 'group' ? 'send_group_msg' : 'send_private_msg',
      { [target.type === 'group' ? 'group_id' : 'user_id']: onebotId(target.id), message }, signal);
  }
}

function hasMedia(input: SendInput): boolean { return !!(input.image || input.voice || input.face || input.native); }
function appendMedia(message: Segment[], input: SendInput): void {
  if (input.image) message.push({ type: 'image', data: { file: input.image } });
  if (input.voice) message.push({ type: 'record', data: { file: input.voice } });
  if (input.face) message.push({ type: 'face', data: { id: input.face } });
  if (input.native) message.push({ type: input.native, data: {} });
}
