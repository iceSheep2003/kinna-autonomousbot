import { z } from 'zod';
import type { CapabilityRegistrar } from '../capabilities/ports.js';
import type { ExperienceLog, MemoryView } from '../memory/ports.js';

/** 工具写入经验日志时用的时钟；生产用真实时间，评估传模拟时钟。 */
export type NoteClock = () => number;

export function registerMemory(registry: CapabilityRegistrar, memory: MemoryView, experience: ExperienceLog, clock: NoteClock = Date.now): void {
  const input = z.object({ query: z.string().max(1000) });
  registry.register({ name: 'memory.search', description: '检索长期记忆及其原始证据引用；检索落空会被记为一次记忆缺口', effect: 'read', input,
    async run(raw) {
      const { query } = input.parse(raw);
      const found = memory.recall(query, 10);
      // 检索落空是最便宜也最准的「记忆有缺口」信号：它直接指出下一次整合该往哪补。
      if (!found.length) experience.record('self', 'memory.miss', { query: query.slice(0, 200) }, clock());
      return found;
    },
  });
  const read = z.object({ after: z.number().int().min(0), limit: z.number().int().min(1).max(20).default(10) });
  registry.register({ name: 'experience.read', description: '按序号读取原始经验，核查记忆引用', effect: 'read', input: read,
    async run(raw) { const args = read.parse(raw); return experience.read(args.after, args.limit); },
  });
}

const NOTE_KINDS = ['observation', 'intent', 'result', 'failure', 'correction'] as const;

/**
 * L1 写入通道：append-only，不经过模型，不会因为 Dream 忙而阻塞。
 *
 * 这是「自主」的前置条件而不是附加功能——一个留不下痕迹的 agent，明天醒来和今天没有区别，
 * 「决定明天做什么」在逻辑上就没有可选项。任务侧只负责记录发生了什么，
 * 判断「什么值得记住」交给 Dream，两条路径分开，延迟和可靠性问题一起消失。
 */
export function registerNotes(registry: CapabilityRegistrar, experience: ExperienceLog, clock: NoteClock = Date.now): void {
  const input = z.object({
    text: z.string().min(1).max(2000),
    kind: z.enum(NOTE_KINDS).default('observation'),
  });
  registry.register({
    name: 'self.note',
    description: '把一条观察、意图、结果、失败或纠正追加到不可变经验日志。这是你留给下一次醒来的痕迹；不写，下次就什么都不记得',
    effect: 'write', input,
    async run(raw, { operationId }) {
      const args = input.parse(raw);
      const seq = experience.record('self', `note.${args.kind}`, { text: args.text, operationId }, clock());
      return { seq, kind: args.kind, recorded: true };
    },
  });
}

export function registerSandbox(registry: CapabilityRegistrar): void {
  registry.register({ name: 'sandbox.observe', description: '观察本地演示环境（模拟数据）', effect: 'read', input: z.object({}),
    async run() { return { simulated: true, items: [{ id: 'birds', title: '鸟类如何跨越大陆迁徙', content: '这是用于验证自主闭环的模拟内容。' }] }; },
  });
}

export function registerBraveSearch(registry: CapabilityRegistrar, apiKey: string): void {
  const input = z.object({ query: z.string().min(1).max(500) });
  registry.register({ name: 'web.search', description: '通过 Brave Search 搜索公开网页，返回标题、URL 和摘要；摘要不代表完整网页', input, effect: 'read',
    async run(raw, { signal }) {
      const { query } = input.parse(raw);
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query); url.searchParams.set('count', '5');
      const response = await fetch(url, { signal, headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Search HTTP ${response.status}`);
      const data = await response.json() as { web?: { results?: { title: string; url: string; description: string }[] } };
      return { query, results: (data.web?.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.description })) };
    },
  });
}
