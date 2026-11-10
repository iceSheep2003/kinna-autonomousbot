import type { Session, SessionStore } from '../../integrations/bilibili/session.js';
import type { Store } from './database.js';

/**
 * 登录会话落库。同库同权限，没有额外加密：
 * 文件本身在数据目录里（0600），这比把 cookie 写进配置文件安全得多。
 */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Store) {}
  read(): Session | undefined { return this.db.get<Session>('bilibili.session', 'current'); }
  save(session: Session): void { this.db.put('bilibili.session', 'current', session); }
  clear(): void { this.db.db.prepare("DELETE FROM documents WHERE collection='bilibili.session' AND id='current'").run(); }
}
