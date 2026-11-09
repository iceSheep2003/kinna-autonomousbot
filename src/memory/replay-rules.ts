import type { DreamLoop, DreamRound, Memory } from './types.js';

/** 回放期间一条记忆的工作副本。状态机：active →（revise / replay 补证据）→ active，或者 → retracted / merged。 */
export type Workbook = Omit<DreamMemory, 'status'> & {
  content: string; evidence: number[]; kind: Memory['kind'];
  status: 'active' | 'retracted' | 'merged'; mergedInto?: string; origin: 'prior' | 'round';
};
type DreamMemory = Omit<Memory, 'revision'>;

/** 一次回放回合里所有可写字段都缺省 = 模型认为没有要改的。 */
const ROUND_FIELDS = ['memories', 'revisions', 'retractions', 'failedApproaches', 'proposals', 'opportunities'] as const;

/** 回放收敛与记忆等价判定：都是「这一遍到底改了什么」的纯函数。 */
export const judge = {
  /** 所有可写字段都缺省 = 模型认为没有要改的。 */
  quiet(value: DreamRound): boolean {
    return ROUND_FIELDS.every(field => !(value[field] as unknown[] | undefined)?.length);
  },
  /** 内容、类别、证据都没变才算同一条记忆，不靠「这一遍有没有 revision」判断。 */
  same(a: Memory, b: DreamMemory): boolean {
    return a.content === b.content && a.kind === b.kind
      && a.evidence.length === b.evidence.length && a.evidence.every((seq, index) => seq === b.evidence[index]);
  },
};

/**
 * 一条记忆最少要几条独立证据。观察允许单点，推论和策略必须交叉印证。
 * 这是挡「整合漂移」的硬约束：没有两条证据支撑的漂亮结论，一律不收。
 */
const MIN_EVIDENCE: Record<Memory['kind'], number> = { observation: 1, inference: 2, strategy: 2 };

/** 写出的每条记忆都必须对得上具体的人和事，且达到该类别的证据门槛。 */
export function checkMemory(memory: Pick<Memory, 'id' | 'content' | 'evidence' | 'kind'>, allowed: Set<number>): void {
  if (!memory.content.trim()) throw new Error(`Dream memory "${memory.id}" is empty`);
  for (const seq of memory.evidence) if (!allowed.has(seq)) throw new Error('Dream cited evidence outside its snapshot');
  const minimum = MIN_EVIDENCE[memory.kind];
  if (memory.evidence.length < minimum) throw new Error(`Dream ${memory.kind} "${memory.id}" needs >= ${minimum} independent evidence`);
}

/** 工作副本去掉内部状态字段，变回一条可落库的记忆。 */
export function snapshotOf(memory: Workbook): DreamMemory {
  const { status, mergedInto, origin, ...rest } = memory;
  void status; void mergedInto; void origin;
  return { ...rest, evidence: [...rest.evidence] };
}

/** 回放说明：第几遍、同一段区间、以及上一遍自己确认过的内容。 */
export function loopOf(round: number, episode: Pick<DreamLoop['episode'], 'fromExclusive' | 'throughInclusive' | 'live'>, workspace: DreamMemory[]): DreamLoop {
  return { round, episode, workspace: workspace.map(m => ({ id: m.id, content: m.content, kind: m.kind, evidence: [...m.evidence], status: 'active' })) };
}

/**
 * 快照外已有的记忆一个字段都不能改：模型只拿到一部分记忆，改它没看见的那条就是越权。
 * 快照内的记忆走 revisions，不受这条限制。
 */
export function guardScope(id: string, snapshot: { revisions: Map<string, number>; stored: (id: string) => unknown }): void {
  if (snapshot.stored(id) !== undefined && !snapshot.revisions.has(id)) {
    throw new Error('Dream cannot overwrite a memory not in its input snapshot');
  }
}
