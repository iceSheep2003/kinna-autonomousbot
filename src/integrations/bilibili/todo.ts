import { z } from 'zod';

/**
 * B 站日常任务（todo）。
 *
 * 为什么不用 schedules 表达「每天看三条」：schedules 是「到点触发一次」的定时器，
 * 它记不住「今天做了几条」；而 todo 要回答的是「今天还差几条」「昨天为什么没做完」。
 * 两者互补：todo 是意图与配额，schedules 是具体的执行时刻。
 *
 * 状态只在「做了什么」上推进，不看时间流逝：
 * - pending → done：完成了一次（视频：提交了一条真实评论）
 * - pending → skipped：今天决定不做（比如没找到值得评论的）
 * - 过期未做 → missed：第二天结算时记账，不是失败
 */
export const BILIBILI_TODO = {
  id: 'bilibili.daily',
  title: '每天看三条视频并评论',
  /** 每天要完成的条数。 */
  quota: 3,
  /** 一小时内的检查次数上限；防止空转。 */
  maxChecksPerDay: 12,
} as const;

export const TodoItemSchema = z.object({
  /** 这一条的标识：日期 + 序号，例如 2026-11-10#2。 */
  id: z.string().min(1).max(64),
  /** 这一条关谁：一条视频。 */
  bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/).optional(),
  status: z.enum(['pending', 'done', 'skipped', 'missed']),
  /** done 时记下平台回执（评论 rpid），skipped/missed 时记原因。 */
  outcome: z.string().max(300).optional(),
  at: z.number().int().nonnegative().optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface TodoDay {
  /** 本地日期 YYYY-MM-DD，按这个日期算「今天」。 */
  day: string;
  items: TodoItem[];
}

/** 按本地时区取日期；跨日靠这个，而不是 UTC，否则北京时间早上 8 点前都算前一天。 */
export function localDay(now: number, timezone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** 今天还剩几条要做；已跳过的不占额度（主动决定不做也是一种完成）。 */
export function remaining(today: TodoDay, quota: number = BILIBILI_TODO.quota): number {
  const done = today.items.filter(item => item.status === 'done').length;
  const skipped = today.items.filter(item => item.status === 'skipped').length;
  return Math.max(0, quota - done - skipped);
}

/** 可以继续用的条目：还没结果的；已经 done 的不能重复用。 */
export function openItem(today: TodoDay): TodoItem | undefined {
  return today.items.find(item => item.status === 'pending');
}

/**
 * 该不该现在提醒去做了。返回 undefined 表示不用行动。
 * 原则：只说一次、不催命——pending 还在就交给 self 自己决定节奏，
 * 这里只在「还没开始」时放行一条 open 条目。
 */
export function nextAction(today: TodoDay, quota: number = BILIBILI_TODO.quota): { kind: 'open'; itemId: string } | { kind: 'finished' } | { kind: 'wait' } {
  const left = remaining(today, quota);
  if (left === 0) return { kind: 'finished' };
  const item = openItem(today);
  return item ? { kind: 'open', itemId: item.id } : { kind: 'wait' };
}

/** 结算：把昨天还在 pending 的条目记为 missed，并把今天初始化成 quota 条 pending。 */
export function rollover(today: TodoDay, nextDay: string, quota: number = BILIBILI_TODO.quota): { settled: TodoDay; fresh: TodoDay; missed: number } {
  const missed = today.items.filter(item => item.status === 'pending').length;
  return {
    settled: { day: today.day, items: today.items.map(item => item.status === 'pending' ? { ...item, status: 'missed' as const } : item) },
    fresh: { day: nextDay, items: Array.from({ length: quota }, (_, index) => ({ id: `${nextDay}#${index + 1}`, status: 'pending' as const })) },
    missed,
  };
}

/** 给 self 看的一句话：今天还差几条。语气是提醒不是催促。 */
export function describeDay(today: TodoDay, quota: number = BILIBILI_TODO.quota): string {
  if (!today.items.length) return '';
  const done = today.items.filter(item => item.status === 'done');
  const left = remaining(today, quota);
  const head = `今天在 B 站看到 ${done.length} 条、评论过 ${done.length} 次，还差 ${left} 条`;
  return left === 0 ? `${head}，今天的份做完了。` : `${head}。`;
}
