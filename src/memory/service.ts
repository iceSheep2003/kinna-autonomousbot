/**
 * 长期记忆服务：检索、排序、权限、注入、提炼写入。
 *
 * 对齐服务器 qunbot/memory/service.py 的职责切分：
 *   collection（候选池）→ 权限 → ranking → injection → 写路径 dedupe/conflict。
 * 在线检索全是本地代码，不新增 LLM、不引入向量服务；拿不到 embeddings 时
 * 本来就只走词面，所以这里直接用中文二元字组 Jaccard 作为 lexical 信号。
 *
 * C1 preheat 在决策之前读少量背景，C2 related 在决策之后按关键词定向读，
 * 两者共用同一个 D 预算和身份去重；C2 新查到的事实不能当作本轮已用过的依据。
 */
import type { MemoryRepository, MemoryView } from './ports.js';
import type { Memory, MemoryContext, MemoryProposal, MemoryWriteOutcome,
  RecallRequest, RetrievalHit } from './types.js';
import { CANDIDATE_CONFIDENCE, GROUP_SUBJECT, MemoryProposalSchema } from './types.js';
import { readableRecords } from './access.js';
import { parseScope, formatScope } from './scope.js';
import { rankMemories, type RankingWeights } from './ranking.js';
import { DEFAULT_MEMORY_BUDGET_CHARS, renderMemoryContext } from './render.js';
import { contradiction, decideDedupe } from './dedupe.js';

export interface MemoryServiceOptions {
  clock?: () => number;
  weights?: Partial<RankingWeights>;
  budgetChars?: number;
  /** 默认 scope（`owner` / `group:<id>` / `feature:<id>`）；缺省视为 owner。 */
  scope?: string;
  /** 候选池上限，防止一次把所有记忆都算一遍。 */
  pool?: number;
}

export class MemoryService implements MemoryView {
  private readonly repository: MemoryRepository;
  private readonly options: MemoryServiceOptions;
  constructor(repository: MemoryRepository, options: MemoryServiceOptions = {}) {
    this.repository = repository;
    this.options = options;
  }
  private now(): number { return this.options.clock?.() ?? Date.now(); }
  private request(query: string, limit: number, scope?: string): RecallRequest {
    return { query, limit, now: this.now(), scope: formatScope(parseScope(scope ?? this.options.scope)) };
  }

  /**
   * 兼容旧调用方：只拿事实数组，不带提及策略。新上下文请用 context。
   * `scope` 不传时用服务默认值（owner）；传 `group:xxx` 时能读到 owner + 这个群。
   */
  recall(query: string, limit: number, scope?: string): Memory[] {
    return this.retrieve(this.request(query, limit, scope)).map(hit => hit.memory);
  }
  context(request: RecallRequest): MemoryContext {
    const budget = request.budgetChars ?? this.options.budgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS;
    // 进来的 scope 可能是脏数据；在这里规整一次，后续判断都按规范形式。
    return renderMemoryContext(this.retrieve({ ...request, scope: formatScope(parseScope(request.scope)) }), budget);
  }
  /** C1：决策之前的小量预热，只给两三条人和群背景。 */
  preheat(request: RecallRequest): MemoryContext {
    return this.context({ ...request, limit: Math.min(request.limit, 2),
      budgetChars: Math.min(request.budgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS, 600) });
  }
  /** C2：决策之后按关键词定向检索。 */
  related(request: RecallRequest): MemoryContext { return this.context(request); }

  private retrieve(request: RecallRequest): RetrievalHit[] {
    const rows = readableRecords(this.pool(request), request);
    // 分池：通用层（owner）与场景层各自排序后再合并，避免一层被另一层挤光。
    const general = rows.filter(memory => (memory.scope ?? 'owner') === 'owner');
    const scoped = rows.filter(memory => (memory.scope ?? 'owner') !== 'owner');
    const generalQuota = general.length === 0 ? 0 : Math.max(1, Math.floor(request.limit * 0.4));
    const rank = (subset: typeof rows, limit: number) => limit <= 0 ? [] : rankMemories(subset, {
      now: request.now, query: request.query, limit,
      subjectUserId: request.subjectUserId, weights: this.options.weights,
    });
    const hits = [...rank(general, generalQuota), ...rank(scoped, request.limit - generalQuota)]
      .sort((a, b) => b.score - a.score)
      .slice(0, request.limit);
    this.reinforce(hits, request.now);
    return hits;
  }
  private pool(request: RecallRequest): Memory[] {
    const cap = Math.max(this.options.pool ?? 200, request.limit * 5);
    const rows = this.repository.candidates
      ? this.repository.candidates(request)
      : [...this.repository.search(request.query, cap), ...this.repository.recent(cap)];
    const seen = new Set<string>();
    return rows.filter(memory => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      return true;
    }).slice(0, cap);
  }
  /** 加固交给仓储；老仓库没有这个接口就什么都不写，避免「读一次改一次版本」。 */
  private reinforce(hits: readonly RetrievalHit[], now: number): void {
    this.repository.reinforce?.(hits.map(hit => hit.memory.id), now);
  }

  /** 提炼写入：模型给的是 proposal，是否被接受由这里的持久化策略说了算。 */
  observe(raw: MemoryProposal, now: number): MemoryWriteOutcome {
    const proposal = MemoryProposalSchema.parse(raw);
    const live = this.live(proposal, now);
    const decision = decideDedupe(live, proposal.content);
    const matched = decision.memoryId ? this.repository.get(decision.memoryId) : undefined;
    if (matched && decision.kind !== 'new') {
      const conflict = proposal.supersedes || contradiction(matched.content, proposal.content);
      if (!conflict) {
        this.bump(matched, now);
        return { kind: decision.kind === 'duplicate' ? 'duplicate' : 'reinforced', id: matched.id };
      }
      return this.replace(matched, proposal, now);
    }
    return this.insert(proposal, now);
  }
  private live(proposal: MemoryProposal, now: number): Memory[] {
    return this.repository.recent(300).filter(memory => {
      const status = memory.status ?? 'active';
      const subject = memory.subjectUserId ?? GROUP_SUBJECT;
      const scopeMatches = !memory.scope || !proposal.scope || memory.scope === proposal.scope;
      return status !== 'archived' && status !== 'superseded' &&
        !(memory.expiresAt !== undefined && memory.expiresAt <= now) &&
        subject === proposal.subjectUserId && scopeMatches;
    });
  }
  private bump(memory: Memory, now: number): void {
    this.repository.publish({ ...memory, revision: memory.revision + 1,
      accessCount: (memory.accessCount ?? 0) + 1, lastAccessedAt: now, updatedAt: now,
      confidence: Math.min(1, (memory.confidence ?? 1) + 0.05) });
  }
  private replace(old: Memory, proposal: MemoryProposal, now: number): MemoryWriteOutcome {
    this.repository.publish({ ...old, status: 'superseded', revision: old.revision + 1, updatedAt: now });
    return this.insert(proposal, now, 'superseded');
  }
  private insert(proposal: MemoryProposal, now: number, kind: MemoryWriteOutcome['kind'] = 'inserted'): MemoryWriteOutcome {
    const memory: Memory = {
      id: proposal.id ?? `m-${now}-${hash(proposal.content)}`,
      content: proposal.content, evidence: proposal.evidence, kind: proposal.kind, revision: 1,
      scope: proposal.scope, subjectUserId: proposal.subjectUserId,
      personaSummary: proposal.personaSummary, mentionPolicy: proposal.mentionPolicy,
      factType: proposal.factType, confidence: proposal.confidence,
      importance: proposal.importance,
      status: proposal.confidence < CANDIDATE_CONFIDENCE ? 'candidate' : 'active',
      visibility: proposal.visibility, sourceEventId: proposal.sourceEventId,
      originUserId: proposal.originUserId, expiresAt: proposal.expiresAt,
      accessCount: 0, createdAt: now, updatedAt: now,
    };
    this.repository.publish(memory);
    return { kind, id: memory.id };
  }
}

function hash(value: string): string {
  let result = 5381;
  for (let index = 0; index < value.length; index++) result = ((result * 33) ^ value.charCodeAt(index)) >>> 0;
  return result.toString(16).slice(0, 10);
}
