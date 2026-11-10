import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CapabilityRegistrar } from '../capabilities/ports.js';
import { TODO_CAP, closeTodo, openTodo, openTodos, type SelfTodoStore } from './todos.js';

/**
 * 「自己记的待办」工具。
 *
 * 用法是看到/听到什么 → 记一条 → 以后翻到、有余力就做。
 * 刻意不提供「按 id 精确编辑」这类操作：人记待办不会维护字段，
 * 只会「记一条」和「做完划掉」。
 */
export function registerSelfTodoTools(registry: CapabilityRegistrar, options: { store: SelfTodoStore; now?: () => number }): void {
  const now = options.now ?? Date.now;
  const store = options.store;

  registry.register({
    name: 'self.todo_add',
    description: '看到或听到什么，让你自己想做一件事时，记一条待办：想看/想查/想弄清/想转给谁。不是别人派的活，是你自己想到的——写清由头，以后翻回来能想起为什么记它。',
    effect: 'write', input: z.object({
      text: z.string().min(1).max(300),
      source: z.string().min(1).max(200),
      reason: z.string().max(500).optional(),
    }),
    async run(raw) {
      const input = raw as { text: string; source: string; reason?: string };
      const existing = store.list(TODO_CAP);
      const { todo, duplicate } = openTodo({ ...input, now: now(), existing, id: `todo-${randomUUID()}` });
      if (!duplicate) store.save(todo);
      return { todo, duplicate };
    },
  });

  registry.register({
    name: 'self.todo_list',
    description: '翻一下自己记下的待办。醒来有空的时候看看有没有想做的事；不要为了清空清单而做。',
    effect: 'read', input: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
    async run(raw) {
      const input = raw as { limit: number };
      return { todos: openTodos(store.list(TODO_CAP), input.limit) };
    },
  });

  registry.register({
    name: 'self.todo_close',
    description: '把一条待办划掉：做完了写结果，决定不做了写原因。不许留空——记不清为什么，就说明当时没想清楚。',
    effect: 'write', input: z.object({
      id: z.string().min(1).max(64),
      outcome: z.string().min(1).max(500),
      dropped: z.boolean().default(false),
    }),
    async run(raw) {
      const input = raw as { id: string; outcome: string; dropped: boolean };
      const todo = store.get(input.id);
      if (!todo) return { ok: false, reason: '没有这条待办' };
      const next = closeTodo(todo, input.outcome, now(), input.dropped ? 'dropped' : 'done');
      if (!next) return { ok: false, reason: '这条已经关过了，或结果为空' };
      store.save(next);
      return { ok: true, todo: next };
    },
  });
}
