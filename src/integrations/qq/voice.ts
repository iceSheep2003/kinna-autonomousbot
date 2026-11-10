import type { OneBotPort } from './ports.js';

/**
 * 语音转文字：用 QQ 自己的「转文字」。
 *
 * 为什么不用外部转写服务：QQ 客户端本来就有这个能力，NapCat 把它暴露成
 * `fetch_ptt_text`（源码里 `class FetchPttText extends OneBotAction`，
 * 内部调 `translatePtt2Text`）。它是免费的、对中文口语更准，也不用多配一个服务和密钥。
 *
 * 实测 DeepSeek 那条路走不通：没有 `/audio/transcriptions`（404），
 * `file` 内容类型只收 webp/png/jpeg/gif。
 *
 * 参数是**消息 id**（不是语音文件）：QQ 自己去定位那条语音再转写。
 * 所以调用点必须在拿到 messageId 的地方（插件里），而不是在媒体引用那一层。
 */
const PTT_TIMEOUT_MS = 15_000;

export interface PttResult {
  /** 转写出来的文字；空串表示 QQ 也没转出来。 */
  text: string;
  /** 失败原因，成功时没有。 */
  reason?: string;
}

/** QQ 的错误信息本来就清楚（消息不存在/已撤回/不包含语音），原样带回去。 */
export async function transcribePtt(gateway: OneBotPort, messageId: string, signal?: AbortSignal): Promise<PttResult> {
  try {
    const raw = await gateway.call('fetch_ptt_text', { message_id: messageId },
      signal === undefined ? AbortSignal.timeout(PTT_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(PTT_TIMEOUT_MS)]));
    const text = readText(raw);
    return text === '' ? { text: '', reason: 'QQ 没有返回文字（可能是纯噪声、方言太重或太短）' } : { text };
  } catch (error) {
    return { text: '', reason: String((error as Error).message).slice(0, 200) };
  }
}

/** 返回形状是 `{ text }`；兼容个别实现直接给字符串。 */
function readText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object' || raw === null) return '';
  const value = (raw as { text?: unknown }).text;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把文本里的 `[语音]` 占位换成转写结果。
 *
 * 转不出来时说清原因：**「听到但听不清」和「根本没听到」是两回事**，
 * 模型该据此决定是追问还是换个话题，而不是笼统地当作没这条消息。
 */
export function applyPtt(text: string, result: PttResult): string {
  if (!text.includes('[语音]')) return text;
  if (result.text !== '') return text.replace('[语音]', `[语音：${result.text.slice(0, 600)}]`);
  return text.replace('[语音]', `[语音：转不出文字${result.reason === undefined ? '' : `（${result.reason}）`}]`);
}
