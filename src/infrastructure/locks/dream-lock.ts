import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { DreamLock } from '../../memory/ports.js';

/**
 * 跨进程互斥锁。文件内容 = 持有者 pid。
 *
 * 一个文件承担两件事：内容是互斥凭证，mtime 顺便能当「上次动过的时间」。
 * 超过一小时或持有者已死即视为过期——崩溃后不需要人工清锁。
 * 注意：这里用真实时间判断过期；逻辑时间（模拟时钟）由 DreamState 单独保存，
 * 否则评估里用的是伪造时间，会被判定成永远过期。
 */
const STALE_MS = 3_600_000;

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isStale(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs > STALE_MS; } catch { return true; }
}

function holder(path: string): number {
  try { return Number(readFileSync(path, 'utf8').trim()); } catch { return 0; }
}

export function createDreamLock(path: string): DreamLock {
  let mine = false;
  return {
    acquire() {
      if (existsSync(path) && !isStale(path) && isAlive(holder(path))) return false;
      writeFileSync(path, String(process.pid));
      mine = true;
      return true;
    },
    release() {
      if (mine && existsSync(path)) unlinkSync(path);
      mine = false;
    },
    held() { return mine; },
  };
}
