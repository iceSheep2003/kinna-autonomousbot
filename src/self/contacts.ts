import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * 「打算找谁聊聊」。
 *
 * 这个模块存在的理由只有一条：**没有由头的主动搭话不该做**。
 * 如果只靠提示词说「要有由头」，模型会先决定要说话、再补一个理由；
 * 把由头做成**必填且够具体**的字段，就变成「想不出来理由就建不出计划」。
 */
export const MIN_BECAUSE = 10;

const Target = z.object({ type: z.enum(['group', 'private']), id: z.string().min(1).max(32) });

export const ContactPlanSchema = z.object({
  id: z.string().min(1),
  target: Target,
  /** 为什么找他。长度门槛在 planContact 里查（错误信息要能直接看懂）。 */
  because: z.string().min(1).max(300),
  /** 打算说什么、想问什么。 */
  what: z.string().min(1).max(300),
  /** 打算什么时候；不填表示「下次想起来自然有机会」。 */
  at: z.number().int().positive().optional(),
  status: z.enum(['planned', 'done', 'dropped']),
  createdAt: z.number().int().positive(),
  doneAt: z.number().int().positive().optional(),
  /** 回执：他说了/被无视/还不知道。被无视要记下来，否则会一直追着同一个人。 */
  result: z.enum(['replied', 'ignored', 'unknown']).optional(),
  note: z.string().max(300).optional(),
});
export type ContactPlan = z.infer<typeof ContactPlanSchema>;

/** 和已有计划是否算同一件事：同一个人 + 同一句话。 */
function isSame(plan: ContactPlan, input: { target: { type: string; id: string }; what: string }): boolean {
  return plan.target.type === input.target.type && plan.target.id === input.target.id
    && plan.what.trim() === input.what.trim() && plan.status === 'planned';
}

/**
 * 新建或合并一条计划。
 *
 * 合并而不是重复记：对同一个人反复记「问问他决定没有」没有意义，
 * 只会让待办越堆越乱。
 */
export function planContact(input: {
  target: { type: 'group' | 'private'; id: string };
  because: string;
  what: string;
  at?: number;
  now: number;
  existing: readonly ContactPlan[];
}): ContactPlan {
  const because = input.because.trim();
  if (because.length < MIN_BECAUSE) {
    throw new Error(`because（由头）太短或为空：至少 ${MIN_BECAUSE} 个字，说清为什么要找他`);
  }
  const duplicate = input.existing.find(plan => isSame(plan, input));
  if (duplicate !== undefined) return duplicate;
  return ContactPlanSchema.parse({
    id: `contact-${randomUUID()}`, target: input.target, because, what: input.what.trim(),
    ...(input.at === undefined ? {} : { at: input.at }),
    status: 'planned', createdAt: input.now,
  });
}

/** 标记完成。必须有结果——没结果的「完成」等于没做。 */
export function closeContact(input: {
  plan: ContactPlan; result: 'replied' | 'ignored' | 'unknown'; note: string; now: number;
}): ContactPlan {
  return ContactPlanSchema.parse({
    ...input.plan, status: 'done', result: input.result, note: input.note.trim().slice(0, 300), doneAt: input.now,
  });
}

/** 放弃：想不出由头、或者时机过了。 */
export function dropContact(input: { plan: ContactPlan; note: string; now: number }): ContactPlan {
  return ContactPlanSchema.parse({ ...input.plan, status: 'dropped', note: input.note.trim().slice(0, 300), doneAt: input.now });
}

/** 还开着的计划，最近的排前面。 */
export function pendingContacts(plans: readonly ContactPlan[], limit: number): ContactPlan[] {
  return plans.filter(plan => plan.status === 'planned')
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);
}

/**
 * 一条计划该不该继续追。
 *
 * 被无视过就不再追同一个人——这是「不会无缘无故私聊」的第二道门。
 */
export function shouldFollowUp(plans: readonly ContactPlan[], userId: string): boolean {
  return !plans.some(plan => plan.target.id === userId && plan.result === 'ignored');
}

/** 计划存哪里。接口窄到只有三个操作：读全部、存一条、按 id 捞。 */
export interface ContactStore {
  list(): ContactPlan[];
  save(plan: ContactPlan): void;
  get(id: string): ContactPlan | undefined;
}

export const CONTACT_CAP = 60;
