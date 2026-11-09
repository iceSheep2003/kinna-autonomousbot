/**
 * 互动反应：按「会话 + 当前发言人」隔离的短时反应。
 *
 * 对齐服务器 CONTEXTUAL_AFFECT.md：它不是对方的心理诊断、不是长期人格、
 * 也不是人物事实，**绝不写进长期记忆库**。半衰期 12 分钟、45 分钟硬过期，
 * 读取不刷新时间，新反应替换旧反应而不是无限累加；某人的不快不会归给另一个人。
 */
export const REACTION_LABELS = ['开心', '得意', '不好意思', '想打趣', '关心', '受伤', '不快', '放松', '好奇', '释然'] as const;
export type ReactionLabel = (typeof REACTION_LABELS)[number];
export const REACTION_INTENSITIES = ['slight', 'clear', 'marked'] as const;
export type ReactionIntensity = (typeof REACTION_INTENSITIES)[number];

export const REACTION_HALF_LIFE_MS = 12 * 60_000;
export const REACTION_HARD_EXPIRY_MS = 45 * 60_000;

export interface InteractionReaction {
  scope: string; userId: string; label: ReactionLabel;
  intensity: ReactionIntensity; reason: string; at: number; sourceEventId?: string;
}

/** 表达落点，不是让模型念出来的情绪标签。 */
export const REACTION_GUIDANCE: Record<ReactionLabel, string> = {
  开心: '语气可以轻一点，但别突然变得过分热络',
  得意: '可以轻轻回敬一句，别炫耀、别翻旧账',
  不好意思: '稍微停一下，允许轻轻嘴硬，不要反复解释',
  想打趣: '玩笑要轻，看关系远近，别追着同一个人连续开玩笑',
  关心: '少开玩笑，先把人接住，别急着给建议',
  受伤: '话短一点、说得明确一点，不反过来刺人，也不假装没事',
  不快: '短而明确，先关掉逗趣和多余标点，不冷暴力、不阴阳怪气',
  放松: '可以慢一点、自然一点，不必刻意找话',
  好奇: '可以多问一句，但别追问私人话题',
  释然: '把话放平，不把道歉说成宽恕对方，也不要重提责任',
};

export const INTENSITY_GUIDANCE: Record<ReactionIntensity, string> = {
  slight: '很轻微', clear: '比较清楚', marked: '很明显',
};

/** 0..1 的余韵权重；硬过期后一律 0，不会因反复读取而复活。 */
export function reactionWeight(reaction: InteractionReaction, now: number, halfLifeMs = REACTION_HALF_LIFE_MS): number {
  const age = now - reaction.at;
  if (age < 0 || age >= REACTION_HARD_EXPIRY_MS) return 0;
  return Math.pow(0.5, age / Math.max(halfLifeMs, 1));
}

export function isReactionFresh(reaction: InteractionReaction, now: number, halfLifeMs?: number): boolean {
  return reactionWeight(reaction, now, halfLifeMs) > 0;
}

/**
 * 只给内部上下文看的措辞。明确禁止念标签、禁止把对一个人的感觉算到全群或别人头上，
 * 也禁止把当前反应写成全群的 mood。
 */
export function narrateReaction(reaction: InteractionReaction, now: number, halfLifeMs?: number): string {
  const weight = reactionWeight(reaction, now, halfLifeMs);
  if (weight <= 0) return '';
  const strength = INTENSITY_GUIDANCE[reaction.intensity];
  return `刚才和这个人的互动还留着一点${strength}的反应：${REACTION_GUIDANCE[reaction.label]}。
这只是我对这一个人的当轮感觉，不要念出情绪名称，不要当成对方的性格或长期事实，
不要带进长期记忆，也不要写成整个群的气氛。明显的拒绝、认真或难过，优先于旧的开心余韵。`;
}
