import type { SearchHit } from './search.js';

/**
 * 交给模型判断的那一段。
 *
 * 关键在最后一句：**如果没什么意思，就不要说话**。有了这句，模型才是过滤器；
 * 没有它，模型会把「我搜到一条」当成「我该说一句」，于是群里开始新闻播报。
 */
export function sharePrompt(keyword: string, hit: SearchHit): string {
  return [
    `刚搜到一条东西，关键词是「${keyword}」。`,
    `标题：${hit.title}`,
    hit.site ? `来源：${hit.site}` : '',
    hit.date ? `时间：${hit.date}` : '',
    hit.summary ? `摘要：${hit.summary}` : '',
    `链接：${hit.url}`,
    '',
    '如果你觉得这条值得跟群里说，就用群友随口分享的语气写一句话，可以带一点自己的看法；',
    '别写成新闻播报，也别硬夸。如果没什么意思，就不要说话。',
  ].filter(line => line !== '').join('\n');
}
