import { z } from 'zod';
import type { QqConfig } from '../../integrations/qq/types.js';
import type { QqState } from '../../integrations/qq/ports.js';
import { createQqPlugin } from '../../integrations/qq/plugin.js';
import { ReverseOneBotGateway } from './onebot-gateway.js';
import { NapCatMediaSource } from './media.js';
import { OpenAiQqPerception } from './perception.js';
import { HttpQqSpeech } from './speech.js';
import { LocalQqMemes } from './memes.js';
import { QqChannelClient } from './channel.js';

type Env = Record<string, string | undefined>;

/** 具体依赖只在边缘装配，凭证不进入插件配置、模型上下文或领域模块。 */
export async function createQqEnvironment(config: QqConfig, state: QqState, env: Env) {
  const token = env.QQ_ONEBOT_TOKEN || env.BOT_ONEBOT_TOKEN;
  if (!token) throw new Error('Set QQ_ONEBOT_TOKEN before enabling QQ');
  const gateway = new ReverseOneBotGateway({ host: config.host, port: config.port, token, selfId: config.selfId, requestTimeoutMs: config.requestTimeoutMs });
  const media = new NapCatMediaSource(gateway, config.mediaRoots, config.pathMap);
  const memes = env.QQ_MEMES_PATH ? await LocalQqMemes.load(env.QQ_MEMES_PATH) : undefined;
  return createQqPlugin({ config, gateway, state, media, perception: createPerception(env), speech: createSpeech(env), channel: createChannel(config, env), memes });
}

function createPerception(env: Env): OpenAiQqPerception | undefined {
  if (!env.QQ_VISION_MODEL && !env.QQ_AUDIO_MODEL) return undefined;
  return new OpenAiQqPerception({
    baseUrl: env.QQ_MEDIA_BASE_URL || env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.QQ_MEDIA_API_KEY || env.LLM_API_KEY || '',
    visionModel: env.QQ_VISION_MODEL, audioModel: env.QQ_AUDIO_MODEL,
  });
}

function createSpeech(env: Env): HttpQqSpeech | undefined {
  if (!env.QQ_TTS_PROVIDER) return undefined;
  const provider = z.enum(['openai', 'qwen', 'cosyvoice', 'qwen-audio']).parse(env.QQ_TTS_PROVIDER);
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Set ${name} for QQ voice`); return value; };
  return new HttpQqSpeech({ provider, baseUrl: required('QQ_TTS_BASE_URL'), apiKey: required('QQ_TTS_API_KEY'), model: required('QQ_TTS_MODEL'), voice: required('QQ_TTS_VOICE') });
}

function createChannel(config: QqConfig, env: Env): QqChannelClient | undefined {
  if (!config.channel?.enabled) return undefined;
  if (!env.QQ_CHANNEL_APP_ID || !env.QQ_CHANNEL_APP_SECRET) throw new Error('QQ channel requires QQ_CHANNEL_APP_ID and QQ_CHANNEL_APP_SECRET');
  return new QqChannelClient({ appId: env.QQ_CHANNEL_APP_ID, appSecret: env.QQ_CHANNEL_APP_SECRET, sandbox: config.channel.sandbox });
}
