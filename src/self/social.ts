import { z } from 'zod';

/**
 * 社交圈：self 主动找人之前必须知道的事。
 *
 * 只给三样东西——**有哪些群、能私聊谁、现在合不合适**。
 * 不给名录细节（那是 people 卡片的事），也不给群成员列表（几百人列不完）。
 *
 * 为什么要有 `proactivePermitted`：心情差的时候不该主动开口。
 * 这条判断来自 mood 的 `permitsProactive`，不在 self 这里算——
 * 否则它得自己读数值，而数字一律不进提示词。
 */
export const SocialContextSchema = z.object({
  groups: z.array(z.object({ id: z.string().max(32), name: z.string().max(60).optional() })).max(20),
  privateAllowed: z.array(z.string().max(32)).max(20),
  proactivePermitted: z.boolean(),
});
export type SocialContext = z.infer<typeof SocialContextSchema>;

/**
 * 渲染成一句人话。
 *
 * 不允许时要说清「不太想说话」，而不是让模型自己从一堆 id 里推断——
 * 它推断不出来，就会照常主动搭话，那正是「无缘无故私聊」的由来。
 */
export function socialLine(social: SocialContext): string {
  const groups = social.groups.map(group => (group.name === undefined ? `群${group.id}` : `${group.name}(${group.id})`));
  const parts: string[] = [];
  if (groups.length > 0) parts.push(`能说话的群：${groups.join('、')}`);
  if (social.privateAllowed.length > 0) parts.push(`能私聊的人：${social.privateAllowed.join('、')}`);
  if (parts.length === 0) parts.push('现在没有可以主动联系的对象');
  parts.push(social.proactivePermitted
    ? '这会儿可以主动开口。'
    : '这会儿不太想说话，先别主动找人——等心情回来再说。');
  return parts.join('；');
}
