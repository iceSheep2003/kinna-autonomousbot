import { z } from 'zod';

/**
 * 人物层。
 *
 * 之前的记忆是按「事实」组织的：一条一条，各自带 subjectUserId。
 * 真实数据里一个人能有 63 条散落的事实（牢e 就是），但没有任何地方把它们
 * 拼成「这个人是谁、什么样」。于是每次注入只捞到其中几条，永远拼不出一个人。
 *
 * 人不是事实的集合，是事实的**收敛**。这一层做的就是收敛：
 * 一个人 → 一份画像（一句话 + 关键点）+ 指向那 63 条事实的指针。
 *
 * 三层分工，和记忆那三层同构：
 * - 事实（memory）：一条一件，带证据
 * - 人物（person）：这个人的画像 + 指向他的事实
 * - 人物索引：我认识谁（进上下文的那一小份）
 */
export const PersonSchema = z.object({
  /** 人由 QQ 号唯一确定，跨群是同一个人。 */
  userId: z.string().min(1).max(40),
  /** 见过的所有称呼，按首次出现排序。群名片会变，这个只增不减。 */
  names: z.array(z.string().max(40)).max(12),
  /**
   * 一句话画像：他是谁、跟他说话要注意什么。
   * 由 Dream 写——只有它看到关于这个人的全部事实。
   */
  portrait: z.string().max(200).optional(),
  /** 画像的依据：这些记忆支撑了这个判断。 */
  portraitEvidence: z.array(z.string().max(64)).max(20).default([]),
  /** 跟他有关但还不适合写进画像的（细节、近况）。 */
  notes: z.array(z.string().max(120)).max(12).default([]),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  /** 在哪些群里见过他。跨群仍是同一个人。 */
  groups: z.array(z.string().max(40)).max(20).default([]),
});
export type Person = z.infer<typeof PersonSchema>;

/** 画像最多这么长；再长就退化成"又一堆事实"。 */
export const PORTRAIT_MAX = 200;

/**
 * 合并一次观察到的称呼。
 *
 * 群名片、昵称、B 站 ID 都算。同名不重复加；超过上限丢最老的，
 * 但**保留第一个**——那通常是本名或最早认识时的样子。
 */
export function rememberName(person: Person, name: string): Person {
  const clean = name.trim().slice(0, 40);
  if (clean === '' || person.names.includes(clean)) return person;
  if (person.names.length < 12) return { ...person, names: [...person.names, clean] };
  return { ...person, names: [person.names[0] ?? clean, ...person.names.slice(2), clean] };
}

/** 新建一个人；已有则用 `rememberName` 更新。 */
export function upsertPerson(existing: Person | undefined, input: { userId: string; name: string; group?: string; now: number }): Person {
  if (existing) {
    const named = rememberName(existing, input.name);
    return {
      ...named,
      lastSeenAt: input.now,
      groups: input.group && !named.groups.includes(input.group) ? [...named.groups, input.group] : named.groups,
    };
  }
  return {
    userId: input.userId, names: [input.name.slice(0, 40)], portraitEvidence: [], notes: [],
    firstSeenAt: input.now, lastSeenAt: input.now, groups: input.group ? [input.group] : [],
  };
}

/**
 * 系统生成的占位名：入群自动给的「群友3460」这类。
 * 它们不是人给自己起的名字，用来称呼人很怪。
 */
const PLACEHOLDER = /^(?:群友|用户|QQ用户|member)\D{0,4}\d{3,}$/i;

/**
 * 显示他应该怎么叫。
 *
 * 优先级：非占位名的**最近一个** → 任意最近一个 → userId。
 *
 * 为什么不直接取最近的：真实数据里最近见到的往往自动生成的「群友3460」，
 * 而人实际叫的是「牢e」。群名片会变，但占位名不是名字。
 */
export function displayName(person: Person): string {
  const real = person.names.filter(name => !PLACEHOLDER.test(name));
  const pool = real.length > 0 ? real : person.names;
  return pool.at(-1) ?? person.userId;
}

/** 给模型看的一行人话。没有画像时只报名字和关系，不编。 */
export function renderPerson(person: Person): string {
  const name = displayName(person);
  if (person.portrait === undefined || person.portrait.trim() === '') {
    return `- ${name}（${person.notes.length} 条近况）`;
  }
  return `- ${name}：${person.portrait}`;
}

/** 画像的判据，进 Dream 指令。 */
export const PORTRAIT_PROMPT = `有些编号是同一个人——昵称、群名片、平台 ID 会变，人不变。
关于某个人的事实攒多了（十几条以上），给我一份**画像**，不要只列事实：

portrait 写什么：
- 他是谁、在群里什么角色、跟他说话要注意什么
- 一句话，不超过 100 字。**宁可写得准，不要写得多**
- 只写**反复出现、有证据支撑**的判断。一次性的说法不要写进画像
- 不写他的隐私细节（具体住址、联系方式），那些留在他自己的记忆里

notes 写什么：
- 跟他有关的临时状态、近况（「最近在找工作」「上周说要体检」）
- 每条一句话，最多 8 条；过时的会被新的一轮替掉

portraitEvidence 写什么：
- 支撑这句画像的记忆 id。没有证据的判断不要写

**不确定就不写**：画像会被当成「我一直知道的事」，写错了比空着糟糕得多。`;

/** 画像 + 近况合起来渲染给模型看，并附上可以展开的 id。 */
export function renderPersonCard(person: Person): string {
  const lines = [renderPerson(person)];
  for (const note of person.notes.slice(0, 6)) lines.push(`  · ${note}`);
  if (person.portraitEvidence.length > 0) lines.push(`  （依据: ${person.portraitEvidence.slice(0, 8).join(',')}）`);
  return lines.join('\n');
}
