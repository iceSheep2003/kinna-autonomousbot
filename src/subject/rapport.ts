/**
 * 关系状态：有界分数 + 阶段措辞。
 *
 * 对齐服务器 qunbot/relationships/state.py。分数永远不以数字形式出现在提示词里，
 * 模型只看得到 narrateRapport 的阶段描述。群消息本身不是可信来源，只有评估、
 * 主回复携带的观察、或部署侧显式写入才能改分；普通聊天次数不会自动涨亲密度。
 */
export const RAPPORT_FLOOR = -100;
export const RAPPORT_CEIL = 100;
export const RAPPORT_MIN_DELTA = -3;
export const RAPPORT_MAX_DELTA = 3;
export const RAPPORT_COOLDOWN_MS = 3_600_000;
export const MAX_EVENTS_PER_DAY = 8;
export const MAX_POSITIVE_PER_DAY = 5;
export const DAY_MS = 86_400_000;
export const AUTO_DELTAS: readonly number[] = [-2, -1, 1, 2];
export const TRUSTED_SOURCES = ['evaluator', 'main_reply', 'manual', 'import'] as const;
export type RapportSource = (typeof TRUSTED_SOURCES)[number];

export interface RapportStage { key: string; label: string; floor: number; address: string; guidance: string }

/** 降序 floor，第一段命中的胜出；必须覆盖 -100..100。 */
export const DEFAULT_STAGES: readonly RapportStage[] = [
  { key: 'trusted', label: '很亲近', floor: 60, address: '可以叫昵称', guidance: '语气亲近随意，可以主动关心、接梗，也可以开温和的玩笑' },
  { key: 'close', label: '熟络', floor: 30, address: '自然称呼', guidance: '语气放松，可以聊些私事、接梗，偶尔主动搭话' },
  { key: 'familiar', label: '认识', floor: 10, address: '正常称呼', guidance: '语气自然友好，可以寒暄，不做亲昵表达' },
  { key: 'neutral', label: '普通群友', floor: -10, address: '正常称呼', guidance: '自然友好，可以接日常话题和轻松的梗；调侃要轻，不追着一个人连续开玩笑' },
  { key: 'distant', label: '有点疏远', floor: -30, address: '保持距离', guidance: '礼貌但简短，少开玩笑，不主动搭话' },
  { key: 'wary', label: '戒备', floor: -60, address: '保持距离', guidance: '只做必要回应，不主动搭话，不追问私人话题' },
  { key: 'hostile', label: '有敌意', floor: RAPPORT_FLOOR, address: '保持距离', guidance: '保持克制，只回答必要信息，不争执、不反击' },
];

export interface AffectionProposal {
  scope: string; userId: string; delta: number; reason: string;
  source: RapportSource; sourceEventId?: string;
}
export interface RapportEvent { at: number; delta: number; reason: string; source: RapportSource }
export interface RapportState { score: number; updatedAt: number; events: RapportEvent[] }

export function blankRapport(): RapportState { return { score: 0, updatedAt: 0, events: [] }; }

export function stageFor(score: number): RapportStage {
  for (const stage of DEFAULT_STAGES) if (score >= stage.floor) return stage;
  return DEFAULT_STAGES.at(-1)!;
}

/** 唯一允许给模型看的关系文本：没有分数、没有阈值。 */
export function narrateRapport(score: number): string {
  const stage = stageFor(score);
  return `和这个人的关系阶段：${stage.label}。${stage.guidance}。（称呼：${stage.address}。）`;
}

export function clampRapport(value: number): number {
  return Math.max(RAPPORT_FLOOR, Math.min(RAPPORT_CEIL, Math.trunc(value)));
}

export function validateProposal(proposal: AffectionProposal): AffectionProposal {
  if (!proposal.scope || !proposal.userId) throw new Error('affection proposal needs a scope and a user');
  if (!TRUSTED_SOURCES.includes(proposal.source)) throw new Error(`unknown affection source: ${proposal.source}`);
  if (!Number.isInteger(proposal.delta) || proposal.delta === 0 ||
      proposal.delta < RAPPORT_MIN_DELTA || proposal.delta > RAPPORT_MAX_DELTA) {
    throw new Error('affection delta must be -3..3, excluding 0');
  }
  if (!proposal.reason.trim()) throw new Error('affection change requires a reason');
  return { ...proposal, reason: proposal.reason.trim().slice(0, 240) };
}

interface Rejection { accepted: false; reason: string }
interface Acceptance { accepted: true; state: RapportState }
export type RapportOutcome = Rejection | Acceptance;

/** 冷却 + 滚动 24h 防刷分。写路径之外的任何地方都不能绕过这三道。 */
export function applyRapport(state: RapportState, proposal: AffectionProposal, now: number): RapportOutcome {
  const clean = validateProposal(proposal);
  const recent = state.events.filter(event => now - event.at < DAY_MS && event.at <= now);
  const rejection = reject(state, clean, recent, now);
  if (rejection) return { accepted: false, reason: rejection };
  const event: RapportEvent = { at: now, delta: clean.delta, reason: clean.reason, source: clean.source };
  return { accepted: true, state: { score: clampRapport(state.score + clean.delta),
    updatedAt: now, events: [...recent, event].slice(-MAX_EVENTS_PER_DAY * 2) } };
}

function reject(state: RapportState, proposal: AffectionProposal, recent: RapportEvent[], now: number): string | undefined {
  if (now - state.updatedAt < RAPPORT_COOLDOWN_MS && state.events.length) return 'cooldown';
  if (recent.length >= MAX_EVENTS_PER_DAY) return 'daily limit';
  if (proposal.delta > 0 && recent.filter(event => event.delta > 0).length >= MAX_POSITIVE_PER_DAY) return 'positive daily limit';
  return undefined;
}
