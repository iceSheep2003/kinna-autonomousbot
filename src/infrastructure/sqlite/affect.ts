/**
 * 情感模块自己的三张表，和主体/记忆表互不干扰。
 *
 * 对齐服务器 emotion/store.py：mood 存最新值，mood_events 是 append-only 回放日志，
 * 幂等账本让重复投递在**这一层**也变成 no-op。claim 与状态写入放在同一个方法里，
 * 只有真正落地的评估才占用键；畸形输出、模型失败后重试仍有机会生效。
 *
 * 表在第一次读写时才惰性创建：关掉情感模块就不会为它打开任何新表。
 */
import type { AffectStore } from '../../subject/ports.js';
import type { Mood, MoodEvent, MoodValues } from '../../subject/mood.js';
import type { InteractionReaction } from '../../subject/reaction.js';
import type { RapportState } from '../../subject/rapport.js';
import type { Store } from './database.js';
import { MOOD_DIMENSIONS } from '../../subject/mood.js';

const DEDUPE_LIMIT = 4096;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mood_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mood_events_scope ON mood_events(scope,id);
CREATE TABLE IF NOT EXISTS mood_observed (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(scope,dedupe_key)
);
CREATE TABLE IF NOT EXISTS reaction_observed (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(scope,dedupe_key)
);`;

function key(scope: string, userId: string): string { return `${scope}\u0000${userId}`; }

function parseEvent(body: unknown): MoodEvent | undefined {
  try {
    const raw = JSON.parse(String(body)) as { at?: number; deltas?: Record<string, unknown>; reason?: string };
    const deltas: Partial<MoodValues> = {};
    for (const name of MOOD_DIMENSIONS) {
      const value = Number(raw.deltas?.[name]);
      if (Number.isFinite(value) && value !== 0) deltas[name] = value;
    }
    return { at: Number(raw.at) || 0, deltas, reason: String(raw.reason ?? '').slice(0, 120) };
  } catch { return undefined; }
}

export class SqliteAffectStore implements AffectStore {
  private ready = false;
  constructor(private readonly db: Store) {}
  private ensure(): void {
    if (this.ready) return;
    this.db.db.exec(SCHEMA);
    this.ready = true;
  }
  loadMood(scope: string): Mood | undefined { return this.db.get<Mood>('mood', scope); }
  saveMood(scope: string, mood: Mood, event: MoodEvent, dedupeKey?: string): boolean {
    this.ensure();
    if (dedupeKey && !this.claim('mood_observed', scope, dedupeKey, event.at)) return false;
    this.db.put('mood', scope, mood);
    this.db.db.prepare('INSERT INTO mood_events(scope,at,body) VALUES (?,?,?)')
      .run(scope, event.at, JSON.stringify(event));
    return true;
  }
  seenMood(scope: string, dedupeKey: string): boolean {
    this.ensure();
    return !!this.db.db.prepare('SELECT 1 FROM mood_observed WHERE scope=? AND dedupe_key=?').get(scope, dedupeKey);
  }
  moodEvents(scope: string): MoodEvent[] {
    this.ensure();
    const rows = this.db.db.prepare('SELECT body FROM mood_events WHERE scope=? ORDER BY id').all(scope);
    return rows.map(row => parseEvent((row as { body: string }).body)).filter((row): row is MoodEvent => !!row);
  }
  reaction(scope: string, userId: string): InteractionReaction | undefined {
    return this.db.get<InteractionReaction>('reaction', key(scope, userId));
  }
  putReaction(scope: string, userId: string, value: InteractionReaction | undefined): void {
    const id = key(scope, userId);
    if (value) this.db.put('reaction', id, value);
    else this.db.db.prepare("DELETE FROM documents WHERE collection='reaction' AND id=?").run(id);
  }
  claimReaction(scope: string, dedupeKey: string, at: number): boolean {
    this.ensure();
    return this.claim('reaction_observed', scope, dedupeKey, at);
  }
  rapport(scope: string, userId: string): RapportState | undefined {
    return this.db.get<RapportState>('rapport', key(scope, userId));
  }
  putRapport(scope: string, userId: string, state: RapportState): void {
    this.db.put('rapport', key(scope, userId), state);
  }
  /** 表名只来自本文件内部常量，不接受外部输入。 */
  private claim(table: 'mood_observed' | 'reaction_observed', scope: string, dedupeKey: string, at: number): boolean {
    const result = this.db.db.prepare(`INSERT OR IGNORE INTO ${table}(scope,dedupe_key,created_at) VALUES (?,?,?)`)
      .run(scope, dedupeKey, at);
    if (result.changes !== 1) return false;
    this.db.db.prepare(`DELETE FROM ${table} WHERE scope=? AND id <= `
      + `(SELECT COALESCE(MAX(id),0) FROM ${table} WHERE scope=?) - ?`).run(scope, scope, DEDUPE_LIMIT);
    return true;
  }
}
