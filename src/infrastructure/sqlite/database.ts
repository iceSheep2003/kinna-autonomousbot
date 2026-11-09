import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Experience } from '../../memory/types.js';
import type { Job } from '../../runtime/types.js';

/** 单进程 SQLite 事务仓库。没有在事务内跨 await；worker 与 HTTP 共用此连接。 */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS experience (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS experience_source ON experience(source,seq);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dueAt INTEGER NOT NULL, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active ON jobs(key) WHERE status IN ('pending','running');
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,dueAt);
      CREATE TABLE IF NOT EXISTS turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(session,seq);
      CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS model_calls (at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, untilAt INTEGER NOT NULL);
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM documents WHERE collection=? AND id=?').get(collection, id);
    return row ? JSON.parse(row.body as string) as T : undefined;
  }
  put(collection: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body').run(collection, id, JSON.stringify(value));
  }
  list<T>(collection: string, limit = 100, offset = 0): T[] {
    return this.db.prepare('SELECT body FROM documents WHERE collection=? ORDER BY id LIMIT ? OFFSET ?').all(collection, limit, offset).map(row => JSON.parse(row.body as string) as T);
  }
  query<T>(collection: string, predicate: string, args: (string | number)[], limit = 30): T[] {
    // predicate 是内部代码中的固定 SQL，不接受 HTTP 或 LLM 的 SQL。
    return this.db.prepare(`SELECT body FROM documents WHERE collection=? AND ${predicate} LIMIT ?`).all(collection, ...args, limit).map(row => JSON.parse(row.body as string) as T);
  }
  record(source: string, kind: string, data: unknown, now: number): number {
    return Number(this.db.prepare('INSERT INTO experience(at,source,kind,data) VALUES (?,?,?,?)').run(now, source, kind, JSON.stringify(data)).lastInsertRowid);
  }
  experiences(after = 0, limit = 60, source?: string): Experience[] {
    const rows = source
      ? this.db.prepare('SELECT * FROM experience WHERE seq>? AND source=? ORDER BY seq LIMIT ?').all(after, source, limit)
      : this.db.prepare('SELECT * FROM experience WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    return rows.map(row => ({ ...row, data: JSON.parse(row.data as string) }) as unknown as Experience);
  }
  latestSequence(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM experience').get()!.n); }
  recentExperiences(source: string, limit = 20): Experience[] {
    return this.db.prepare('SELECT * FROM experience WHERE source=? ORDER BY seq DESC LIMIT ?').all(source, limit).reverse()
      .map(row => ({ ...row, data: JSON.parse(row.data as string) }) as unknown as Experience);
  }
  hasEvidence(seq: number): boolean { return !!this.db.prepare('SELECT 1 FROM experience WHERE seq=?').get(seq); }
  appendTurn(session: string, turn: unknown): void { this.db.prepare('INSERT INTO turns(session,body) VALUES (?,?)').run(session, JSON.stringify(turn)); }
  turns(session: string, limit = 6): unknown[] {
    return this.db.prepare('SELECT body FROM turns WHERE session=? ORDER BY seq DESC LIMIT ?').all(session, limit).reverse().map(row => JSON.parse(row.body as string));
  }
  enqueue(kind: Job['kind'], key: string, payload: Record<string, unknown>, now: number): string {
    const existing = this.db.prepare("SELECT id FROM jobs WHERE key=? AND status IN ('pending','running')").get(key);
    if (existing) return existing.id as string;
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs(id,kind,key,payload,status,dueAt) VALUES (?,?,?,?,'pending',?)").run(id, kind, key, JSON.stringify(payload), now);
    return id;
  }
  pendingCount(): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").get()!.n); }
  claim(now: number): Job | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND dueAt<=? ORDER BY dueAt,rowid LIMIT 1").get(now);
      if (!row) return;
      this.db.prepare("UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=?").run(row.id!);
      return { ...row, payload: JSON.parse(row.payload as string), status: 'running', attempts: Number(row.attempts) + 1 } as Job;
    });
  }
  finish(id: string): void { this.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id); }
  retry(job: Job, error: string, now: number): void {
    this.db.prepare('UPDATE jobs SET status=?,error=?,dueAt=? WHERE id=?').run(job.attempts >= 3 ? 'failed' : 'pending', error, now + 1000 * 2 ** job.attempts, job.id);
  }
  recover(): void { this.db.exec("UPDATE jobs SET status='pending' WHERE status='running'"); }
  reserveCall(now: number, max: number): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM model_calls WHERE at<?').run(now - 3600000);
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()!.n) >= max) return false;
      this.db.prepare('INSERT INTO model_calls VALUES (?)').run(now); return true;
    });
  }
  acquireLease(owner: string, now: number): boolean {
    const result = this.db.prepare(`INSERT INTO leases VALUES ('runtime',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,untilAt=excluded.untilAt WHERE leases.untilAt<? OR leases.owner=?`).run(owner, now + 120000, now, owner);
    return result.changes === 1;
  }
  releaseLease(owner: string): void { this.db.prepare('DELETE FROM leases WHERE owner=?').run(owner); }
  close(): void { this.db.close(); }
}
