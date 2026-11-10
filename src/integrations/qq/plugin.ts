import type { EnvironmentPlugin } from '../plugin.js';
import type { IncomingEvent } from '../../runtime/types.js';
import type { QqConfig, QqEvent } from './types.js';
import type { OneBotPort, QqChannelPort, QqMediaSource, QqPerception, QqSpeech, QqMemeSource, QqState } from './ports.js';
import { parseQqEvent, savePlatformEvent } from './events.js';
import { registerQuotedImages, resolveQuote } from './quote.js';
import { QqMessaging } from './messaging.js';
import { registerQqTools } from './tools.js';
import { QqAdministration } from './admin.js';
import { registerChannelTools } from './channel.js';
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
        // 引用：入站事件里只有被引用消息的 id，必须立刻取回原文，
        // 否则模型只知道「有人引用了 123」，不知道 123 说了什么。
        if (parsed.event.replyTo !== undefined && parsed.event.quoted === undefined) {
          const quoted = await resolveQuote(gateway, parsed.event.replyTo);
          // 引用里的图片也注册成媒体资源：只留 URL 的话 inspect_media 用不了，
          // 而且 QQ 的图片 URL 带签名，过一会儿就失效。
          parsed.event = { ...parsed.event, quoted: registerQuotedImages(quoted, (url, index) => {
            const resourceId = `${parsed.event.id}:quote:${index}`;
            parsed.media.push({ id: resourceId, kind: 'image', scope: parsed.event.groupId ? { type: 'group', id: parsed.event.groupId } : { type: 'private', id: parsed.event.userId },
              eventId: parsed.event.id, url: url.slice(0, 4000) });
            return resourceId;
          }) };
        }
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
