import type { QqSpeech } from '../../integrations/qq/ports.js';
import { downloadPublicMedia, MAX_MEDIA_BYTES } from './media.js';
export interface SpeechConfig { provider: 'openai' | 'qwen' | 'cosyvoice' | 'qwen-audio'; baseUrl: string; apiKey: string; model: string; voice: string }
const styles: Record<string, string> = { neutral: '自然放松地聊天', warm: '温柔平静地交谈', playful: '轻松带笑意地聊天', excited: '稍微开心轻快，不要喊叫', serious: '认真平稳地说话' };
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export class HttpQqSpeech implements QqSpeech {
  constructor(private readonly config: SpeechConfig) {}
  async synthesize(text: string, style: string, signal: AbortSignal): Promise<string> {
    const c = this.config; const base = c.baseUrl.replace(/\/$/, '');
    const prosody: Record<string, [string, string]> = { neutral: ['1','1'], warm: ['0.97','0.99'], playful: ['1.04','1.02'], excited: ['1.07','1.03'], serious: ['0.96','0.98'] };
    const [rate, pitch] = prosody[style] ?? prosody.neutral!;
    const endpoint = c.provider === 'openai' ? '/audio/speech' : c.provider === 'qwen' ? '/services/aigc/multimodal-generation/generation' : '/services/audio/tts/SpeechSynthesizer';
    const input = c.provider === 'cosyvoice' ? { text: `<speak rate="${rate}" pitch="${pitch}">${escapeXml(text)}</speak>`, voice: c.voice, format: 'wav', sample_rate: 24000, enable_ssml: true }
      : c.provider === 'qwen-audio' ? { text, voice: c.voice, format: 'wav', sample_rate: 24000, instruction: styles[style] ?? styles.neutral }
      : { text, voice: c.voice, language_type: 'Chinese' };
    const response = await fetch(base + endpoint, { method: 'POST', signal, headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(c.provider === 'openai' ? { model: c.model, voice: c.voice, input: text, response_format: 'mp3' } : { model: c.model, input }) });
    if (!response.ok) throw new Error(`QQ speech HTTP ${response.status}`);
    let bytes: Uint8Array;
    if (c.provider === 'openai') {
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty speech response');
      let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_MEDIA_BYTES) throw new Error('Speech exceeds byte budget'); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      bytes = Buffer.concat(chunks);
    } else {
      const data = await response.json() as { output?: { audio?: { url?: string } } };
      const url = new URL(data.output?.audio?.url ?? ''); if (!url.hostname.endsWith('.aliyuncs.com')) throw new Error('Unexpected speech media host');
      url.protocol = 'https:';
      bytes = await downloadPublicMedia(url.href, host => host.endsWith('.aliyuncs.com'), signal);
    }
    if (!bytes.length || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('Invalid speech output');
    return `base64://${Buffer.from(bytes).toString('base64')}`;
  }
}
