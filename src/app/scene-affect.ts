import type { SceneAffect } from '../execution/scene.js';
import { appraiseTurn, shouldRemember } from '../subject/appraisal.js';
import type { MemoryView } from '../memory/ports.js';
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
interface SceneAffectDependencies {
  mood: MoodSystem;
  memory?: Pick<MemoryView, 'observe'>;
  now?: () => number;
  dedupe?: (scope: string, userId: string, now: number) => string;
}

export function createSceneAffect(deps: {
  mood: MoodSystem;
  /** 记忆写入口；不传就不写（情绪本身仍然工作）。 */
  memory?: Pick<MemoryView, 'observe'>;
  now?: () => number;
  /** 去重键前缀：同一条消息只记一次。 */
  dedupe?: (scope: string, userId: string, now: number) => string;
}): SceneAffect {
  const now = deps.now ?? Date.now;
  return {
    observeTurn(input) {
      if (input.userId === '') return;
      const at = input.now || now();
      const key = deps.dedupe?.(input.scope, input.userId, at) ?? `${input.scope}:${input.userId}:${at}`;
      record(deps, { scope: input.scope, userId: input.userId, appraisal: appraiseTurn(input), key, at });
    },
    narration: scope => deps.mood.narration(scope),
  };
}

/** 把一次评价分发给三个出口。各自幂等：同一条消息重放不会重复扣分。 */
interface TurnContext { scope: string; userId: string; appraisal: ReturnType<typeof appraiseTurn>; key: string; at: number }

function record(deps: SceneAffectDependencies, turn: TurnContext): void {
  const { appraisal, key, at } = turn;
  if (Object.keys(appraisal.mood.deltas).length > 0) {
    deps.mood.observeMood({ scope: turn.scope, verdict: appraisal.mood, dedupeKey: `mood:${key}`, now: at });
  }
  if (appraisal.rapport !== undefined) {
    deps.mood.observeRapport({ scope: turn.scope, userId: turn.userId,
      delta: appraisal.rapport.delta, reason: appraisal.rapport.reason, source: 'evaluator',
      dedupeKey: `rapport:${key}`, now: at });
  }
  rememberEvent(deps, turn);
  if (appraisal.reaction !== undefined) {
    deps.mood.observeReaction({ scope: turn.scope, userId: turn.userId,
      label: appraisal.reaction.label, intensity: appraisal.reaction.intensity,
      reason: appraisal.reaction.reason, dedupeKey: `reaction:${key}`, now: at });
  }
}

/**
 * 显著的情绪事件变成「关于这个人的记忆」，下次跟他说话时能被召回。
 *
 * 只有 valence/stress 的明显变化才写（见 shouldRemember），否则记忆全是噪声。
 */
function rememberEvent(deps: SceneAffectDependencies, turn: TurnContext): void {
  const { appraisal } = turn;
  if (deps.memory?.observe === undefined || !shouldRemember(appraisal.mood)) return;
  deps.memory.observe({
    content: `${appraisal.mood.reason}（${(appraisal.mood.deltas.valence ?? 0) < 0 ? '不太舒服' : '还不错'}）`.slice(0, 200),
    subjectUserId: turn.userId, scope: turn.scope,
    personaSummary: '', mentionPolicy: 'soft_echo', supersedes: false,
    kind: 'observation', factType: 'fact', importance: 3, confidence: 0.8,
    visibility: 'personal', evidence: [],
  }, turn.at);
}
