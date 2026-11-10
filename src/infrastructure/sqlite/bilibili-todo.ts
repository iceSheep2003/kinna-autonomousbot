import type { BilibiliTodoStore } from '../../integrations/bilibili/ports.js';
import type { TodoDay } from '../../integrations/bilibili/todo.js';
import type { Store } from './database.js';

/** 每日任务落库：一天一条文档，另存一个「上次提醒时间」防止刷屏。 */
export class SqliteTodoStore implements BilibiliTodoStore {
  constructor(private readonly db: Store) {}
  read(): TodoDay | undefined { return this.db.get<TodoDay>('bilibili.todo', this.latestId()); }
  save(day: TodoDay): void { this.db.put('bilibili.todo', day.day, day); }
  history(days: number): TodoDay[] {
    return this.db.list<TodoDay>('bilibili.todo', 200).sort((a, b) => b.day.localeCompare(a.day)).slice(0, Math.max(1, days));
  }
  lastRemindedAt(): number { return this.db.get<number>('meta', 'bilibili.todo.remindedAt') ?? 0; }
  markReminded(at: number): void { this.db.put('meta', 'bilibili.todo.remindedAt', at); }

  /** 文档表按 id 排序，日期型 id 的字典序就是时间序。 */
  private latestId(): string {
    return this.db.list<TodoDay>('bilibili.todo', 1).sort((a, b) => b.day.localeCompare(a.day))[0]?.day ?? '';
  }
}
