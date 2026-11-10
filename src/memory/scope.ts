/**
 * 记忆的作用域：一个总分层的结构，不是一根扁平的字符串。
 *
 * 线上的 kinna 是「跨 scope 绝不召回」（group:A 记忆对 group:B 完全不可见），
 * 理由是隐私隔离。但那样带来一个问题：**同一个人换到另一个群，就什么都不知道了**，
 * 连「他喜欢别人叫全名」这种跟群无关的事都要重新学一遍。
 *
 * 这里改成层级：
 *
 *   owner  ← 所有场景共享（用户偏好、跨场景的长期事实）
 *     └ group:<id> / private:<id> / feature:<id> / project:<id>  ← 只在各自场景可见
 *
 * `private:<QQ号>` 和 `group:<群号>` 即使数字相同也**不是**同一层：
 * 一个是跟某个人的私聊，一个是群里的事，混了就是隐私事故。
 *
 * 读取规则：**向下看得到，向上看不到**。
 *   在 group:A 里能读 owner + group:A，但读不到 group:B。
 * 写入规则：默认写到当前场景；提到 owner 必须显式，不能自动跨场景传播。
 *
 * 为什么不能「先全量召回再用提示词要求模型忽略」：那样一旦模型不听话就泄露了。
 * 过滤必须在检索之前完成，模型根本看不到它无权读的内容。
 */
/**
 * `private` 是 QQ 私聊：和 `group` 平级但语义不同。
 *
 * 缺了它会出隐私问题——`private:123` 解析失败时会被静默降级成 `owner`，
 * 那是**所有场景都能读**的层。私聊里记的事就成了公开事实。
 */
export type ScopeKind = 'owner' | 'group' | 'private' | 'feature' | 'project' | 'bot';

export interface MemoryScope {
  kind: ScopeKind;
  /** owner 没有 id。 */
  id?: string;
}

/** 线上那种 `group:123` / `private:456` 的字符串形式；这里序列化成同一种写法便于落库。 */
export function formatScope(scope: MemoryScope): string {
  return scope.kind === 'owner' ? 'owner' : `${scope.kind}:${scope.id ?? ''}`;
}

/**
 * 解析 scope 字符串。
 * 非法值一律当成 owner——宁可只读全局，也不把脏数据当成某个宽范围授权。
 */
export function parseScope(raw: unknown): MemoryScope {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'owner' };
  const text = raw.trim();
  if (text === 'owner' || text === 'global') return { kind: 'owner' };
  // id 里不允许再出现冒号：`group:123:456` 这种会被当成两个字段，宁可判为非法。
  const match = /^(group|private|feature|project|bot):([A-Za-z0-9_.-]{1,120})$/.exec(text);
  return match === null ? { kind: 'owner' } : { kind: match[1] as ScopeKind, id: match[2]! };
}

/**
 * 从这个 scope 请求时，哪些 scope 的记录可以读。
 * 返回的是**允许集合**，由调用方在检索前做过滤——不是检索后再筛。
 */
export function readableScopes(request: MemoryScope): Set<string> {
  const scopes = new Set<string>(['owner']);
  if (request.kind !== 'owner' && request.id !== undefined) scopes.add(formatScope(request));
  return scopes;
}

/** 这条记录的 scope 能不能被这次请求读到。库里没标 scope 的按 owner 处理（旧数据可读）。 */
export function scopeReadable(stored: string | undefined, request: MemoryScope): boolean {
  return readableScopes(request).has(stored ?? 'owner');
}

/** 两个 scope 是否同层且同 id——写入去重要看这个，跨层不算同一条。 */
export function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return formatScope(left) === formatScope(right);
}

/**
 * 能不能把一条记忆提升到 owner。
 * 只允许从「具体场景」提升，且必须由调用方带上显式意图（用户确认）。
 * 这条规则集中在这里，免得每个写入点各写一遍判断。
 */
export function canPromote(from: MemoryScope, to: MemoryScope): boolean {
  if (to.kind !== 'owner') return false;
  return from.kind !== 'owner';
}
