/**
 * 记忆读取的统一权限入口。
 *
 * 对齐服务器 MEMORY_RETRIEVAL.md / MEMORY_IDENTITY_REPAIR.md：
 * 每次注入前重新检查状态、过期、scope、可见性与主体；知道 id 不代表有权限，
 * 搜索命中不授予永久权限。事实主体（subjectUserId）与可见受众（visibility）
 * 是两件事，不能混用。
 */
import { GROUP_SUBJECT, type Memory, type RecallRequest } from './types.js';
import { parseScope, scopeReadable } from './scope.js';

export function isReadable(memory: Memory, request: RecallRequest): boolean {
  if (!statusAllows(memory, request)) return false;
  if (memory.expiresAt !== undefined && memory.expiresAt <= request.now) return false;
  // 层级作用域：本次请求能读到 owner + 当前场景；读不到别的场景。
  if (!scopeReadable(memory.scope, parseScope(request.scope))) return false;
  return visible(memory, request);
}

function statusAllows(memory: Memory, request: RecallRequest): boolean {
  const status = memory.status ?? 'active';
  if (status === 'active') return true;
  return status === 'candidate' && request.includeCandidates === true;
}

function visible(memory: Memory, request: RecallRequest): boolean {
  const subject = memory.subjectUserId ?? GROUP_SUBJECT;
  if (subject === GROUP_SUBJECT) return true;
  if (memory.visibility !== 'group') return request.subjectUserId === subject;
  // 群内可见的个人事实，必须有本人的原始证据；否则不把别人的私事带进这个会话。
  return !!memory.originUserId && memory.originUserId === subject;
}

/** 只保留有资格进入上下文的记录。候选池由调用方给，这里不做检索。 */
export function readableRecords(rows: readonly Memory[], request: RecallRequest): Memory[] {
  return rows.filter(memory => isReadable(memory, request));
}
