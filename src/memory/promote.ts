import type { Memory } from './types.js';
import { parseScope } from './scope.js';

/**
 * 「这条其实该放在通用层」的建议。
 *
 * 线上 287 条真实记忆里，**owner 层是空的**——所有记忆都挂在某个群下面。
 * 于是「用户希望回答更有人味」这种跟哪个群无关的偏好，换一个群就等于没学过。
 *
 * 但自动提升很危险：把 A 群的事搬成通用记忆，等于在 B 群泄露 A 群。
 * 所以这里只**给建议**，由人确认后才真的提升。
 *
 * 判断用启发式，会有误报——正因为如此才不能自动执行。
 */
export interface PromotionCandidate {
  memory: Memory;
  from: string;
  reason: string;
}

/** 明确只属于某个场合的说法：提到"这个群/本群/群里"就不建议提升。 */
const SCOPED_HINTS = ['这个群', '本群', '群里', '群内', '本群里', '这群'];

/**
 * 具体安排 vs 稳定偏好。
 *
 * 真实数据里的坑：「玩家计划在国庆中秋休息 13 天」被标成 preference，
 * 但它是一次性的安排，提升成通用记忆就会在别的场合被当成长期事实。
 * 所以偏好要**有观点词**才算稳定偏好；带计划/时间词的按具体安排处理。
 */
const STANCE_HINTS = ['认为', '觉得', '希望', '喜欢', '不喜欢', '讨厌', '偏好', '更愿意', '宁可', '重视'];
const PLAN_HINTS = ['计划', '打算', '准备', '今天', '明天', '昨天', '刚刚', '刚才', '上周', '下周'];

/** 提到具体某个人近况的，通常只在该场合有意义。 */
const PERSONAL_EVENT_HINTS = ['刚刚', '今天说', '昨天说', '刚才', '刚才说'];

/**
 * 挑出看起来普适的记忆。判据从强到弱：
 * 1. boundary（边界/禁忌）——「别提这件事」不分场合，最该通用；
 * 2. preference 且不带场合限定词——偏好跨场景成立；
 * 3. 其它 type 不主动建议（宁可漏，不可错搬）。
 */
export function suggestPromotions(memories: readonly Memory[], limit = 20): PromotionCandidate[] {
  const out: PromotionCandidate[] = [];
  for (const memory of memories) {
    const from = memory.scope ?? 'owner';
    // 已经是通用的不用再提
    if (from === 'owner' || !from.includes(':')) continue;
    // 只看场景层；bot 自己的状态不往 owner 搬
    const kind = parseScope(from).kind;
    if (kind === 'bot') continue;
    const reason = why(memory);
    if (reason === '') continue;
    out.push({ memory, from, reason });
    if (out.length >= limit) break;
  }
  return out;
}

/** 给出理由；空串表示不建议提升。 */
function why(memory: Memory): string {
  const text = memory.content;
  const scoped = SCOPED_HINTS.some(hint => text.includes(hint));
  const personal = PERSONAL_EVENT_HINTS.some(hint => text.includes(hint));
  if (memory.factType === 'boundary') {
    return scoped ? '' : '边界/禁忌不分场合，换一个群也应该遵守';
  }
  if (memory.factType === 'preference') {
    if (scoped || personal) return '';
    // 有观点词、且不是一次性安排，才算稳定偏好。
    const stance = STANCE_HINTS.some(hint => text.includes(hint));
    const plan = PLAN_HINTS.some(hint => text.includes(hint));
    if (plan || !stance) return '';
    return '这是稳定的偏好/看法，跨场合都成立，不该只在遇到它的地方才算数';
  }
  return '';
}

/**
 * 应用提升：把选中的记忆复制到 owner 层（保留原记录）。
 *
 * **不删除原记录**：万一判断错了，原场景里还有一份；
 * 删除要比新增难挽回得多。
 */
export function applyPromotion(memory: Memory, now: number): Memory {
  return { ...memory, id: `${memory.id}@owner`, scope: 'owner', revision: memory.revision + 1, updatedAt: now };
}
