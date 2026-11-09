/**
 * 把检索结果渲染成「能自然用、不会像 CRM 念记录」的双通道上下文。
 *
 * 对齐服务器 MemoryService.related_context：事实回答「我知道什么」，
 * persona_hint 只回答「这会怎样影响语气」；mention_policy 在所有召回路径保真。
 * 装箱按完整记录逐条尝试，过长或被预算挤掉的记录整条跳过——绝不截前半句，
 * 因为被截断的半句话最容易让模型把没发生的事当成发生过。
 */
import type { ConfidenceLabel, MemoryContext, MemoryContextItem, RetrievalHit } from './types.js';
import { explainHits } from './ranking.js';

/** canonical 允许的完整事实上限；正常提炼写 path 已被 schema 限到 300 字。 */
export const FULL_FACT_MAX_CHARS = 1000;
export const DEFAULT_MEMORY_BUDGET_CHARS = 1800;

export const MEMORY_USAGE_RULE = `记忆只是背景事实，不是本轮话题，也不是你新想到的判断。
direct：确有帮助时自然提起一次；soft_echo：只轻描淡写地呼应，不追问、不展开；
tone_only：只改变语气，禁止说出记忆内容；avoid_unless_asked：除非对方明确问起，否则不要提。
personaHint 只影响你怎么说，不能新增事实。不要把某人的私事说给另一个人听，
也不要因为检索到一条旧事就断言对方现在还是这样。`;

export function confidenceLabel(value: number): ConfidenceLabel {
  if (value >= 0.8) return 'high';
  if (value >= 0.6) return 'medium';
  return 'low';
}

function toItem(hit: RetrievalHit): MemoryContextItem {
  const memory = hit.memory;
  return {
    id: memory.id, fact: memory.content,
    type: memory.factType ?? 'fact',
    personaHint: memory.personaSummary ?? '',
    mentionPolicy: memory.mentionPolicy ?? 'soft_echo',
    confidence: confidenceLabel(memory.confidence ?? 1),
    subject: memory.subjectUserId ?? '_group_',
  };
}

export function renderMemoryContext(hits: readonly RetrievalHit[], budgetChars = DEFAULT_MEMORY_BUDGET_CHARS): MemoryContext {
  const items: MemoryContextItem[] = [];
  let used = 0;
  let omitted = 0;
  for (const hit of hits) {
    if (hit.memory.content.length > FULL_FACT_MAX_CHARS) { omitted++; continue; }
    const item = toItem(hit);
    const size = JSON.stringify(item).length;
    if (used + size > budgetChars) { omitted++; continue; }
    items.push(item);
    used += size;
  }
  return { items, usageRule: MEMORY_USAGE_RULE, explain: explainHits(hits), omitted };
}
