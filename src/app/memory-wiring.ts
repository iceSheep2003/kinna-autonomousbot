import type { LanguageModel } from '../shared/model.js';
import type { ContextLimits } from '../shared/limits.js';
import type { Repositories } from './repositories.js';
import type { DreamFeedback, ExperienceLog, DreamLock } from '../memory/ports.js';
import { DreamService } from '../memory/dream.js';

/**
 * Dream 的装配：只收紧到「记忆 → 模型 → 反馈」这条线，不碰主体与执行。
 *
 * 单独成文件的理由和 Dream 本身的边界一致：它只拥有记忆发布权，反馈里带的
 * 机会（想做还没做的事）也只是给 self 的素材；装配放在 composeAgent 里会让
 * 那个函数超出门禁的行数上限，也会让「Dream 拿不到什么」这件事变得看不清。
 */
export interface DreamWiring {
  repositories: Repositories;
  experience: ExperienceLog;
  model: LanguageModel;
  limits: ContextLimits;
  feedback: DreamFeedback;
  lock?: DreamLock;
  opportunities?: boolean;
}

export function wireDream(input: DreamWiring): DreamService {
  return new DreamService({
    repository: input.repositories.memory,
    experience: input.experience,
    model: input.model,
    limits: input.limits,
    opportunities: input.opportunities !== false,
    feedback: input.feedback,
  });
}

