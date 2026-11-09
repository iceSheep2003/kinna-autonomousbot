import { authorizeQqScene } from './scope.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CapabilityRegistrar } from '../../capabilities/ports.js';
import type { OneBotPort, QqState } from './ports.js';
import type { QqConfig, QqEvent, TitleProposal } from './types.js';
import { QqId, MessageId } from './types.js';
import { allowedTarget } from './events.js';
import { object, oncePlatform, onebotId, QqMessaging } from './messaging.js';

export interface AdministrationDependencies {
  config: QqConfig;
  gateway: OneBotPort;
  state: QqState;
  messaging: QqMessaging;
  clock: () => number;
}

/** 管理类工具声明；effect 默认是写操作。 */
interface AdminSpec<T> {
  name: string; description: string; input: z.ZodType<T>; effect?: 'read' | 'write';
  run: (input: T, context: { operationId: string; signal: AbortSignal }) => Promise<unknown>;
}

export class QqAdministration {
  private readonly config: QqConfig;
  private readonly gateway: OneBotPort;
  private readonly state: QqState;
  private readonly messaging: QqMessaging;
  private readonly clock: () => number;
  constructor(deps: AdministrationDependencies) {
    this.config = deps.config; this.gateway = deps.gateway; this.state = deps.state;
    this.messaging = deps.messaging; this.clock = deps.clock;
  }
  private operator(eventId: string): QqEvent {
    const event = this.state.event(eventId);
    if (!event?.groupId || !this.config.operatorIds.includes(event.userId) || this.clock() - event.receivedAt > this.config.operatorEventTtlMs || event.kind !== 'qq.message') throw new Error('A recent authentic operator event is required');
    allowedTarget(this.config, { type: 'group', id: event.groupId }); return event;
  }
  register(registry: CapabilityRegistrar) {
    const register = <T>(spec: AdminSpec<T>) => registry.register({ name: `qq.${spec.name}`, description: spec.description, effect: spec.effect ?? 'write', input: spec.input,
      authorize: (input, scope) => authorizeQqScene(input, scope, this.state), run: (raw, ctx) => spec.run(spec.input.parse(raw), ctx) });
    register({ name: 'mute_member', description: '禁言/解禁群成员。必须引用近期真实 operator 事件，且只执行其中明确请求的目标和时长，不可猜测。',
      input: z.object({ eventId: z.string().max(120), userId: QqId, duration: z.number().int().min(0).max(this.config.maxMuteSeconds) }),
      run: async (input, { signal }) => {
        const event = this.operator(input.eventId); const group_id = onebotId(event.groupId!); const user_id = onebotId(input.userId);
        const member = object(await this.gateway.call('get_group_member_info', { group_id, user_id, no_cache: true }, signal));
        if (['owner', 'admin'].includes(String(member.role))) throw new Error('Cannot mute group owner or admin');
        return this.gateway.call('set_group_ban', { group_id, user_id, duration: input.duration }, signal);
      } });
    register({ name: 'set_essence', description: '按真实 operator 的明确要求设置/取消精华，只接受当前消息或明确引用的消息。',
      input: z.object({ eventId: z.string().max(120), messageId: MessageId, enable: z.boolean() }),
      run: async (input, { signal }) => {
        const event = this.operator(input.eventId);
        if (![event.messageId, event.replyTo].includes(input.messageId)) throw new Error('Only current or quoted message may be changed');
        await this.messaging.message({ type: 'group', id: event.groupId! }, input.messageId, signal);
        return this.gateway.call(input.enable ? 'set_essence_msg' : 'delete_essence_msg', { message_id: onebotId(input.messageId) }, signal);
      } });
    register({ name: 'review_join', description: '审核已收到的真实入群申请。手动决定必须同时引用同群近期 operator 消息；不能伪造申请 flag。',
      input: z.object({ requestEventId: z.string().max(120), operatorEventId: z.string().max(120), approve: z.boolean(), reason: z.string().max(100).default('') }),
      run: async (input, { signal }) => {
        const operator = this.operator(input.operatorEventId); const request = this.state.event(input.requestEventId);
        if (!request?.flag || request.kind !== 'qq.group' || request.groupId !== operator.groupId) throw new Error('Unknown or mismatched group join request');
        return oncePlatform(this.state, `join:${request.id}`, 'join.review', () => this.gateway.call('set_group_add_request', { flag: request.flag, sub_type: request.subType || 'add', approve: input.approve, reason: input.reason }, signal));
      } });
    register({ name: 'propose_title', description: '提出群头衔并征求同意，不会立即授予。invitation 必须含头衔和“同意头衔”“拒绝头衔”“赞成头衔”，投票必须引用此消息。',
      input: z.object({ groupId: QqId, userId: QqId, title: z.string().min(1).max(6).regex(/^[^\[\]{}<>/\\\r\n]+$/), reason: z.string().min(1).max(100), invitation: z.string().min(1).max(500) }),
      run: async (input, { operationId, signal }) => this.proposeTitle(input, operationId, signal) });
    register({ name: 'title_status', description: '读取群头衔提案真实状态。', effect: 'read', input: z.object({ groupId: QqId }),
      run: async input => { allowedTarget(this.config, { type: 'group', id: input.groupId }); return this.state.proposal(input.groupId) ?? { status: 'none' }; } });
  }
  private async proposeTitle(input: { groupId: string; userId: string; title: string; reason: string; invitation: string }, operationId: string, signal: AbortSignal): Promise<unknown> {
    if (!this.config.titleEnabled) throw new Error('Title proposals are disabled');
    allowedTarget(this.config, { type: 'group', id: input.groupId });
    if (input.userId === this.config.selfId || !['同意头衔', '拒绝头衔', '赞成头衔', input.title].every(word => input.invitation.includes(word))) throw new Error('Title invitation is missing consent instructions');
    const existing = this.state.proposal(input.groupId);
    if (existing && existing.expiresAt > this.clock() && ['proposed', 'awaiting_consent', 'executing', 'uncertain'].includes(existing.status)) throw new Error('Group already has a pending title proposal');
    await this.gateway.call('get_group_member_info', { group_id: onebotId(input.groupId), user_id: onebotId(input.userId), no_cache: true }, signal);
    const proposal = { id: randomUUID(), groupId: input.groupId, userId: input.userId, title: input.title, reason: input.reason,
      expiresAt: this.clock() + this.config.titleExpiresMs, voters: [] as string[], status: 'proposed' as const };
    this.state.saveProposal(proposal);
    try {
      const receipt = await this.messaging.send({ target: { type: 'group', id: input.groupId }, atUsers: [input.userId], text: input.invitation }, operationId, signal);
      const promptMessageId = receipt.messageIds[0];
      this.state.saveProposal({ ...proposal, status: 'awaiting_consent', promptMessageId });
      return { proposalId: proposal.id, promptMessageId, status: 'awaiting_consent' };
    } catch (error) { this.state.saveProposal({ ...proposal, status: 'uncertain' }); throw error; }
  }
  /** 此处只落实收到的明确同意/投票和本地入群规则；新方向仍由 self 决定。 */
  async observe(event: QqEvent): Promise<unknown | undefined> {
    if (!event.groupId) return;
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs);
    if (event.flag && event.kind === 'qq.group' && this.config.joinReviewEnabled) return this.reviewJoin(event, signal);
    if (event.kind !== 'qq.message') return;
    return this.handleTitleReply(event, signal);
  }
  private async reviewJoin(event: QqEvent, signal: AbortSignal): Promise<unknown> {
    const comment = event.comment ?? '';
    const reject = this.config.joinRejectKeywords.some(word => comment.includes(word));
    const approve = this.config.joinApproveKeywords.some(word => comment.includes(word));
    if (!reject && !approve) return { status: 'pending', reason: 'No local review rule matched' };
    await oncePlatform(this.state, `join:${event.id}`, 'join.review', () => this.gateway.call('set_group_add_request', { flag: event.flag, sub_type: event.subType || 'add', approve: approve && !reject, reason: reject ? '申请信息未通过本地审核规则' : '' }, signal));
    return { status: 'reviewed', approve: approve && !reject };
  }
  private async handleTitleReply(event: QqEvent, signal: AbortSignal): Promise<unknown> {
    const proposal = this.state.proposal(event.groupId!);
    if (!proposal || proposal.status !== 'awaiting_consent') return;
    if (proposal.expiresAt <= this.clock()) { this.state.saveProposal({ ...proposal, status: 'expired' }); return { status: 'expired' }; }
    if (!proposal.promptMessageId || event.replyTo !== proposal.promptMessageId) return;
    const vote = readVote(event, proposal);
    if (vote === 'ignore') return;
    if (vote === 'reject') { this.state.saveProposal({ ...proposal, status: 'rejected' }); return { status: 'rejected' }; }
    const voters = [...new Set([...proposal.voters, event.userId])];
    this.state.saveProposal({ ...proposal, voters });
    if (vote === 'vote' && voters.length < this.config.titleVoteThreshold) return { status: 'awaiting_consent', votes: voters.length };
    return this.grant(event, proposal, voters, signal);
  }
  private async grant(event: QqEvent, proposal: TitleProposal, voters: string[], signal: AbortSignal): Promise<unknown> {
    await this.gateway.call('get_group_member_info', { group_id: onebotId(event.groupId!), user_id: onebotId(proposal.userId), no_cache: true }, signal);
    this.state.saveProposal({ ...proposal, voters, status: 'executing' });
    try {
      await oncePlatform(this.state, `title:${proposal.id}`, 'title.grant', () => this.gateway.call('set_group_special_title', { group_id: onebotId(event.groupId!), user_id: onebotId(proposal.userId), special_title: proposal.title, duration: -1 }, signal));
      this.state.saveProposal({ ...proposal, voters, status: 'completed' }); return { status: 'completed', title: proposal.title };
    } catch { this.state.saveProposal({ ...proposal, voters, status: 'uncertain' }); return { status: 'uncertain', title: proposal.title }; }
  }
}

/** 头衔投票语义：本人可同意/拒绝，他人只能赞成。 */
function readVote(event: QqEvent, proposal: TitleProposal): 'reject' | 'consent' | 'vote' | 'ignore' {
  const text = event.text.replace(/\s/g, '');
  const owner = event.userId === proposal.userId;
  if (owner && text === '拒绝头衔') return 'reject';
  if (owner && text === '同意头衔') return 'consent';
  if (!owner && text === '赞成头衔') return 'vote';
  return 'ignore';
}
