/** QQ 渲染预算：拆条、片段、媒体与引用深度属于平台适配，不属于核心上下文限额。 */
export const qqBudget = {
  messageChars: 2400,
  partsPerMessage: 50,
  mediaPerMessage: 8,
  quoteDepth: 3,
} as const;
