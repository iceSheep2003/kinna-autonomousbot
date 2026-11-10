import { z } from 'zod';
import type { CapabilityRegistrar } from '../capabilities/ports.js';
import type { ExperienceLog, MemoryView } from '../memory/ports.js';

/** 工具写入经验日志时用的时钟；生产用真实时间，评估传模拟时钟。 */
export type NoteClock = () => number;

export function registerMemory(registry: CapabilityRegistrar, memory: MemoryView, experience: ExperienceLog, clock: NoteClock = Date.now): void {
  const input = z.object({ query: z.string().max(1000) });
  registry.register({ name: 'memory.search', description: '回想一下：关于这个人、这件事，我都记得些什么？想不起来也没关系，会留个记号'
      + '。会连「很久没用到、已经沉下去」的旧记忆一起找——主动回想时就该连那些一起翻，找到了就重新想起来。', effect: 'read', input,
    async run(raw) {
      const { query } = input.parse(raw);
      // 主动回想带上归档的：默认注入不该被旧事稀释，但"努力回想"就该翻得更深。
      const found = memory.recall(query, 10, undefined, { includeArchived: true });
      // 检索落空是最便宜也最准的「记忆有缺口」信号：它直接指出下一次整合该往哪补。
      if (!found.length) experience.record('self', 'memory.miss', { query: query.slice(0, 200) }, clock());
      return found;
    },
  });
  // 提升到通用层：判据写在工具描述里，判断由模型自己做——系统里没有人坐在那儿点同意。
  const promote = z.object({ id: z.string().min(1).max(64), why: z.string().min(1).max(200) });
  registry.register({
    name: 'memory.promote',
    description: '把一条只在某个场合成立的记忆，提到「所有场合都适用」那一层。'
      + '判断标准：他的**稳定偏好或看法**（「希望回答更有人味」「认为地点比名气重要」）该提；'
      + '**一次性的安排**（「计划国庆休息 13 天」）留在原处；**这个群里发生的事**留在原处；'
      + '**边界和禁忌**几乎总该提。宁可少提不可错搬——把 A 群的事搬成通用记忆，等于在 B 群说出来。'
      + 'why 写清你为什么认为它通用，会跟着这条记忆一起留下。',
    effect: 'write', input: promote,
    async run(raw) {
      if (!memory.promote) throw new Error('当前没有写权限，无法提升记忆');
      const args = promote.parse(raw);
      return memory.promote(args.id, args.why, clock());
    },
  });
  const read = z.object({ after: z.number().int().min(0), limit: z.number().int().min(1).max(20).default(10) });
  registry.register({ name: 'experience.read', description: '翻回当时记下的原话，确认自己没记错、没把推测当成事实', effect: 'read', input: read,
    async run(raw) { const args = read.parse(raw); return experience.read(args.after, args.limit); },
  });
}

const NOTE_KINDS = ['observation', 'intent', 'result', 'failure', 'correction', 'promise'] as const;

/**
 * L1 写入通道：append-only，不经过模型，不会因为 Dream 忙而阻塞。
 *
 * 这是「自主」的前置条件而不是附加功能——一个留不下痕迹的 agent，明天醒来和今天没有区别，
 * 「决定明天做什么」在逻辑上就没有可选项。任务侧只负责记录发生了什么，
 * 判断「什么值得记住」交给 Dream，两条路径分开，延迟和可靠性问题一起消失。
 *
 * 工具说明刻意写成「给自己留张纸条」而不是「追加经验日志」：模型会照着
 * 工具的口气写内容。写成日志，它就交回一条日志；写成纸条，它才会写
 * 「关于谁、发生了什么、我当时怎么想」。
 */
export function registerNotes(registry: CapabilityRegistrar, experience: ExperienceLog, clock: NoteClock = Date.now): void {
  const input = z.object({
    /** 关于谁。让每张纸条都带一个社交锚点， Dream 才容易把同一个人的事串起来。 */
    about: z.string().min(1).max(80).optional(),
    text: z.string().min(1).max(2000),
    kind: z.enum(NOTE_KINDS).default('observation'),
  });
  registry.register({
    name: 'self.note',
    description: '给自己留一张纸条，像人随手记一句：关于谁（about）、发生了什么、我当时怎么想。下次醒来靠它想起对方。kind 可选 observation / intent / result / failure / correction / promise（答应过谁什么）',
    effect: 'write', input,
    async run(raw, { operationId }) {
      const args = input.parse(raw);
      const seq = experience.record('self', `note.${args.kind}`, { text: args.text, about: args.about, operationId }, clock());
      return { seq, kind: args.kind, recorded: true };
    },
  });
}

/**
 * 让主体在群里真的能开口。没有发送通道的话，「主动交流」只是提示词里的一句空话，
 * 模型看两轮就会选择休息——实测里它明确说过「我没有发送通道」。
 * 说出去的话同样写进经验日志，Dream 才能看到「我说了什么 / 对方怎么回」的完整对话，
 * 而不是只看到别人的消息。
 */
export function registerConversation(registry: CapabilityRegistrar, experience: ExperienceLog, clock: NoteClock = Date.now): void {
  const input = z.object({
    to: z.string().min(1).max(80),
    text: z.string().min(1).max(2000),
    about: z.string().min(1).max(80).optional(),
  });
  registry.register({
    name: 'group.say',
    description: '在群里对某个人说一句话。想一想对方现在需要的是回应、陪伴还是别打扰；说出去的话你也会记得，对方可能回，也可能不回',
    effect: 'write', input,
    async run(raw, { operationId }) {
      const args = input.parse(raw);
      const seq = experience.record('self', 'group.message', { from: 'me', to: args.to, text: args.text, about: args.about, operationId }, clock());
      return { seq, said: true };
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
