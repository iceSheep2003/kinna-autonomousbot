import type { CapabilityScope } from '../../capabilities/ports.js';
import type { QqState } from './ports.js';

/** 场景会话的工具授权来自宿主 scope，模型参数不能切换到另一个群或私聊。 */
export function authorizeQqScene(input: unknown, context: CapabilityScope, state: QqState): void {
  if (context.environment !== 'qq') throw new Error('QQ capability is outside this scene');
  const expected = expectedScope(context);
  const raw = input as Record<string, unknown>;
  checkTarget(raw.target, expected);
  if (typeof raw.groupId === 'string') assertWithin(expected, 'group', raw.groupId);
  checkEvents(raw, expected, state);
  checkResource(raw, expected, state);
}

function expectedScope(context: CapabilityScope): { type: string; id: string } {
  const type = context.scope.type ?? '';
  const id = context.scope.id ?? '';
  if (!['group', 'private'].includes(type) || !id) throw new Error('Invalid QQ scene scope');
  return { type, id };
}

function assertWithin(expected: { type: string; id: string }, type: string, id: string): void {
  if (type !== expected.type || id !== expected.id) throw new Error('QQ operation crossed scene scope');
}

function checkTarget(target: unknown, expected: { type: string; id: string }): void {
  if (!target || typeof target !== 'object') return;
  const scoped = target as { type: string; id: string };
  assertWithin(expected, scoped.type, scoped.id);
}

/** 引用的事件必须属于当前场景，否则可以用别群的事件 ID 越权。 */
function checkEvents(raw: Record<string, unknown>, expected: { type: string; id: string }, state: QqState): void {
  for (const key of ['eventId', 'operatorEventId', 'requestEventId']) {
    if (typeof raw[key] !== 'string') continue;
    const event = state.event(raw[key]);
    if (!event) throw new Error('Unknown QQ scene event');
    assertWithin(expected, event.groupId ? 'group' : 'private', event.groupId ?? event.userId);
  }
}

function checkResource(raw: Record<string, unknown>, expected: { type: string; id: string }, state: QqState): void {
  if (typeof raw.resourceId !== 'string') return;
  const media = state.media(raw.resourceId);
  if (!media) throw new Error('Unknown QQ scene resource');
  assertWithin(expected, media.scope.type, media.scope.id);
}
