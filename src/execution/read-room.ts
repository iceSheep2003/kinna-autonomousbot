/**
 * 读空气：这一轮值不值得开口。
 *
 * 借自原线上服务的启发式，核心哲学是 **沉默便宜、误回昂贵**——
 * 错过一句俏皮话没关系，硬插一句是代价大的那个。所以「不是冲我来的」这类信号
 * 权重比「可能是冲我来的」更重。
 *
 * 为什么需要它：只有模型判断时，它看不到「该不该说话」的依据，只能选最安全的沉默。
 * 把空气读出来交给它，它才有话说；同时低分轮次直接吞掉，省一次模型调用。
 *
 * 全部是确定性信号：无模型、无随机、时间从入参来，同一串输入永远得到同一结果。
 */
export interface RoomConfig {
  /** 到这个分数才开口。光「有人在提问」不够，还要再加一个信号。 */
  threshold: number;
  /** 刚说过话之后的冷却：别人没理你，就别追。 */
  cooldownMs: number;
  /** 参与过这段对话的窗口：在里面说话会更容易被接。 */
  engagedMs: number;
  /** 刷屏判定：这么多条挤在这个窗口里，说明群里在自己聊。 */
  burstMs: number;
  burstCount: number;
  /** 多少个不同的人在说，算「人多」。 */
  crowdSpeakers: number;
  /** 被叫到这些名字，等于被点名。 */
  botNames: readonly string[];
}

export const DEFAULT_ROOM: RoomConfig = {
  threshold: 0.5, cooldownMs: 20_000, engagedMs: 600_000,
  burstMs: 20_000, burstCount: 5, crowdSpeakers: 3, botNames: [],
};

export interface RoomMessage {
  role: 'user' | 'assistant'; content: string; at?: number; userId?: string;
}

export interface RoomInput {
  text: string; atBot: boolean; atOthers: boolean; hasImage: boolean; isPrivate: boolean;
  now: number; recent: readonly RoomMessage[];
}

export interface RoomVerdict {
  reply: boolean; score: number; reason: string; signals: string[];
}

/** 寒暄、笑声、语气词。群友之间天天这样，每条都接就成壁纸了。 */
const FILLERS = new Set(['哈', '哈哈', '哈哈哈', '呵呵', '嘿嘿', '嗯', '嗯嗯', '哦', '噢', '啊', '呃', '额',
  'emmm', 'emm', '。。。', '...', '…', '草', '好', '好的', '收到', 'ok', 'okk', '行', '可', '可以', '冲',
  '1', '6', '666', '?', '？', '在吗', '打卡', '晚安', '早安', '睡了', '撤了', '笑死', '真实',
  '谢谢', '感谢', '辛苦了', '没事']);

const QUESTION_MARKS = ['？', '?'];
const QUESTION_WORDS = ['吗', '呢', '怎么', '怎样', '如何', '为什么', '为啥', '什么', '多少', '哪',
  '谁', '能不能', '可不可以', '是不是', '有没有', '对不对', '值不值'];

const isQuestion = (text: string): boolean => QUESTION_MARKS.some(mark => text.includes(mark))
  || QUESTION_WORDS.some(word => text.includes(word));

/** 两个字以内且没有问号，是点头不是发言。 */
const isFiller = (text: string): boolean => text.trim() === '' || FILLERS.has(text.trim())
  || (text.trim().length <= 2 && !QUESTION_MARKS.some(mark => text.includes(mark)));

const at = (row: RoomMessage): number => row.at ?? 0;
const isBot = (row: RoomMessage): boolean => row.role === 'assistant';

/** 这段对话在不在我参与过的窗口里。 */
function engaged(recent: readonly RoomMessage[], now: number, config: RoomConfig): boolean {
  const last = lastBotAt(recent);
  return last !== null && now - last >= 0 && now - last < config.engagedMs;
}

function lastBotAt(recent: readonly RoomMessage[]): number | null {
  for (let index = recent.length - 1; index >= 0; index -= 1) if (isBot(recent[index]!)) return at(recent[index]!);
  return null;
}

/** 这段窗口里有几条。+1 是正在评估的这条自己。 */
function burst(recent: readonly RoomMessage[], now: number, config: RoomConfig): boolean {
  const inWindow = recent.filter(row => now - at(row) >= 0 && now - at(row) <= config.burstMs).length;
  return inWindow + 1 >= config.burstCount;
}

function crowd(recent: readonly RoomMessage[], config: RoomConfig): boolean {
  const speakers = new Set(recent.slice(-8).filter(row => !isBot(row)).map(row => row.userId).filter(Boolean));
  return speakers.size >= config.crowdSpeakers;
}

/**
 * 读这一轮。直接对话（私聊 / 被 @ / 被叫名字）不参与打分——那不是判断题。
 */
/** 直接对话（私聊 / 被 @ / 被叫名字）不参与打分——那不是判断题。 */
function directVerdict(input: RoomInput, config: RoomConfig): RoomVerdict | undefined {
  if (input.isPrivate) return { reply: true, score: 1, reason: '私聊：直接回复', signals: [] };
  if (input.atBot) return { reply: true, score: 1, reason: '被 @ 了', signals: [] };
  const named = config.botNames.find(name => name !== '' && input.text.includes(name));
  return named === undefined ? undefined : { reply: true, score: 1, reason: `正文点了名字（${named}）`, signals: [] };
}

/** 时间相关的信号：冷却、参与窗口、接着上一句。 */
function timingSignals(input: RoomInput, config: RoomConfig, add: (delta: number, signal: string) => void): boolean {
  const lastBot = lastBotAt(input.recent);
  const continues = input.recent.length > 0 && isBot(input.recent[input.recent.length - 1]!);
  if (lastBot !== null) {
    const gap = input.now - lastBot;
    if (gap >= 0 && gap < config.cooldownMs && !continues) add(-0.5, '刚回过话');
    else if (engaged(input.recent, input.now, config)) add(0.3, '刚参与过这段对话');
  }
  return continues;
}

/** 内容相关的信号：提问、寒暄、只有图、刷屏、人多。 */
function contentSignals(input: RoomInput, config: RoomConfig, add: (delta: number, signal: string) => void, continues: boolean): void {
  const text = input.text.trim();
  // 没有标点的中文群聊里，「那你是 bot 还是人类」是接着上一句问的，
  // 不靠问号也能看出来——要求显式问号会把一段活着的对话切成两半。
  if (continues && text !== '' && !isFiller(text) && !input.atOthers) add(0.45, '直接接着上一句');
  if (isQuestion(text)) add(continues ? 0.85 : 0.45, continues ? '接着上一句在问' : '有人在提问');
  const opportunity = opportunitySignals(input, config, add);
  noiseSignals(input, config, add, opportunity);
}

/**
 * 热聊里冒出来的实质内容或开放问题——这才是值得插一句的时机。
 *
 * 没有这个信号时，「有人认真提问」只有 0.45，够不到阈值——群里正经问个事
 * 反而接不上。旧实现把它算成「热聊机会」：多人密集说话里出现实质内容才算机会；
 * 冷清时一个人问，仍然按「沉默便宜」处理。
 */
function opportunitySignals(input: RoomInput, config: RoomConfig, add: (delta: number, signal: string) => void): boolean {
  const text = input.text.trim();
  if (input.atOthers || text === '') return false;
  if (!burst(input.recent, input.now, config) && !crowd(input.recent, config)) return false;
  const asked = isQuestion(text);
  const substantive = text.length >= 8 && !isFiller(text);
  if (!asked && !substantive) return false;
  add(asked ? 0.15 : 0.55, asked ? '热聊里的开放问题' : '热聊里的实质内容');
  return true;
}

/** 不值得接的特征：只有图、只有语气词、刷屏、人太多。 */
function noiseSignals(input: RoomInput, config: RoomConfig, add: (delta: number, signal: string) => void, opportunity: boolean): void {
  const text = input.text.trim();
  if (input.hasImage && text === '') add(-0.8, '只有图片');
  if (isFiller(text)) add(-0.6, '寒暄或语气词');
  // 有热聊机会时不再算「刷屏」——否则「人多所以有话说」和「人多所以别插嘴」
  // 两条一起加分，正好抵消掉，机会永远不成立。
  // 有热聊机会时不再算「刷屏」——否则「人多所以有话说」和「人多所以别插嘴」
  // 两条一起加分，正好抵消掉，机会永远不成立。
  if (opportunity) return;
  if (burst(input.recent, input.now, config)) add(-0.4, '刷屏');
  else if (crowd(input.recent, config)) add(-0.2, '人多');
}

/** 读这一轮空气；够阈值才开口。 */
export function readRoom(input: RoomInput, config: RoomConfig = DEFAULT_ROOM): RoomVerdict {
  const direct = directVerdict(input, config);
  if (direct !== undefined) return direct;

  const signals: string[] = [];
  let score = 0;
  const add = (delta: number, signal: string): void => {
    score += delta;
    signals.push(`${signal}${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
  };
  if (input.atOthers) add(-0.9, '叫的是别人');
  const continues = timingSignals(input, config, add);
  contentSignals(input, config, add, continues);

  const reply = score >= config.threshold;
  const detail = signals.length === 0 ? '没有任何值得接话的信号' : signals.join('；');
  return { reply, score: Number(score.toFixed(3)),
    reason: `${reply ? '开口' : '沉默'}（${score.toFixed(2)}/${config.threshold}）：${detail}`, signals };
}
