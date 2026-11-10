import { upsertPerson, type Person } from './person.js';

/**
 * 从流过的消息里认出人。
 *
 * 这是人物层的数据来源：不额外调模型，只在处理消息时顺手记一笔。
 * 记三件事：这个人存在、他这次叫什么、他在哪个群出现。
 *
 * 为什么由代码做而不是模型：这是**观察**不是判断。昵称就在消息里，
 * 不需要模型来「认为这是谁」。判断留给 Dream 写画像。
 */
export interface PeopleStore {
  get(userId: string): Person | undefined;
  save(person: Person): void;
}

/** 一条消息里能提取出的人物线索。 */
export interface PersonObservation {
  userId?: string;
  name?: string;
  group?: string;
}

/** 取第一个非空字符串字段。 */
function firstText(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** 从消息数据里提取人物线索；提取不到就不记，不编。 */
export function observe(data: unknown): PersonObservation {
  if (typeof data !== 'object' || data === null) return {};
  const row = data as Record<string, unknown>;
  const userId = firstText(row, ['userId', 'user_id']);
  const name = firstText(row, ['nickname', 'card', 'senderName']);
  const group = firstText(row, ['groupId', 'group_id']);
  // 没有 userId 就不是一个可识别的人（可能是系统消息）；只有名字也不记，会张冠李戴。
  if (userId === undefined || name === undefined) return {};
  return { userId, name, ...(group !== undefined ? { group } : {}) };
}

/** 观察到就更新；返回是否是新认识的人。 */
export function trackPerson(store: PeopleStore, observation: PersonObservation, now: number): boolean {
  if (observation.userId === undefined || observation.name === undefined) return false;
  const existing = store.get(observation.userId);
  store.save(upsertPerson(existing, {
    userId: observation.userId, name: observation.name,
    ...(observation.group !== undefined ? { group: observation.group } : {}), now,
  }));
  return existing === undefined;
}


/**
 * 人物视图：给场景用的窄接口。
 *
 * observe 在消息流过时调用（不调模型）；roster 渲染成一段人话给上下文。
 * roster 只给最近见过的几位——认识 205 个人不代表要一次列 205 行。
 */
export class PeopleRoster implements PeopleStore {
  constructor(private readonly store: PeopleStore & { recent?(limit: number): Person[]; list?(limit?: number): Person[] }, private readonly render: (person: Person) => string) {}
  get(userId: string): Person | undefined { return this.store.get(userId); }
  save(person: Person): void { this.store.save(person); }
  observe(data: unknown, now: number): void { trackPerson(this.store, observe(data), now); }
  /** 渲染最近认识的几个人。空的话返回空串，不占上下文。 */
  roster(limit: number): string {
    const rows = this.store.recent?.(limit) ?? this.store.list?.(limit) ?? [];
    const lines = rows.filter(person => person.portrait !== undefined || person.notes.length > 0).map(person => this.render(person));
    return lines.length === 0 ? '' : ['## 我认识的这些人', ...lines].join('\n');
  }
}
