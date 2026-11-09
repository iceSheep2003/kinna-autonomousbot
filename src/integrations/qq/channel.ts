import { authorizeQqScene } from './scope.js';
import { z } from 'zod';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { QqChannelPort, QqState } from './ports.js';
import type { QqConfig } from './types.js';
const reads = [/^\/users\/@me\/guilds$/, /^\/guilds\/\d+\/api_permission$/, /^\/guilds\/\d+\/channels$/, /^\/channels\/\d+$/, /^\/guilds\/\d+\/members(?:\/\d+)?$/, /^\/guilds\/\d+\/roles\/\d+\/members$/, /^\/channels\/\d+\/online_nums$/, /^\/channels\/\d+\/threads(?:\/\d+)?$/];
const writes: Record<string, RegExp[]> = {
  PUT: [/^\/channels\/\d+\/threads$/],
  POST: [/^\/channels\/\d+\/threads\/\d+\/comment$/, /^\/guilds\/\d+\/announces$/, /^\/channels\/\d+\/schedules$/],
  PATCH: [/^\/channels\/\d+\/schedules\/\d+$/],
};
/** 沿用线上官方频道操作集合，外加部署白名单和真实 operator 事件绑定。 */
export function registerChannelTools(registry: CapabilityRegistrar, config: QqConfig, state: QqState, client: QqChannelPort, clock: () => number): void {
  const channel = config.channel!;
  function scope(path: string) {
    const guild = path.match(/^\/guilds\/(\d+)\//)?.[1]; const target = path.match(/^\/channels\/(\d+)/)?.[1];
    if (guild && !channel.allowedGuilds.includes(guild)) throw new Error('QQ guild is not allowlisted');
    if (target && !channel.allowedChannels.includes(target)) throw new Error('QQ channel is not allowlisted');
  }
  const query = z.object({ path: z.string().min(1).max(200), query: z.record(z.string().max(50), z.string().max(200)).refine(q => Object.keys(q).length <= 10).optional() });
  registry.register({ name: 'qq.channel_query', description: '查询QQ官方频道服务器、权限、子频道、成员、在线人数或论坛帖。只读路径和资源都有白名单。', effect: 'read', input: query, authorize: (input, scope) => authorizeQqScene(input, scope, state),
    async run(raw, { signal }) {
      const input = query.parse(raw); if (!reads.some(re => re.test(input.path))) throw new Error('QQ channel read path denied'); scope(input.path);
      const result = await client.request('GET', input.path, undefined, signal, input.query);
      if (input.path === '/users/@me/guilds') return (Array.isArray(result) ? result : []).filter(row => channel.allowedGuilds.includes(String(row.id)));
      if (/^\/guilds\/\d+\/channels$/.test(input.path)) return (Array.isArray(result) ? result : []).filter(row => channel.allowedChannels.includes(String(row.id)));
      return result;
    },
  });
  const write = z.object({ eventId: z.string().max(120), method: z.enum(['PUT', 'POST', 'PATCH']), path: z.string().max(200), body: z.record(z.string(), z.unknown()).refine(body => Object.keys(body).length > 0 && JSON.stringify(body).length <= 8000) });
  registry.register({ name: 'qq.channel_write', description: '依据真实频道 operator 的明确要求发布论坛帖、评论、公告、创建或更新频道日程。白名单操作，不能任意HTTP请求。', effect: 'write', input: write, authorize: (input, scope) => authorizeQqScene(input, scope, state),
    async run(raw, { signal }) {
      const input = write.parse(raw); const event = state.event(input.eventId);
      if (!event || event.kind !== 'qq.message' || !channel.operatorIds.includes(event.userId) || clock() - event.receivedAt > config.operatorEventTtlMs) throw new Error('A recent authentic channel operator event is required');
      if (!(writes[input.method] ?? []).some(re => re.test(input.path))) throw new Error('QQ channel write path denied'); scope(input.path);
      return client.request(input.method, input.path, input.body, signal);
    },
  });
}
