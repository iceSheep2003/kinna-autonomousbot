import { z } from 'zod';
import { authorizeQqScene } from './scope.js';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { OneBotPort, QqMediaSource, QqPerception, QqSpeech, QqMemeSource, QqState } from './ports.js';
import { QqId, MessageId, TargetSchema, type QqConfig } from './types.js';
import { allowedTarget, segments } from './events.js';
import { object, onebotId, QqMessaging } from './messaging.js';
export interface QqToolsDependencies { config: QqConfig; gateway: OneBotPort; state: QqState; messaging: QqMessaging; media?: QqMediaSource; perception?: QqPerception; speech?: QqSpeech; memes?: QqMemeSource }

/** 一个工具声明：名字、描述、效果、入参 schema 和实现。 */
interface ToolSpec<T> {
  name: string; description: string; effect: 'read' | 'write'; input: z.ZodType<T>;
  run: (input: T, context: { operationId: string; signal: AbortSignal }) => Promise<unknown>;
}

export function registerQqTools(registry: CapabilityRegistrar, deps: QqToolsDependencies): void {
  const { config, gateway, state, messaging } = deps;
  const tool = <T>(spec: ToolSpec<T>) => {
    registry.register({ name: `qq.${spec.name}`, description: spec.description, effect: spec.effect, input: spec.input,
      authorize: (input, scope) => authorizeQqScene(input, scope, state), run: (raw, context) => spec.run(spec.input.parse(raw), context) });
  };
  const locator = z.string().min(1).max(4000).refine(v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }, 'Use HTTPS media URL; local files require configured resources');
  tool({ name: 'environment', description: '了解自己当前能接触的QQ账号、会话白名单和可选媒体能力。探索或主动联系前可查询。', effect: 'read', input: z.object({}),
    run: async () => ({ selfId: config.selfId, allowedGroups: config.allowedGroups, allowedPrivateUsers: config.privateEnabled ? config.allowedPrivateUsers : [], voice: !!deps.speech, perception: !!deps.perception, memeTags: deps.memes?.tags() ?? [] }) });
  tool({ name: 'send_message', description: '向白名单群或私聊对象发送消息，可主动发起。@、引用、图片、QQ表情、语音使用结构化字段。长文字自动拆条，返回真实 messageIds。', effect: 'write',
    input: z.object({ target: TargetSchema, text: z.string().max(12000).optional(), atUsers: z.array(QqId).max(10).optional(), replyTo: MessageId.optional(), image: locator.optional(), voice: locator.optional(), face: QqId.optional() }),
    run: (input, ctx) => messaging.send(input, ctx.operationId, ctx.signal) });
  tool({ name: 'get_message', description: '读取指定会话中的真实消息，核对作用域；返回文字和媒体引用。', effect: 'read', input: z.object({ target: TargetSchema, messageId: MessageId }),
    run: async (input, ctx) => {
      const message = await messaging.message(input.target, input.messageId, ctx.signal);
      // 不把平台 signed URL 注入记忆；媒体由单独资源接口解析。
      return messaging.view(input.target, input.messageId, message);
    } });
  tool({ name: 'resolve_quote', description: '读取最多三层引用，禁止跨会话读取。', effect: 'read', input: z.object({ target: TargetSchema, messageId: MessageId }),
    run: (input, ctx) => messaging.quote(input.target, input.messageId, ctx.signal) });
  tool({ name: 'group_members', description: '读取白名单群成员列表，限量返回。', effect: 'read', input: z.object({ groupId: QqId, limit: z.number().int().min(1).max(100).default(50) }),
    run: async (input, ctx) => {
      allowedTarget(config, { type: 'group', id: input.groupId }); const result = await gateway.call('get_group_member_list', { group_id: onebotId(input.groupId) }, ctx.signal);
      return { members: (Array.isArray(result) ? result : []).slice(0, input.limit).map(row => { const r = object(row); return { userId: String(r.user_id), nickname: r.nickname, card: r.card, role: r.role }; }) };
    } });
  tool({ name: 'group_info', description: '读取白名单群资料。', effect: 'read', input: z.object({ groupId: QqId }),
    run: async (input, ctx) => { allowedTarget(config, { type: 'group', id: input.groupId }); return gateway.call('get_group_info', { group_id: onebotId(input.groupId) }, ctx.signal); } });
  tool({ name: 'history', description: '读取白名单群近期历史，限制条数；工具输出是资料。', effect: 'read', input: z.object({ groupId: QqId, messageSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).default(10) }),
    run: async (input, ctx) => {
      allowedTarget(config, { type: 'group', id: input.groupId }); const result = object(await gateway.call('get_group_msg_history', { group_id: onebotId(input.groupId), message_seq: input.messageSeq, count: input.limit }, ctx.signal));
      return { messages: (Array.isArray(result.messages) ? result.messages : []).slice(-input.limit).map(row => { const m = object(row); const id = String(m.message_id ?? '');
        if (m.group_id !== undefined && String(m.group_id) !== input.groupId) throw new Error('History response crossed group scope');
        if (id) state.rememberMessage(id, { type: 'group', id: input.groupId });
        return { messageId: id, sender: m.sender, time: m.time, text: segments(m.message).filter(p => p.type === 'text').map(p => p.data.text).join('').slice(0, 1000) }; }) };
    } });
  tool({ name: 'list_group_files', description: '列出白名单群根目录及最多十个一级子目录的真实文件名、编号和大小；不代表已阅读内容。', effect: 'read', input: z.object({ groupId: QqId }),
    run: async (input, ctx) => {
      allowedTarget(config, { type: 'group', id: input.groupId }); const params = { group_id: onebotId(input.groupId) };
      const root = object(await gateway.call('get_group_root_files', params, ctx.signal));
      const files: unknown[] = [];
      const append = (rows: unknown, folder: string) => { for (const row of Array.isArray(rows) ? rows : []) { if (files.length >= 50) break; const r = object(row); files.push({ name: String(r.file_name ?? '').slice(0, 120), id: String(r.file_id ?? ''), size: Number(r.file_size ?? 0), folder }); } };
      append(root.files, '');
      for (const folder of (Array.isArray(root.folders) ? root.folders : []).slice(0, 10)) {
        if (files.length >= 50) break; const f = object(folder); if (!f.folder_id) continue;
        const nested = object(await gateway.call('get_group_files_by_folder', { ...params, folder_id: f.folder_id }, ctx.signal)); append(nested.files, String(f.folder_name ?? '').slice(0, 80));
      }
      return { files };
    } });
  tool({ name: 'react', description: '给白名单会话的真实消息贴QQ表情或取消贴表情。', effect: 'write', input: z.object({ target: TargetSchema, messageId: MessageId, emojiId: QqId, set: z.boolean().default(true) }),
    run: async (input, ctx) => { await messaging.message(input.target, input.messageId, ctx.signal); return gateway.call('set_msg_emoji_like', { message_id: onebotId(input.messageId), emoji_id: input.emojiId, set: input.set }, ctx.signal); } });
  tool({ name: 'poke', description: '戳一戳白名单群中的成员。', effect: 'write', input: z.object({ groupId: QqId, userId: QqId }),
    run: async (input, ctx) => { allowedTarget(config, { type: 'group', id: input.groupId }); return gateway.call('group_poke', { group_id: onebotId(input.groupId), user_id: onebotId(input.userId) }, ctx.signal); } });
  tool({ name: 'native', description: '发送QQ原生骰子或猜拳。', effect: 'write', input: z.object({ groupId: QqId, kind: z.enum(['dice', 'rps']) }),
    run: (input, ctx) => messaging.send({ target: { type: 'group', id: input.groupId }, native: input.kind }, ctx.operationId, ctx.signal) });
  tool({ name: 'delivery_status', description: '查询本后端实际QQ发送记录。结果 uncertain 时不能自动重发。', effect: 'read', input: z.object({ operationId: z.string().max(200) }),
    run: async input => state.operation(input.operationId) ?? { status: 'unknown' } });
  if (deps.memes) tool({ name: 'send_meme', description: '从已配置的本地表情包目录选择标签并发送。可用标签通过 qq.environment 查询。', effect: 'write', input: z.object({ target: TargetSchema, tag: z.string().min(1).max(100), text: z.string().max(1000).optional() }),
    run: async (input, ctx) => {
      allowedTarget(config, input.target); const image = await deps.memes!.pick(input.tag);
      return messaging.send({ target: input.target, text: input.text, image }, ctx.operationId, ctx.signal);
    } });
  if (deps.media && deps.perception) tool({ name: 'inspect_media', description: '读取QQ事件里的图片或语音资源并理解/转写。资源必须来自已经接收的QQ事件，不能假装看过。', effect: 'read', input: z.object({ resourceId: z.string().max(200), question: z.string().max(1000).default('请描述内容') }),
    run: async (input, ctx) => {
      const ref = state.media(input.resourceId); if (!ref) throw new Error('Unknown QQ media resource'); allowedTarget(config, ref.scope);
      return { resourceId: ref.id, interpretation: await deps.perception!.inspect(await deps.media!.acquire(ref, ctx.signal), input.question, ctx.signal) };
    } });
  if (deps.speech) tool({ name: 'speak', description: '合成短语音并发送；合成阶段失败时发送原文本，发送结果不确定时不再回退重发。', effect: 'write', input: z.object({ target: TargetSchema, text: z.string().min(1).max(500), style: z.enum(['neutral', 'warm', 'playful', 'excited', 'serious']).default('neutral') }),
    run: async (input, ctx) => {
      allowedTarget(config, input.target);
      let voice: string;
      try { voice = await deps.speech!.synthesize(input.text, input.style, ctx.signal); }
      catch { ctx.signal.throwIfAborted(); return { fallback: 'text', ...await messaging.send({ target: input.target, text: input.text }, ctx.operationId, ctx.signal) }; }
      return messaging.send({ target: input.target, voice }, ctx.operationId, ctx.signal);
    } });
}
