import { z } from 'zod';

/**
 * 自己记下的待办。
 *
 * 和 bilibili 的「每日配额」不是一回事：那个是「每天要看几条」的额度，
 * 这个是我看到、听到什么之后**自己想到要做的事**——刷到个视频想弄清楚，
 * 群里有人提到个东西想去查，读到一段想转给谁看。
 *
 * 为什么单独一套而不是塞进 schedules：schedule 是「到点执行一次」，
 * 而想法往往没有确切时间，只有「想做」和「为什么想做」。先记下来，
 * 哪天翻到、正好有余力就去做，这才是人记待办的方式。
 */
export const TODO_STATUSES = ['open', 'done', 'dropped'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const SelfTodoSchema = z.object({
  id: z.string().min(1).max(64),
  /** 想做什么，一句话说清。 */
  text: z.string().min(1).max(300),
  /** 从哪来的：bilibili: BV号 / qq: 群号或人 / web: 网址 / self: 自己想的。 */
  source: z.string().max(200),
  /** 当时的由头：刷到什么、谁说了什么。以后翻回来能想起为什么记这条。 */
  reason: z.string().max(500).optional(),
  status: z.enum(TODO_STATUSES),
  createdAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().optional(),
  /** 做完时记下结果，或者放弃时记下原因。 */
  outcome: z.string().max(500).optional(),
});
export type SelfTodo = z.infer<typeof SelfTodoSchema>;

export interface SelfTodoStore {
  list(limit: number): SelfTodo[];
  save(todo: SelfTodo): void;
  get(id: string): SelfTodo | undefined;
}

/** 最多留这么多条；太多就不是「想做」而是堆垃圾。 */
export const TODO_CAP = 60;

/**
 * 开一条新待办。
 * 同一句话重复记会被当成同一条（返回已存在的），避免刷屏式自我重复。
 */
export function openTodo(input: { text: string; source: string; reason?: string; now: number; existing: readonly SelfTodo[]; id: string }): { todo: SelfTodo; duplicate: boolean } {
  const text = input.text.trim();
  const twin = input.existing.find(todo => todo.status === 'open' && sameText(todo.text, text));
  if (twin) return { todo: twin, duplicate: true };
  return {
    duplicate: false,
    todo: {
      id: input.id, text, source: input.source.slice(0, 200), status: 'open', createdAt: input.now,
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
    },
  };
}

/** 关掉一条：完成要写结果，放弃要写原因——都不许留空。 */
export function closeTodo(todo: SelfTodo, outcome: string, now: number, status: Exclude<TodoStatus, 'open'> = 'done'): SelfTodo | undefined {
  if (todo.status !== 'open') return undefined;
  const note = outcome.trim();
  if (note === '') return undefined;
  return { ...todo, status, closedAt: now, outcome: note.slice(0, 500) };
}

/** 还开着的，按记录时间排；旧的在前，免得新想法把旧的一直压下去。 */
export function openTodos(todos: readonly SelfTodo[], limit = 10): SelfTodo[] {
  return todos.filter(todo => todo.status === 'open').sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}

/**
 * 两句话是不是同一件事。不做复杂的语义判断，只比归一化后的字面：
 * 模型重复记同一件事是常见失误，字面相同就该合并。
 */
function sameText(left: string, right: string): boolean {
  const clean = (value: string): string => value.replace(/[\s，。！？、,.!?；;：:"'「」『』（）()]/g, '').toLowerCase();
  return clean(left) === clean(right);
}
