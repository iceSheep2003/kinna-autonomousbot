import type { Experience } from './types.js';

/**
 * 什么算「我经历过的一件事」。
 *
 * 经验日志里混着两类东西：外部世界发生的事、以及系统自己运转的流水
 * （门控检查、作业报错、调度心跳、工具回执）。只有前者是主体的经历。
 *
 * 把流水也交给模型，它就会把「研究自己的运行时」当成生活——实测里
 * agent 反复琢磨门控为什么拦它、job.error 分几类，却一个人都没记住。
 * 这不是模型跑偏，是给它看错了东西。
 *
 * 门控（该不该回想）与 Dream（回想什么）共用这一个判定，
 * 保证「为什么触发」和「看到什么」是同一套素材。
 *
 * 用白名单而非黑名单：以后新加的运行时流水默认不进主体记忆，
 * 要让它进来必须显式登记，避免系统实现细节慢慢渗进人格。
 */
const LIVED_SOURCES = new Set(['world', 'user']);

/** 明确的机器流水：无论 source 标成什么，都不算经历过的事。 */
const INTERNAL_KINDS = /^(job\.|dream\.|schedule\.|worker\.|runtime\.|execution\.|scene\.|tool\.|goal\.|turn\.|self\.decision)/;

/** 自己写下的纸条、自己的反思与感受、别人说过的话、以及记忆缺口。 */
const LIVED_KINDS = [
  /^note\./,
  /\.message$/,
  /\.item$/,
  /^group\./,
  /^reflection$/,
  /^affect\.appraisal$/,
  /^memory\.miss$/,
  /^feedback\.correction$/,
];

export function isLived(experience: Experience): boolean {
  if (INTERNAL_KINDS.test(experience.kind)) return false;
  if (LIVED_SOURCES.has(experience.source)) return true;
  return LIVED_KINDS.some(pattern => pattern.test(experience.kind));
}

export function lived(experiences: Experience[]): Experience[] {
  return experiences.filter(isLived);
}
