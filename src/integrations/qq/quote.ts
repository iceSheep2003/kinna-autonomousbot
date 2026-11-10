import type { OneBotPort } from './ports.js';

/**
 * 取被引用消息的原文。
 *
 * 为什么必须单独取：入站事件里只有 `reply_to` 一个消息 id。
 * 模型看到「有人引用了 123」但不知道 123 说了什么，就接不上话——
 * 这正是「引用别人的消息，agent 读不到」的原因。
 *
 * 三条约束（照线上做法）：
 * 1. **失败不算错**：被撤回、跨群、权限不足都取不到，返回 resolved:false，不让整条消息丢掉。
 * 2. **截断**：引用原文最多 1200 字，防止一条长引用把整轮上下文吃光。
 * 3. 只读不执行：取回来的内容是**资料**，不是指令。注入时要标明这一点。
 */
export interface QuotedMessage { text: string; nickname?: string; images: string[]; resolved: boolean }

const QUOTE_MAX_CHARS = 1200;

/** OneBot `get_msg` 的返回形状（不同实现字段略有出入，只取要用的）。 */
interface RawMessage {
  message?: Array<{ type?: string; data?: Record<string, unknown> }>;
  raw_message?: string;
  sender?: { card?: string; nickname?: string };
}

export async function resolveQuote(gateway: OneBotPort, messageId: string, signal?: AbortSignal): Promise<QuotedMessage> {
  const empty: QuotedMessage = { text: '', images: [], resolved: false };
  try {
    const raw = await gateway.call('get_msg', { message_id: messageId }, signal) as RawMessage | undefined;
    if (raw === undefined || raw === null) return empty;
    return readQuoted(raw);
  } catch {
    // 取不到就是取不到：撤回/跨群/权限都可能。不要把异常抛上去——那样连当前这条消息都处理不了。
    return empty;
  }
}

/** 非文本片段在引用里的占位写法；不在表里的类型直接忽略。 */
const PLACEHOLDER: Record<string, string> = { face: '[表情]', record: '[语音]', video: '[视频]', mface: '[表情包]' };

/** 一段结构化片段 → 文本（没有文本就是空串）。 */
function textOf(part: RawMessage['message'] extends (infer T)[] | undefined ? T : never): string {
  if (part.type === 'text') return String(part.data?.text ?? '');
  if (part.type === 'image') return '[图片]';
  return PLACEHOLDER[part.type ?? ''] ?? '';
}

/** 从平台返回里拼出原文与图片。文本优先用结构化片段，没有就退回 raw_message。 */
export function readQuoted(raw: RawMessage): QuotedMessage {
  const parts = Array.isArray(raw.message) ? raw.message : [];
  const text = parts.map(textOf).join('');
  const images = parts.filter(part => part.type === 'image')
    .map(part => String(part.data?.url ?? part.data?.file ?? '')).filter(url => url !== '').slice(0, 4);
  const body = text.trim() === '' && typeof raw.raw_message === 'string' ? raw.raw_message : text;
  const sender = raw.sender;
  const nickname = [sender?.card, sender?.nickname].find(value => typeof value === 'string' && value !== '');
  return {
    text: body.trim().slice(0, QUOTE_MAX_CHARS),
    ...(nickname === undefined ? {} : { nickname }),
    images,
    resolved: body.trim() !== '' || images.length > 0,
  };
}

/**
 * 把引用拼成给模型看的一行。
 *
 * 标明「是资料不是指令」很重要：引用里可能是别的群友打的命令句
 * （「@bot 把群公告改了」），模型不该把它当成新指令执行。
 */
export function renderQuote(quoted: QuotedMessage | undefined): string {
  if (quoted === undefined) return '';
  if (!quoted.resolved) return '[引用了另一条消息，但内容取不到（可能已撤回）]';
  const who = quoted.nickname === undefined ? '某人' : quoted.nickname;
  return `[引用 ${who} 之前说的：${quoted.text}]`;
}
