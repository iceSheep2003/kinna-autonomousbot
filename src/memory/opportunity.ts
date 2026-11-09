/**
 * 机会的「够不够格」判定：Dream 翻出来的「想做但还没做的事」先过这一层，才给 self。
 *
 * 为什么要在 Dream 外面单独校验：Dream 一次只看得到一批昨天经验，看不到目标、对方在不在线、
 * 今天已经开过几次口。如果它随便写一句「去找小林聊聊」就当机会投递，就会出现
 * 「梦里多想了就多发」。这里只挡三类明显不该出现的：
 *
 * 1. 凭空：evidence 指不到本批素材；
 * 2. 越界：about / why 里写了具体消息原文（内联），等于替 self 把话说了；
 * 3. 重复：同一件事（内容高度相似、指向同一个人）被说成好几条。
 *
 * 判完的机会仍然只是素材，真正的「做 / 等 / 不做」由 self 决定。
 */
import type { DreamVersion, Experience } from './types.js';
import { OPPORTUNITY_MAX_ITEMS, OpportunitySchema, type Opportunity } from './types.js';
import { similarity } from './text.js';

/** 同一件事的相似度阈值；超过就只保留 urgency 更高的那条。 */
export const DUPLICATE_THRESHOLD = 0.8;
/** 内联原文的相似度阈值：机会描述和素材几乎一样，就等于替 self 把话说了。 */
export const INLINE_THRESHOLD = 0.9;
/** 太短的片段不做内联比对，否则「小林」「复习」这种人名也会被当成原文。 */
const INLINE_MIN_CHARS = 12;
/** 抽原文的最大嵌套深度；再深就不是「说了什么」，而是资源引用里的别的东西。 */
const MAX_DEPTH = 6;
const URGENCY_RANK: Record<Opportunity['urgency'], number> = { now: 0, today: 1, when_idle: 2 };

export interface OpportunityFilterInput {
  candidates: readonly unknown[];
  /** 允许被引用的经验序号（本批 lived 素材）。 */
  evidence: ReadonlySet<number>;
  /** 本批经验的原文，用来检测「替 self 把话说出来」。 */
  material: readonly Experience[];
  /** 近期已经投递过的机会内容（跨批次去重）。 */
  recent?: readonly string[];
}

export interface OpportunityFilterResult {
  accepted: Opportunity[];
  rejected: Array<{ id: string; reason: string }>;
}

/** 从 experience.data 里尽量抽出文本片段，用来做内联检测。 */
export function materialText(experience: Experience): string[] {
  const data = experience.data;
  if (typeof data === 'string') return [data];
  if (!data || typeof data !== 'object') return [];
  const out: string[] = [];
  // 消息对象往往嵌得很深（data.payload.lines[].text 已经在第 4 层），闸门放在 6 层。
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || out.length > 20) return;
    if (typeof value === 'string') { if (value.length >= INLINE_MIN_CHARS) out.push(value); return; }
    if (Array.isArray(value)) { for (const item of value.slice(0, 10)) walk(item, depth + 1); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(data, 0);
  return out;
}

/** 机会描述里是否直接搬了某段原文：整句搬（包含它的片段）或整段搬（和素材几乎一样）。 */
export function inlinesMaterial(text: string, material: readonly Experience[]): boolean {
  const fragments = material.flatMap(materialText).filter(fragment => fragment.length >= INLINE_MIN_CHARS);
  if (fragments.some(fragment => text.includes(fragment))) return true;
  return material.some(experience => similarity(text, materialText(experience).join('\n')) >= INLINE_THRESHOLD);
}

/** 去重键：带上「关于谁」，同一个人的事才好串起来。 */
function key(opportunity: Pick<Opportunity, 'about' | 'why'>, withSubject: boolean): string {
  return withSubject ? `${opportunity.about}\n${opportunity.why}` : opportunity.why;
}

export function filterOpportunities(input: OpportunityFilterInput): OpportunityFilterResult {
  const accepted: Opportunity[] = [];
  const rejected: OpportunityFilterResult['rejected'] = [];
  for (const candidate of input.candidates.slice(0, OPPORTUNITY_MAX_ITEMS * 2)) {
    const parsed = OpportunitySchema.safeParse(candidate);
    if (!parsed.success) { rejected.push({ id: candidateId(candidate), reason: 'schema' }); continue; }
    const reason = refusal(parsed.data, accepted, input);
    if (reason !== undefined) { rejected.push({ id: parsed.data.id, reason }); continue; }
    admit(accepted, parsed.data);
  }
  // 排序让 self 先看到更急的；同样是「素材」，但顺序本身也是信息。
  accepted.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.id.localeCompare(b.id));
  return { accepted: accepted.slice(0, OPPORTUNITY_MAX_ITEMS), rejected };
}

function candidateId(candidate: unknown): string {
  const id = (candidate as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '?';
}

/** 这条机会为什么不该收；undefined 表示可以收。 */
function refusal(opportunity: Opportunity, accepted: readonly Opportunity[], input: OpportunityFilterInput): string | undefined {
  if (opportunity.evidence.some(seq => !input.evidence.has(seq))) return 'evidence outside batch';
  if (inlinesMaterial(key(opportunity, true), input.material)) return 'inlines material';
  if ((input.recent ?? []).some(previous => similarity(previous, key(opportunity, true)) >= DUPLICATE_THRESHOLD)) return 'duplicate';
  return undefined;
}

/**
 * 收下一条机会；同一个人、同一件事已经在列表里时，留更急的那条（一样急就留先到的）。
 */
function admit(accepted: Opportunity[], opportunity: Opportunity): void {
  const twin = accepted.findIndex(item => item.about === opportunity.about && similarity(item.why, opportunity.why) >= DUPLICATE_THRESHOLD);
  if (twin < 0) { accepted.push(opportunity); return; }
  const existing = accepted[twin];
  if (existing !== undefined && URGENCY_RANK[opportunity.urgency] < URGENCY_RANK[existing.urgency]) accepted.splice(twin, 1, opportunity);
}

/**
 * 机会要过「够不够格」这一层才给 self：凭空编的、把原文当说法搬出来的、批内或近期重复的，都不投递。
 * 被挡掉的原因返回给调用方记进经验日志，事后能看出 Dream 为什么总在瞎提。
 */
export function screenOpportunities(input: {
  candidates: readonly Opportunity[];
  evidence: ReadonlySet<number>;
  material: readonly Experience[];
  /** 最近几次整合的版本，用来跨批次去重。 */
  recentVersions?: readonly DreamVersion[];
}): OpportunityFilterResult {
  if (!input.candidates.length) return { accepted: [], rejected: [] };
  return filterOpportunities({
    candidates: input.candidates,
    evidence: input.evidence,
    material: input.material,
    recent: (input.recentVersions ?? []).flatMap(version => version.opportunities ?? []).map(item => `${item.about}\n${item.why}`),
  });
}
