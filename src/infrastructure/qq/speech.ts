import type { QqSpeech } from '../../integrations/qq/ports.js';
import { downloadPublicMedia, MAX_MEDIA_BYTES } from './media.js';
export interface SpeechConfig { provider: 'openai' | 'qwen' | 'cosyvoice' | 'qwen-audio'; baseUrl: string; apiKey: string; model: string; voice: string }
const styles: Record<string, string> = { neutral: '自然放松地聊天', warm: '温柔平静地交谈', playful: '轻松带笑意地聊天', excited: '稍微开心轻快，不要喊叫', serious: '认真平稳地说话' };
const prosody: Record<string, [string, string]> = { neutral: ['1', '1'], warm: ['0.97', '0.99'], playful: ['1.04', '1.02'], excited: ['1.07', '1.03'], serious: ['0.96', '0.98'] };
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Synthesis { config: SpeechConfig; text: string; style: string; rate: string; pitch: string }
interface SpeechPlan { endpoint: string; body: unknown }
/** 每家供应商的请求形状不同，各自一个纯函数，不做分支链。 */
const plans: Record<SpeechConfig['provider'], (input: Synthesis) => SpeechPlan> = {
  openai: ({ config, text }) => ({ endpoint: '/audio/speech', body: { model: config.model, voice: config.voice, input: text, response_format: 'mp3' } }),
  qwen: ({ config, text }) => ({ endpoint: '/services/aigc/multimodal-generation/generation', body: { model: config.model, input: { text, voice: config.voice, language_type: 'Chinese' } } }),
  cosyvoice: ({ config, text, style, rate, pitch }) => ({ endpoint: '/services/audio/tts/SpeechSynthesizer',
    body: { model: config.model, input: { text: `<speak rate="${rate}" pitch="${pitch}">${escapeXml(text)}</speak>`, voice: config.voice, format: 'wav', sample_rate: 24000, enable_ssml: true } } }),
  'qwen-audio': ({ config, text, style }) => ({ endpoint: '/services/audio/tts/SpeechSynthesizer',
    body: { model: config.model, input: { text, voice: config.voice, format: 'wav', sample_rate: 24000, instruction: styles[style] ?? styles.neutral } } }),
};

export class HttpQqSpeech implements QqSpeech {
  constructor(private readonly config: SpeechConfig) {}
  async synthesize(text: string, style: string, signal: AbortSignal): Promise<string> {
    const [rate, pitch] = prosody[style] ?? prosody.neutral!;
    const plan = plans[this.config.provider]({ config: this.config, text, style, rate, pitch });
    const base = this.config.baseUrl.replace(/\/$/, '');
    const response = await fetch(base + plan.endpoint, { method: 'POST', signal, headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(plan.body) });
    if (!response.ok) throw new Error(`QQ speech HTTP ${response.status}`);
    const bytes = this.config.provider === 'openai' ? await readStream(response) : await this.readRemote(response, signal);
    if (!bytes.length || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('Invalid speech output');
    return `base64://${Buffer.from(bytes).toString('base64')}`;
  }
  /** 非 OpenAI 供应商返回的是临时音频 URL，只在受信任域名下取回。 */
  private async readRemote(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const data = await response.json() as { output?: { audio?: { url?: string } } };
    const url = new URL(data.output?.audio?.url ?? '');
    if (!url.hostname.endsWith('.aliyuncs.com')) throw new Error('Unexpected speech media host');
    url.protocol = 'https:';
    return downloadPublicMedia(url.href, host => host.endsWith('.aliyuncs.com'), signal);
  }
}

async function readStream(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty speech response');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MEDIA_BYTES) throw new Error('Speech exceeds byte budget');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
