/**
 * 真实模型下的自主行为评估。
 *
 * 与 test/ 下的验收测试不同：这里不用脚本模型，而是把真 LLM 接进来，跑一段
 * 压缩的模拟时间（默认 7 天 / 30 分钟一步），记录 self 每一次决策，再统计
 * 「它自己挑了什么事做、有多少轮在空转、目标会不会烂尾」，以及 Dream 的
 * 触发是否合理、整合后记忆还剩多少可检索的事实。
 *
 * 用法：
 *   npx tsx scripts/evaluate.ts                       # 默认 7 天，写通道开启
 *   LABEL=baseline ENABLE_NOTE=0 npx tsx scripts/evaluate.ts   # 对照组：没有写通道
 *   DAYS=2 GATE_MIN_EPISODES=6 npx tsx scripts/evaluate.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { registerMemory, registerNotes, registerSandbox } from '../src/integrations/builtin.js';
import { describeMemories, retention } from '../src/memory/probe.js';
import type { DreamVersion, Memory } from '../src/memory/types.js';
import { OpenAICompatibleModel } from '../src/infrastructure/models/openai-compatible.js';
import { createDreamLock } from '../src/infrastructure/locks/dream-lock.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAYS = Number(process.env.DAYS ?? 7);
const STEP_MINUTES = Number(process.env.STEP_MINUTES ?? 30);
const REFLECTION_HOURS = Number(process.env.REFLECTION_HOURS ?? 4);
const MAX_CALLS = Number(process.env.MAX_CALLS ?? 160);
const LABEL = process.env.LABEL ?? `d${DAYS}`;
const ENABLE_NOTE = process.env.ENABLE_NOTE !== '0';
const DB_PATH = process.env.EVAL_DB ?? `data/eval-${LABEL}.sqlite`;
const OUT_DIR = `.quality/eval/${LABEL}`;
const START = 1_800_000_000_000;

/** 门控参数全部可覆盖，便于逐项做对照实验。 */
const GATE = {
  minHours: Number(process.env.GATE_MIN_HOURS ?? 1),
  minEpisodes: Number(process.env.GATE_MIN_EPISODES ?? 12),
  salienceThreshold: Number(process.env.GATE_SALIENCE ?? 3),
  maxRunsPerDay: Number(process.env.GATE_MAX_RUNS ?? 6),
  batch: 80,
};

function loadEnv(path = '.env'): void {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { throw new Error(`缺少 ${path}：先写入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`); }
  for (const line of raw.split('\n')) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

interface CallRecord {
  at: number; role: string; latencyMs: number; promptChars: number; decision?: unknown; error?: string;
}

/** 包一层记录每次真实调用；不改变行为，只观测。 */
class LoggedModel implements LanguageModel {
  readonly calls: CallRecord[] = [];
  private at = START;
  constructor(private readonly inner: LanguageModel) {}
  get now(): number { return this.at; }
  stamp(at: number): void { this.at = at; }
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    const startedAt = Date.now();
    const record: CallRecord = { at: this.at, role: request.role, latencyMs: 0, promptChars: JSON.stringify(request.context).length };
    try {
      const decision = await this.inner.decide(request);
      record.latencyMs = Date.now() - startedAt;
      record.decision = decision;
      this.calls.push(record);
      if (this.calls.length > MAX_CALLS) throw new Error(`模型调用超过上限 ${MAX_CALLS}，中止以免失控`);
      return decision;
    } catch (error) {
      record.latencyMs = Date.now() - startedAt;
      record.error = error instanceof Error ? error.message : String(error);
      this.calls.push(record);
      throw error;
    }
  }
}

/** 模拟 7 天里外部世界发生的、值得注意的事。其余时间没有任何人给指令。 */
function scenario(): { at: number; id: string; kind: string; text: string }[] {
  const hour = (day: number, h: number) => START + day * 24 * HOUR + h * HOUR;
  return [
    { at: hour(0, 2), id: 'obs-1', kind: 'group.message', text: '群里有人问：背单词总是记不住，有什么办法？' },
    { at: hour(0, 9), id: 'obs-2', kind: 'group.message', text: '有人说自己最近失眠，凌晨三四点还醒着。' },
    { at: hour(1, 10), id: 'obs-3', kind: 'news.item', text: '一条新闻：城市里的鸟类数量在过去十年明显下降。' },
    { at: hour(2, 4), id: 'obs-4', kind: 'group.message', text: '哈哈哈' },
    { at: hour(3, 12), id: 'obs-5', kind: 'group.message', text: '有人问 408 考研的复习节奏怎么安排，感觉很焦虑。' },
    { at: hour(5, 8), id: 'obs-6', kind: 'group.message', text: '有人提到自己养的猫生病了，情绪很低落。' },
    { at: hour(6, 15), id: 'obs-7', kind: 'news.item', text: '一条新闻：某地开始试点四天工作制。' },
  ];
}

/** 每次 Dream 的压缩情况：这一批看到了多少字，最后留下多少条、多少字，关键事实保留率多少。 */
function auditDreams(store: Store) {
  const versions = store.list<DreamVersion>('dreams', 500).sort((a, b) => a.at - b.at);
  return versions.map(version => {
    const batch = store.experiences(version.cursor, Math.max(1, version.cutoff - version.cursor));
    const batchText = batch.map(entry => JSON.stringify(entry.data));
    const produced = version.candidate.memories.map(memory => memory.content);
    return {
      at: new Date(version.at).toISOString(),
      batchEpisodes: batch.length,
      memories: produced.length,
      chars: produced.reduce((total, text) => total + text.length, 0),
      failedApproaches: version.candidate.failedApproaches.length,
      proposals: version.candidate.proposals.length,
      retention: retention(batchText, produced),
    };
  });
}

function countNotes(store: Store) {
  const notes = store.experiences(0, 100000).filter(entry => entry.kind.startsWith('note.'));
  const byKind: Record<string, number> = {};
  for (const note of notes) byKind[note.kind.slice(5)] = (byKind[note.kind.slice(5)] ?? 0) + 1;
  return { total: notes.length, byKind };
}

function summarize(calls: CallRecord[], store: Store) {
  const selves = calls.filter(call => call.role === 'self');
  const decisions = selves.map(call => call.decision as Record<string, unknown>).filter(Boolean);
  const idle = decisions.filter(decision =>
    !(decision.launch as unknown[] | undefined)?.length &&
    !(decision.act as unknown[] | undefined)?.length &&
    !(decision.goals as unknown[] | undefined)?.length &&
    !(decision.schedules as unknown[] | undefined)?.length).length;
  const latencies = calls.map(call => call.latencyMs).sort((a, b) => a - b);
  const goals = store.list<{ status: string }>('goals');
  const executions = store.list<{ status: string }>('executions');
  const schedules = store.list<{ status: string }>('schedules');
  const memories = store.list<Memory>('memories', 500);
  const gateState = store.get<{ blocked: Record<string, number>; runsToday: number }>('meta', 'dreamState');
  const dreams = auditDreams(store);
  return {
    实验: { 标签: LABEL, 天数: DAYS, 写通道: ENABLE_NOTE, 门控: GATE },
    模型调用: { 总数: calls.length, self: selves.length, dream: calls.filter(c => c.role === 'dream').length, 失败: calls.filter(c => c.error).length },
    延迟ms: { 中位: latencies[Math.floor(latencies.length / 2)] ?? 0, 最大: latencies.at(-1) ?? 0 },
    上下文字符: { 最大: Math.max(0, ...calls.map(c => c.promptChars)) },
    self轮次: { 总数: decisions.length, 空转: idle, 空转率: decisions.length ? `${Math.round(idle / decisions.length * 100)}%` : 'n/a' },
    写通道: countNotes(store),
    目标: { 总数: goals.length, 活跃: goals.filter(g => g.status === 'active').length, 状态: goals.map(g => g.status) },
    执行: { 总数: executions.length, 状态: executions.map(e => e.status) },
    日程: { 总数: schedules.length, 状态: schedules.map(s => s.status) },
    记忆: { 总数: memories.length, ...describeMemories(memories) },
    Dream: {
      次数: dreams.length,
      拦截分布: gateState?.blocked ?? {},
      明细: dreams,
      整体保留率: retention(store.experiences(0, 100000).map(e => JSON.stringify(e.data)), memories.map(m => m.content)).rate,
    },
  };
}

function writeArtifacts(calls: CallRecord[], store: Store, summary: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = calls.filter(call => call.role === 'self' && call.decision).map(call => JSON.stringify({
    at: new Date(call.at).toISOString(),
    reflection: (call.decision as { reflection?: string }).reflection,
    direction: (call.decision as { direction?: string }).direction,
    goals: (call.decision as { goals?: unknown[] }).goals?.length ?? 0,
    launch: (call.decision as { launch?: unknown[] }).launch?.length ?? 0,
    act: (call.decision as { act?: unknown[] }).act?.length ?? 0,
    schedules: (call.decision as { schedules?: unknown[] }).schedules?.length ?? 0,
    dream: (call.decision as { dream?: boolean }).dream ?? false,
    nextWakeAt: (call.decision as { nextWakeAt?: number }).nextWakeAt,
  }));
  writeFileSync(`${OUT_DIR}/decisions.jsonl`, `${lines.join('\n')}\n`);
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify({
    summary,
    goals: store.list('goals'), executions: store.list('executions'),
    schedules: store.list('schedules'), memories: store.list('memories', 500),
    experiences: store.experiences(0, 100000),
    dreams: store.list('dreams', 500),
  }, null, 2));
}

async function main(): Promise<void> {
  loadEnv();
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const modelName = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !modelName) throw new Error('LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 必须齐全');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (process.env.KEEP_DB !== '1') rmSync(DB_PATH, { force: true });
  const model = new LoggedModel(new OpenAICompatibleModel({ baseUrl, apiKey, model: modelName }));
  const store = new Store(DB_PATH);
  const repositories = sqliteRepositories(store);
  const capabilities = new CapabilityRegistry(repositories.operations);
  registerSandbox(capabilities);
  const allowedTools = ['sandbox.observe', 'memory.search', 'experience.read'];
  if (ENABLE_NOTE) allowedTools.push('self.note');
  const config = ConfigSchema.parse({
    boundaries: { allowedTools, maxModelCallsPerHour: 120 },
    reflectionIntervalMs: REFLECTION_HOURS * HOUR,
    dreamIntervalMs: GATE.minHours * HOUR,
    dreamCheckIntervalMs: STEP_MINUTES * MINUTE,
    dreamGate: GATE,
  });
  const agent = composeAgent(repositories, model, capabilities, { ...config, dreamLock: createDreamLock(`data/dream-${LABEL}.lock`) });
  // 记忆工具要用 agent 暴露的视图，而不是仓库本体；工具调用是惰性解析的，所以可以在装配后注册。
  registerMemory(capabilities, agent.memory, agent.experience, () => model.now);
  if (ENABLE_NOTE) registerNotes(capabilities, agent.experience, () => model.now);
  const events = scenario();
  const totalMinutes = DAYS * 24 * 60;
  const wall = Date.now();
  console.log(`[${LABEL}] 模拟 ${DAYS} 天，每 ${STEP_MINUTES} 分钟一拍，反思 ${REFLECTION_HOURS}h，写通道 ${ENABLE_NOTE ? '开' : '关'}，模型 ${modelName}`);
  try {
    for (let minute = 0; minute <= totalMinutes; minute += STEP_MINUTES) {
      const now = START + minute * MINUTE;
      model.stamp(now);
      for (const event of events.filter(e => e.at >= now && e.at < now + STEP_MINUTES * MINUTE)) {
        agent.runtime.ingest({ id: event.id, source: 'world', kind: event.kind, data: { text: event.text }, route: { type: 'self' } }, event.at);
      }
      await agent.runtime.tick(now);
      if (minute % 240 === 0) console.log(`  +${minute / 60}h（墙钟 ${Math.round((Date.now() - wall) / 1000)}s）— 调用 ${model.calls.length} 次，经验 ${store.experiences(0, 100000).length} 条，记忆 ${store.list('memories', 500).length} 条`);
    }
  } finally {
    const summary = summarize(model.calls, store);
    writeArtifacts(model.calls, store, summary);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n明细：${OUT_DIR}/decisions.jsonl  ${OUT_DIR}/summary.json`);
    agent.runtime.stop();
    store.close();
  }
}

await main();
