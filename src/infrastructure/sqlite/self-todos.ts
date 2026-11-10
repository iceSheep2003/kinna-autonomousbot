import type { SelfTodo, SelfTodoStore } from '../../self/todos.js';
import { TODO_CAP } from '../../self/todos.js';
import type { Store } from './database.js';

/** 自己记的待办落库。一条一个文档，按创建时间取最近的。 */
export class SqliteSelfTodoStore implements SelfTodoStore {
  constructor(private readonly db: Store) {}
  get(id: string): SelfTodo | undefined { return this.db.get<SelfTodo>('self.todos', id); }
  save(todo: SelfTodo): void { this.db.put('self.todos', todo.id, todo); }
  list(limit: number): SelfTodo[] {
    return this.db.list<SelfTodo>('self.todos', TODO_CAP)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-Math.max(1, limit));
  }
}
