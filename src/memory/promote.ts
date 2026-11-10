import type { Memory } from './types.js';

/**
 * 把只属于某个场合的记忆，提到「所有场合都适用」那一层。
 *
 * 这里没有「给人审核」这一环——整套系统是自运行的，没有人坐在那里点同意。
 * 所以判断必须由模型自己做，代码只做三件事：
 *
 * 1. 告诉模型**判据**（下面这段 PROMPT 会进 Dream 的指令）；
 * 2. 执行提升（复制到 owner 层，不删原记录）；
 * 3. 防止明显的错搬（跨 bot、已经在外面的、原文里明确说「这个群」的）。
 *
 * 为什么用复制而不是移动：判断错了还能退回原场景，删除比新增难挽回得多。
 */
export const PROMOTION_PROMPT = `有些事只在一个地方成立：这个群里某人的近况、某次对话的细节。
有些事换个地方也一样：他喜欢别人怎么称呼、哪些话题别碰、他一贯的判断方式。
后者应该记在「所有场合都适用」那一层，否则你换个群就像从没认识过他。

判断标准：
- 讲的是**他的稳定偏好或看法**（「希望回答更有人味」「认为工作地点比名气重要」）→ 提到通用层
- 讲的是**一次性的安排**（「计划国庆休息 13 天」）→ 留在原处
- 讲的是**这个群里发生的事**（「这个群在聊考研」）→ 留在原处
- **边界和禁忌**（哪些话不该提）→ 几乎总是通用的，换哪个群都该守

宁可少提，不可错搬：把 A 群的事搬成通用记忆，等于在 B 群把它说出来。`;

/** 模型判断要用的那条记忆的摘要：scope 也要给它，否则它不知道这条现在挂在哪。 */
export function describeForPromotion(memory: Memory): string {
  return `[${memory.scope ?? 'owner'}] ${memory.factType ?? 'fact'} | ${memory.content.slice(0, 160)}`;
}

/**
 * 硬性拦截：这些情况不执行提升，哪怕模型要求。
 * 不是替模型判断"该不该"，而是拦住**结构上说不通**的操作。
 */
export function refusePromotion(memory: Memory | undefined, now: number): string | undefined {
  if (!memory) return '没有这条记忆';
  const scope = memory.scope ?? 'owner';
  if (scope === 'owner') return '这条已经在通用层了';
  if (scope.startsWith('bot:')) return 'bot 自己的状态不往通用层搬';
  if (memory.expiresAt !== undefined && memory.expiresAt <= now) return '这条已经过期';
  if ((memory.status ?? 'active') !== 'active') return '只提升已确认的记忆，候选池里的先留在原处';
  return undefined;
}

/**
 * 生成提升后的记录：复制到 owner 层，换 id 避免覆盖原记录。
 * `why` 由模型给出，写进 personaSummary 之外的普通字段里没有位置，
 * 所以拼进内容尾部——让下一次读到它的人知道它为什么在这里。
 */
export function buildPromotion(memory: Memory, why: string, now: number): Memory {
  const note = why.trim().slice(0, 120);
  return {
    ...memory,
    id: `${memory.id}@owner`,
    scope: 'owner',
    revision: memory.revision + 1,
    updatedAt: now,
    // 保留原 scope 信息：将来要追「这条是从哪来的」还有据可查。
    sourceEventId: memory.sourceEventId ?? `promoted-from:${memory.scope ?? 'owner'}`,
    content: note === '' ? memory.content : `${memory.content}（${note}）`.slice(0, 300),
  };
}
