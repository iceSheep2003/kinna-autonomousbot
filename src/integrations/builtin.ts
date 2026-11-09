import { z } from 'zod';
import type { CapabilityRegistrar } from '../capabilities/ports.js';
import type { MemoryView, ExperienceView } from '../memory/ports.js';

export function registerMemory(registry: CapabilityRegistrar, memory: MemoryView, experience: ExperienceView): void {
  const input = z.object({ query: z.string().max(1000) });
  registry.register({ name: 'memory.search', description: '检索长期记忆及其原始证据引用', effect: 'read', input,
    async run(raw) { return memory.recall(input.parse(raw).query, 10); },
  });
  const read = z.object({ after: z.number().int().min(0), limit: z.number().int().min(1).max(20).default(10) });
  registry.register({ name: 'experience.read', description: '按序号读取原始经验，核查记忆引用', effect: 'read', input: read,
    async run(raw) { const args = read.parse(raw); return experience.read(args.after, args.limit); },
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
