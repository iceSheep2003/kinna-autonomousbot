import type { EnvironmentPlugin } from '../plugin.js';
import type { IncomingEvent } from '../../runtime/types.js';
import type { MediaRef, QqConfig, QqEvent, QqQuoted } from './types.js';
import type { OneBotPort, QqChannelPort, QqMediaSource, QqPerception, QqSpeech, QqMemeSource, QqState } from './ports.js';
import { parseQqEvent, savePlatformEvent } from './events.js';
import { registerQuotedImages, resolveQuote } from './quote.js';
import { describeImage, describeImagesIn } from './perceive.js';
import { applyPtt, transcribePtt } from './voice.js';
import { QqMessaging } from './messaging.js';
import { registerQqTools } from './tools.js';
import { QqAdministration } from './admin.js';
import { registerChannelTools } from './channel.js';
/**
 * 补齐一条入站消息里「只有 id 和占位符」的部分。
 *
 * 两件事：
 * 1. **引用**：取回被引用消息的原文；里面的图也注册成媒体资源并读出来。
 * 2. **图片/语音**：把 `[图片]` `[语音]` 占位换成真实描述/转写。
 *
 * 抽成一个函数不只是为了行数：这两件事都是「异步补内容」，失败都不该让整条消息丢掉。
 */
async function enrich(input: {
  event: QqEvent; media: MediaRef[]; state: QqState;
  deps: QqPluginOptions; gateway: OneBotPort;
}): Promise<QqEvent> {
  let event = input.event;
  const perceive = input.deps.media !== undefined && input.deps.perception !== undefined
    ? { media: input.deps.media, perception: input.deps.perception } : undefined;
  if (event.replyTo !== undefined && event.quoted === undefined) {
    const quoted = await resolveQuote(input.gateway, event.replyTo);
    const registered = registerQuotedImages(quoted, (url, index) => {
      const resourceId = `${event.id}:quote:${index}`;
      input.media.push({ id: resourceId, kind: 'image', eventId: event.id, url: url.slice(0, 4000),
        scope: event.groupId === undefined ? { type: 'private', id: event.userId } : { type: 'group', id: event.groupId } });
      return resourceId;
    });
    // 引用里的图也要读：只给 resourceId 的话模型知道有图却看不到内容。
    const described = perceive !== undefined && registered.imageResources !== undefined
      ? await describeQuotedImages(registered, input.state, perceive, input.media) : registered;
    event = { ...event, quoted: described };
  }
  event = await withVoice(event, input.media, input.gateway);
  if (perceive === undefined) return event;
  const text = await describeImagesIn(event.text, input.media, {
    ...perceive, cache: { get: id => input.state.imageSummary?.(id), put: (id, summary) => input.state.saveImageSummary?.(id, summary) },
  });
  return text === event.text ? event : { ...event, text };
}

/**
 * 语音：优先用 QQ 自己的转文字（免费、中文口语更准），转不出来才留给外部转写。
 *
 * 必须在拿到 `messageId` 的地方做——`fetch_ptt_text` 的参数是消息 id，不是语音文件。
 */
async function withVoice(event: QqEvent, media: readonly MediaRef[], gateway: OneBotPort): Promise<QqEvent> {
  if (event.messageId === undefined || !media.some(ref => ref.kind === 'audio')) return event;
  return { ...event, text: applyPtt(event.text, await transcribePtt(gateway, event.messageId)) };
}

/** 引用里的图逐张读一遍，把描述接到 quoted.text 后面。 */
async function describeQuotedImages(
  quoted: QqQuoted,
  state: QqState,
  deps: { media: QqMediaSource; perception: QqPerception },
  media: import('./types.js').MediaRef[],
): Promise<QqQuoted> {
  const summaries: string[] = [];
  for (const resourceId of quoted.imageResources ?? []) {
    const ref = media.find(item => item.id === resourceId);
    if (ref === undefined) continue;
    summaries.push(await describeImage(ref, {
      media: deps.media, perception: deps.perception,
      cache: { get: id => state.imageSummary?.(id), put: (id, summary) => state.saveImageSummary?.(id, summary) },
    }));
  }
  if (summaries.length === 0) return quoted;
  return { ...quoted, text: `${quoted.text}［图：${summaries.join('；')}］`.slice(0, 1400) };
}

export interface QqPluginOptions { config: QqConfig; gateway: OneBotPort; state: QqState; media?: QqMediaSource; perception?: QqPerception; speech?: QqSpeech; memes?: QqMemeSource; channel?: QqChannelPort; clock?: () => number }

/** 直发（@我、私聊、非消息事件）与 ambient 都进场景会话，其余只记经验。 */
function routeFor(event: QqEvent, config: QqConfig): IncomingEvent['route'] {
  const direct = event.atBot || event.kind !== 'qq.message' || !event.groupId;
  if (!direct && config.ambientMessages !== 'session') return { type: 'experience' };
  const type = event.groupId ? 'group' : 'private';
  const id = event.groupId ?? event.userId;
  return { type: 'session', sessionId: `qq:${config.selfId}:${type}:${id}`, environment: 'qq', scope: { type, id } };
}
function opportunityFor(event: QqEvent, config: QqConfig): { opportunity?: string } {
  return event.kind === 'qq.group_increase' && config.welcomeEnabled ? { opportunity: 'New member joined; consider whether/how to welcome them.' } : {};
}

export function createQqPlugin(deps: QqPluginOptions): EnvironmentPlugin {
  const { config, gateway, state } = deps; const clock = deps.clock ?? Date.now;
  const messaging = new QqMessaging(config, gateway, state);
  const administration = new QqAdministration({ config, gateway, state, messaging, clock });
  let emit: ((event: IncomingEvent) => void) | undefined;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let draining = false;
  let delivery: Promise<void> = Promise.resolve();
  function publish(event: QqEvent, outcome?: unknown) {
    // 请求 flag 和带签名媒体 URL 只保存在 QQ 专属仓库里。
    const { flag: _flag, processed: _processed, published: _published, outcome: _outcome, ...data } = event;
    emit?.({ id: event.id, source: 'qq', kind: event.kind, data: { ...data, outcome, ...opportunityFor(event, config) }, route: routeFor(event, config) });
    state.saveEvent({ ...event, published: true });
  }
  async function drain(): Promise<void> {
    if (draining || !emit) return;
    draining = true;
    try { for (const original of state.pendingEvents(20)) {
      let event = original;
      if (!event.processed) {
        let outcome: unknown;
        try { outcome = await administration.observe(event); }
        catch { outcome = { status: 'unconfirmed', reason: 'QQ platform operation could not be confirmed; inspect delivery records before retrying.' }; }
        event = { ...event, processed: true, outcome }; state.saveEvent(event);
      }
      publish(event, event.outcome);
    } } finally { draining = false; }
  }
  function deliver(): Promise<void> {
    if (!draining) delivery = drain();
    return delivery;
  }
  return {
    name: 'qq',
    setup(registry) {
      registerQqTools(registry, { ...deps, messaging }); administration.register(registry);
      if (config.channel?.enabled && deps.channel) registerChannelTools({ registry, config, state, client: deps.channel, clock });
    },
    async start(context) {
      emit = context.emit;
      await gateway.start(async raw => {
        const parsed = parseQqEvent(raw, config, clock()); if (!parsed) return;
        // 引用与图片：入站事件里只有 id 和占位符，内容得自己取回。
        // 否则模型只知道「有人引用了 123」「来了一张图」，接不上话也看不到图。
        parsed.event = await enrich({ event: parsed.event, media: parsed.media, state, deps, gateway });
        if (!state.event(parsed.event.id)) savePlatformEvent(state, parsed.event, parsed.media);
        await deliver();
      });
      // 已落盘事件即使暂时遇到核心 backpressure，也保留到后续重投。
      await deliver().catch(() => {});
      retryTimer = setInterval(() => { if (!draining) void deliver().catch(() => {}); }, 1000);
      retryTimer.unref();
    },
    async stop() { clearInterval(retryTimer); await gateway.stop(); await delivery.catch(() => {}); emit = undefined; },
  };
}
