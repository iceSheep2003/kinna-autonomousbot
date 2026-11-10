import { z } from 'zod';
import type { CapabilityRegistrar } from '../capabilities/ports.js';
import { CONTACT_CAP, closeContact, dropContact, pendingContacts, planContact, type ContactStore } from './contacts.js';

/**
 * 「打算找谁聊聊」的工具。
 *
 * 三个动作对应三件事：想做什么（plan）、做完了什么结果（done）、还有哪些没做（list）。
 * 刻意不做「修改计划」——人会改主意，但不会去维护一条计划的所有字段，
 * 不合适就 drop 掉重新起一条。
 */
export function registerContactTools(registry: CapabilityRegistrar, options: { store: ContactStore; now?: () => number }): void {
  const now = options.now ?? Date.now;
  const store = options.store;

  registry.register({
    name: 'self.contact_plan',
    description: '想主动找某个人说话之前，先记一条计划：为什么找他（because，必须具体，写不出理由就别建）、打算说什么（what）、什么时候（at，可省）。'
      + '没有由头的主动搭话不该做——写不出具体由头，就说明现在还不该打扰他。',
    effect: 'write', input: z.object({
      target: z.object({ type: z.enum(['group', 'private']), id: z.string().min(1).max(32) }),
      because: z.string().min(10).max(300),
      what: z.string().min(1).max(300),
      at: z.number().int().positive().optional(),
    }),
    async run(raw) {
      const input = raw as { target: { type: 'group' | 'private'; id: string }; because: string; what: string; at?: number };
      const existing = store.list().slice(-CONTACT_CAP);
      const plan = planContact({ ...input, now: now(), existing });
      store.save(plan);
      return { plan, duplicate: existing.some(item => item.id === plan.id) };
    },
  });

  registry.register({
    name: 'self.contact_done',
    description: '联系过之后标记结果：他说了（replied）、被无视（ignored）、还不知道（unknown）。'
      + '**被无视要如实记**——记下来才不会一直追同一个人。',
    effect: 'write', input: z.object({
      id: z.string().min(1).max(80),
      result: z.enum(['replied', 'ignored', 'unknown']),
      note: z.string().max(300).default(''),
    }),
    async run(raw) {
      const input = raw as { id: string; result: 'replied' | 'ignored' | 'unknown'; note: string };
      const plan = store.get(input.id);
      if (plan === undefined) throw new Error(`没有这条联系计划：${input.id}`);
      const closed = closeContact({ plan, result: input.result, note: input.note, now: now() });
      store.save(closed);
      return { plan: closed };
    },
  });

  registry.register({
    name: 'self.contact_drop',
    description: '放弃一条联系计划：时机过了、由头不成立了、或者觉得自己想多了。写一句为什么放弃。',
    effect: 'write', input: z.object({ id: z.string().min(1).max(80), note: z.string().max(300).default('') }),
    async run(raw) {
      const input = raw as { id: string; note: string };
      const plan = store.get(input.id);
      if (plan === undefined) throw new Error(`没有这条联系计划：${input.id}`);
      const dropped = dropContact({ plan, note: input.note, now: now() });
      store.save(dropped);
      return { plan: dropped };
    },
  });

  registry.register({
    name: 'self.contact_list',
    description: '看还有哪些没做的联系计划。醒来有空时看一眼——不是为了清空清单，是有由头才做。',
    effect: 'read', input: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    async run(raw) {
      const input = raw as { limit: number };
      return { plans: pendingContacts(store.list(), input.limit) };
    },
  });
}
