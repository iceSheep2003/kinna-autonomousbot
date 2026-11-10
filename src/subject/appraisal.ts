import { MOOD_MAX_DELTA, type MoodValues } from './mood.js';

/**
 * 一轮对话对自己的影响：用**规则**算，不调模型。
 *
 * 为什么不用 LLM：线上的 evaluator 每轮调一次模型（temperature=0）来产出
 * 「±1~3 的 delta + 一句理由」。而 `loop_gain=0.794` 会把这些小量衰减掉，
 * 花一次完整调用去决定「interest +2」不划算——情绪要的是**方向**，不是精度。
 *
 * AstrBot 生态里 BioCore 也是同一条路：「状态更新是确定性的，LLM 不直接写状态」。
 *
 * 这里按认知评价的四类判断来算（OCC 模型的粗粒度版）：
 * 相关性（是不是冲我来的）→ 利害（好话还是坏话）→ 应对（我接得住吗）→ 归因（有意还是无心）
 */
export interface TurnAppraisalInput {
  /** 对方说的话。 */
  text: string;
  /** 我这一轮的回复（没回复就传空串）。 */
  reply: string;
  /** 是否直接指向我（@ / 私聊）。 */
  atBot: boolean;
  /** 是否提问。 */
  question: boolean;
}

export interface TurnAppraisal {
  mood: { deltas: Partial<MoodValues>; reason: string };
  /** 对这个人关系的变化；0 表示这一轮不该动关系。 */
  rapport: { delta: number; reason: string } | undefined;
  /** 短时反应；不传表示没有明显反应。标签与强度用 reaction.ts 的枚举。 */
  reaction: { label: '受伤' | '开心'; intensity: 'slight' | 'clear' | 'marked'; reason: string } | undefined;
}

/** 好话。只收明确表达，不做语义推测——宁可漏，不可错记成"他夸我了"。 */
const PRAISE = ['谢谢', '感谢', '厉害', '牛', '强', '赞', '好用', '爱了', '靠谱', '辛苦'];
/** 坏话。带攻击性的词，命中就压低心情并加压力。 */
const HOSTILE = ['傻', '蠢', '垃圾', '闭嘴', '滚', '废物', '烂', '烦死', '有病', '别烦'];
/** 质疑：不一定恶意，但会带来压力。 */
const DOUBT = ['你错', '不对', '是不是搞错', '确定吗', '真的假的', '假的吧'];

const has = (text: string, words: readonly string[]): boolean => words.some(word => text.includes(word));
const bound = (value: number): number => Math.max(-MOOD_MAX_DELTA, Math.min(MOOD_MAX_DELTA, value));

/**
 * 评一轮。
 *
 * 顺序有讲究：先判断「是不是冲我来的」，再判断「好话坏话」。
 * 群里两句话在聊天、跟我无关的时候，不该动我的心情——那是别人的事。
 */
/** 维度累加器：同一个维度多次命中也只算一次有界值。 */
function adder(): { add(name: keyof MoodValues, amount: number): void; values: Partial<MoodValues> } {
  const values: Partial<MoodValues> = {};
  return {
    values,
    add(name, amount) {
      if (amount === 0) return;
      values[name] = bound((values[name] ?? 0) + amount);
    },
  };
}

/** ① 相关性：只有冲我来的才动情绪。群里的闲聊不该让「我」起伏。 */
function relevance(input: TurnAppraisalInput, add: (name: keyof MoodValues, amount: number) => void): string {
  if (!input.atBot) return '';
  add('interest', 2); add('sociability', 2);
  return '有人专门找我说话';
}

/** ② 利害：好话抬心情，坏话压心情并加压力。负面权重必须压过招呼的 +2。 */
function valence(input: TurnAppraisalInput, add: (name: keyof MoodValues, amount: number) => void): string {
  if (has(input.text, HOSTILE)) {
    add('valence', -3); add('stress', 3); add('sociability', -4);
    return '被怼了一句';
  }
  if (has(input.text, DOUBT)) { add('stress', 2); add('valence', -1); return '被质疑了一句'; }
  if (has(input.text, PRAISE)) { add('valence', 2); return '被夸了一句'; }
  return '';
}

/** ③ 应对：被问住说明吃力。只在真的回复过时判断。 */
function coping(input: TurnAppraisalInput, add: (name: keyof MoodValues, amount: number) => void): string {
  if (input.reply.trim() === '' || !input.question) return '';
  if (input.reply.length <= 6) { add('stress', 1); return '被问住了，答得很短'; }
  if (input.reply.length >= 40) { add('interest', 1); return '问题答得下来'; }
  return '';
}

/**
 * 评一轮。
 *
 * 顺序有讲究：先判断「是不是冲我来的」，再判断「好话坏话」，最后看应对。
 * 群里两句话在聊天、跟我无关的时候，不该动我的心情——那是别人的事。
 */
export function appraiseTurn(input: TurnAppraisalInput): TurnAppraisal {
  const { add, values } = adder();
  const first = [relevance(input, add), valence(input, add), coping(input, add)].filter(text => text !== '');
  // 几句都成立时取最后一句：应对的描述更贴近「这一轮我怎么样」。
  const reason = first.at(-1) ?? '这轮没什么起伏';
  const hostile = has(input.text, HOSTILE);
  const praised = !hostile && has(input.text, PRAISE);
  const rapport = hostile ? { delta: -2, reason: '对方说了难听的话' }
    : praised ? { delta: 2, reason: '对方表达了认可' } : undefined;
  // 标签必须取自 REACTION_LABELS，强度取自 REACTION_INTENSITIES——
  // 自造值会被下游安全丢弃，等于没记。
  const reaction = hostile ? { label: '受伤' as const, intensity: 'clear' as const, reason: '被怼了一句' }
    : praised ? { label: '开心' as const, intensity: 'slight' as const, reason: '被夸了一句' } : undefined;
  return { mood: { deltas: values, reason: reason.slice(0, 80) }, rapport, reaction };
}
