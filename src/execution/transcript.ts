import type { Experience } from '../memory/types.js';

/**
 * 对话记录投影：把通用经验流水还原成「谁说了什么」。
 *
 * 为什么需要这一层：experience 是通用的（消息、工具回执、笔记、Dream 日志都在里面），
 * 直接塞给模型的问题是——**它看不出哪句是群友说的、哪句是自己说的**。
 * 昵称埋在 `data.nickname` 里，自己发的话只剩一条 `{name:'send_message', result:{messageIds}}`。
 *
 * 线上的做法最朴素也最有效（实测看它的 `_history_messages`）：
 * - 群友的消息 → `{role:'user', content:'昵称: 内容'}`，**昵称直接拼进内容**
 * - 自己的消息 → `{role:'assistant', content:'内容'}`，不加前缀
 *
 * 三种「记不住」都是这一层造成的：
 * 1. 记不住自己的话 —— 发出去只留了回执，没留内容
 * 2. 记不住群友是谁 —— 昵称在嵌套 JSON 里，不是内容的一部分
 * 3. 记不住群友说过什么 —— 同上，模型要自己去解结构
 */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * 对应的经验流水序号。
   *
   * 必须带着：场景做 `reflect` 时要给 `evidence`（原话的 seq）。
   * 只给格式化后的文本、丢掉 seq，模型就只能凭空编证据，或者干脆没法反思。
   */
  seq: number;
  /** 说话人的 QQ 号；assistant 消息没有。拿它去取「关于这个人的记忆」。 */
  userId?: string;
  /** 说话人当时的昵称/群名片。 */
  name?: string;
}

/**
 * 发送类工具：调用它们意味着「我说了话」，要从回执还原成 assistant 消息。
 *
 * 必须按**后缀**匹配，不能写死全名：工具名带模块前缀（`qq.send_message`、
 * `bilibili.draft_comment`），写死 `send_message` 会漏掉所有带前缀的。
 * 这个疏漏的实际后果是——模型以为自己没说过话，于是**又发了一遍**。
 */
const SPEAKING_SUFFIXES = ['.send_message', '.say', '.reply', '.draft_comment', '.draft_dynamic'];

function isSpeakingTool(name: string): boolean {
  return name === 'send_message' || SPEAKING_SUFFIXES.some(suffix => name.endsWith(suffix));
}

/**
 * 取出经验里真正的事件体。
 *
 * 入站事件在 inbox 里被包了一层：`{ source, data: <事件体> }`。
 * 不解这一层，`nickname` 和 `text` 就永远取不到——表现是**对话记录全空**，
 * 模型既不知道谁在说话，也想不起说过什么。自己记的 `tool.result` 没有包装，原样返回。
 */
function payloadOf(row: Experience): Record<string, unknown> | undefined {
  const outer = row.data as Record<string, unknown> | undefined;
  if (outer === undefined || typeof outer !== 'object') return undefined;
  const inner = outer.data;
  if (typeof inner === 'object' && inner !== null) return inner as Record<string, unknown>;
  return outer;
}

/** 说话人：QQ 号 + 昵称。同一个人换群名片时靠 QQ 号认，不是靠名字。 */
function whoSaid(data: Record<string, unknown>): { userId?: string; name?: string } {
  const userId = [data.userId, data.user_id, data.senderId].find(value => typeof value === 'string' && value.trim() !== '');
  const name = typeof data.nickname === 'string' && data.nickname.trim() !== '' ? data.nickname : undefined;
  return { ...(typeof userId === 'string' ? { userId } : {}), ...(name === undefined ? {} : { name }) };
}

/**
 * 当前是谁在说话：从最新的一条入站消息里取。
 * 一次进多个人时取最后一条——正在接话的通常是最后说话的那个。
 */
export function currentSpeaker(rows: readonly Experience[]): { userId?: string; name?: string } {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = toTranscriptMessage(rows[index]!);
    if (message?.role === 'user' && message.userId !== undefined) return { userId: message.userId, ...(message.name === undefined ? {} : { name: message.name }) };
  }
  return {};
}

/** 入站消息：`message` 或 `<平台>.message`。 */
function isInboundKind(kind: string): boolean {
  return kind === 'message' || kind.endsWith('.message');
}

/**
 * 一条经验 → 一条对话消息；不是对话的返回 undefined（不占上下文）。
 *
 * 判据是 kind 加字段，不做启发式猜测：
 * - `message`：入站消息，带昵称和文本
 * - `tool.result`：如果是发送类工具，用它的入参还原成「我说的话」
 */
export function toTranscriptMessage(row: Experience): TranscriptMessage | undefined {
  const data = payloadOf(row);
  if (data === undefined) return undefined;
  // kind 带平台前缀（`qq.message`、`bilibili.comment`），不能只匹配 `message`：
  // 写死之后场景的对话记录会是空的，表现就是「完全不记得群友说过什么」。
  const message = isInboundKind(row.kind) ? inbound(data) : row.kind === 'tool.result' ? outbound(data) : undefined;
  if (message === undefined) return undefined;
  return isInboundKind(row.kind) ? { ...message, seq: row.seq, ...whoSaid(data) } : { ...message, seq: row.seq };
}

/** 入站：昵称拼进内容，让「谁说的」成为内容的一部分而不是要模型去解结构。 */
function inbound(data: Record<string, unknown>): Omit<TranscriptMessage, 'seq'> | undefined {
  const text = typeof data.text === 'string' ? data.text : undefined;
  if (text === undefined || text.trim() === '') return undefined;
  const nickname = typeof data.nickname === 'string' && data.nickname.trim() !== '' ? data.nickname : '某人';
  return { role: 'user', content: `${nickname}: ${text}` };
}

/**
 * 出站：从发送类工具的入参里把「我说的话」取回来。
 *
 * 这里必须能从回执还原，否则就是「只记得自己按了发送键，不记得发了什么」——
 * 那正是之前的状态。同一轮发多段时按段落顺序拼还原，保持和真实发送一致。
 */
function outbound(data: Record<string, unknown>): Omit<TranscriptMessage, 'seq'> | undefined {
  const name = typeof data.name === 'string' ? data.name : '';
  if (!isSpeakingTool(name)) return undefined;
  const input = data.input as Record<string, unknown> | undefined;
  const text = input === undefined ? undefined : input.text;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return { role: 'assistant', content: text };
}

/**
 * 按字符预算从**最新往前**取，取到装不下为止。
 *
 * 两条规则（照线上，理由也都成立）：
 * - **一条消息绝不切半**：半句话比没有更糟——模型会自己脑补后半句。
 * - **老的从前面掉**：最近的一轮才是回复真正要接的东西。
 */
export function transcriptWindow(rows: readonly Experience[], budgetChars: number): TranscriptMessage[] {
  const kept: TranscriptMessage[] = [];
  let remaining = budgetChars;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = toTranscriptMessage(rows[index]!);
    if (message === undefined) continue;
    if (message.content.length > remaining) break;
    kept.push(message);
    remaining -= message.content.length;
  }
  return kept.reverse();
}

/** 统计投影后的条数，用于日志与「这条消息到底进没进上下文」的排查。 */
export function transcriptSize(rows: readonly Experience[]): number {
  return rows.reduce((total, row) => total + (toTranscriptMessage(row) === undefined ? 0 : 1), 0);
}
