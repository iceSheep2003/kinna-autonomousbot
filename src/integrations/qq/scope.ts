import type { CapabilityScope } from '../../capabilities/ports.js';
import type { QqState } from './ports.js';
/** 场景会话的工具授权来自宿主 scope，模型参数不能切换到另一个群或私聊。 */
export function authorizeQqScene(input: unknown, context: CapabilityScope, state: QqState): void {
  if (context.environment !== 'qq') throw new Error('QQ capability is outside this scene');
  const expected = context.scope;
  if (!['group', 'private'].includes(expected.type ?? '') || !expected.id) throw new Error('Invalid QQ scene scope');
  const raw = input as Record<string, unknown>;
  const check = (type: string, id: string) => { if (type !== expected.type || id !== expected.id) throw new Error('QQ operation crossed scene scope'); };
  if (raw.target && typeof raw.target === 'object') { const target = raw.target as { type: string; id: string }; check(target.type, target.id); }
  if (typeof raw.groupId === 'string') check('group', raw.groupId);
  for (const key of ['eventId', 'operatorEventId', 'requestEventId']) if (typeof raw[key] === 'string') {
    const event = state.event(raw[key]); if (!event) throw new Error('Unknown QQ scene event');
    check(event.groupId ? 'group' : 'private', event.groupId ?? event.userId);
  }
  if (typeof raw.resourceId === 'string') {
    const media = state.media(raw.resourceId); if (!media) throw new Error('Unknown QQ scene resource'); check(media.scope.type, media.scope.id);
  }
}
