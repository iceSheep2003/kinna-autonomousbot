import type { SceneAffect } from '../execution/scene.js';
import { appraiseTurn } from '../subject/appraisal.js';
import type { MoodSystem } from '../subject/mood-system.js';

/**
 * 把场景的一轮对话接到情绪/好感度上。
 *
 * 这一层的职责只有“翻译”：把「对方说了什么、我怎么回」交给 appraisal 规则，
 * 再把结果分发给 mood / rapport / reaction 三个出口。判断在 appraisal，
 * 状态机在 mood-system，这里不掺任何规则。
 *
 * 为什么放在 app：它同时用到 execution 的端口和 subject 的服务，
 * 只有装配层该同时认识两边。
 */
export function createSceneAffect(deps: {
  mood: MoodSystem;
  now?: () => number;
  /** 去重键前缀：同一条消息只记一次。 */
  dedupe?: (scope: string, userId: string, now: number) => string;
}): SceneAffect {
  const now = deps.now ?? Date.now;
  return {
    observeTurn(input) {
      if (process.env.DEBUG_AFFECT) console.error('[affect] 收到', JSON.stringify({ userId: input.userId, text: input.text.slice(0, 30), reply: input.reply.slice(0, 30) }));
      if (input.userId === '') return;
      const at = input.now || now();
      const appraisal = appraiseTurn(input);
      const key = deps.dedupe?.(input.scope, input.userId, at) ?? `${input.scope}:${input.userId}:${at}`;
      // 三个出口各自幂等：同一条消息重放不会重复扣分。
      if (Object.keys(appraisal.mood.deltas).length > 0) {
        deps.mood.observeMood({ scope: input.scope, verdict: appraisal.mood, dedupeKey: `mood:${key}`, now: at });
      }
      if (appraisal.rapport !== undefined) {
        deps.mood.observeRapport({ scope: input.scope, userId: input.userId,
          delta: appraisal.rapport.delta, reason: appraisal.rapport.reason, source: 'evaluator',
          dedupeKey: `rapport:${key}`, now: at });
      }
      if (appraisal.reaction !== undefined) {
        deps.mood.observeReaction({ scope: input.scope, userId: input.userId,
          label: appraisal.reaction.label, intensity: appraisal.reaction.intensity,
          reason: appraisal.reaction.reason, dedupeKey: `reaction:${key}`, now: at });
      }
    },
    narration: scope => deps.mood.narration(scope),
  };
}
