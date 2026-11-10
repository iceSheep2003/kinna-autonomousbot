import type { BilibiliTodoStore } from './ports.js';
import { BILIBILI_TODO, describeDay, localDay, remaining, rollover, type TodoDay, type TodoItem } from './todo.js';

export interface TodoBoardDeps {
  store: BilibiliTodoStore;
  /** 推给 self 的一句话（进 inbox），由应用层注入。 */
  notify: (kind: string, data: unknown, now: number) => void;
  timezone?: string;
  quota?: number;
  now?: () => number;
}

/**
 * 每日任务的看板。
 *
 * 它不决定「看哪条视频」——那是 self 在读到「今天还差几条」之后自己挑的。
 * 它只负责两件容易漏掉的事：跨日结算（昨天没做的记为 missed）与配额（最多做几条）。
 */
export class TodoBoard {
  constructor(private readonly deps: TodoBoardDeps) {}

  private time(): number { return this.deps.now?.() ?? Date.now(); }
  private timezone(): string { return this.deps.timezone ?? 'Asia/Shanghai'; }
  private quota(): number { return this.deps.quota ?? BILIBILI_TODO.quota; }
  private day(): string { return localDay(this.time(), this.timezone()); }

  /** 读今天；发现跨日就结算昨天并开新一天。返回的是结算后的今天。 */
  today(): TodoDay {
    const day = this.day();
    const current = this.deps.store.read();
    if (!current) {
      const fresh: TodoDay = { day, items: Array.from({ length: this.quota() }, (_, index) => ({ id: `${day}#${index + 1}`, status: 'pending' })) };
      this.deps.store.save(fresh);
      return fresh;
    }
    if (current.day === day) return current;
    const rolled = rollover(current, day, this.quota());
    this.deps.store.save(rolled.settled);
    this.deps.store.save(rolled.fresh);
    if (rolled.missed > 0) {
      this.deps.notify('bilibili.todo.missed', { day: current.day, missed: rolled.missed }, this.time());
    }
    return rolled.fresh;
  }

  /** 把今天还差几条放进 self 的 inbox；一小时内不重复提醒同一条。 */
  remind(): { remaining: number; sent: boolean } {
    const today = this.today();
    const left = remaining(today, this.quota());
    if (left === 0) return { remaining: 0, sent: false };
    const lastAt = this.deps.store.lastRemindedAt?.() ?? 0;
    const gap = 60 * 60_000;
    if (this.time() - lastAt < gap) return { remaining: left, sent: false };
    this.deps.store.markReminded?.(this.time());
    this.deps.notify('bilibili.todo', {
      day: today.day, quota: this.quota(), remaining: left, summary: describeDay(today, this.quota()),
      openItems: today.items.filter(item => item.status === 'pending').map(item => item.id),
    }, this.time());
    return { remaining: left, sent: true };
  }

  /** 开始做某一条：把一条 pending 绑到具体视频上。 */
  claim(bvid: string): TodoItem | undefined {
    const today = this.today();
    const item = today.items.find(entry => entry.status === 'pending');
    if (!item) return undefined;
    const next: TodoDay = { ...today, items: today.items.map(entry => entry.id === item.id ? { ...entry, bvid } : entry) };
    this.deps.store.save(next);
    return next.items.find(entry => entry.id === item.id);
  }

  /** 完成一条：必须带平台回执（评论 rpid），没有回执不算完成。 */
  complete(itemId: string, outcome: string): boolean {
    const today = this.today();
    if (!today.items.some(item => item.id === itemId && item.status === 'pending')) return false;
    if (!outcome.trim()) return false;
    this.deps.store.save({ ...today, items: today.items.map(item => item.id === itemId ? { ...item, status: 'done', outcome, at: this.time() } : item) });
    return true;
  }

  /** 主动决定不做这一条（没找到值得评论的也算）。 */
  skip(itemId: string, reason: string): boolean {
    const today = this.today();
    if (!today.items.some(item => item.id === itemId && item.status === 'pending')) return false;
    this.deps.store.save({ ...today, items: today.items.map(item => item.id === itemId ? { ...item, status: 'skipped', outcome: reason.slice(0, 300), at: this.time() } : item) });
    return true;
  }

  /** 面板：今天、昨天结算、剩余额度。 */
  view(): { today: TodoDay; quota: number; remaining: number; history: TodoDay[] } {
    const today = this.today();
    return { today, quota: this.quota(), remaining: remaining(today, this.quota()), history: this.deps.store.history(7) };
  }
}
