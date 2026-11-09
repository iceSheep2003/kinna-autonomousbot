import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import type { DreamLock, DreamState, DreamStateRepository, ExperienceLog, MemoryRepository } from '../src/memory/ports.js';
import type { DreamVersion, Experience, Memory } from '../src/memory/types.js';
import { scoreSalience } from '../src/memory/salience.js';
import { isLived, lived } from '../src/memory/lived.js';
import { DreamGate, defaultDreamGate, type DreamGateConfig } from '../src/memory/dream-gate.js';
import { DreamService } from '../src/memory/dream.js';
import { retention } from '../src/memory/probe.js';
import { defaultContextLimits } from '../src/shared/limits.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function entry(seq: number, kind: string, data: unknown = {}, source = 'world'): Experience {
  return { seq, at: 0, source, kind, data };
}

class FakeState implements DreamStateRepository {
  state: DreamState = { lastAt: 0, lastScanAt: 0, runsToday: 0, runDay: -1, blocked: {} };
  read(): DreamState { return { ...this.state, blocked: { ...this.state.blocked } }; }
  write(state: DreamState): void { this.state = state; }
}

class FakeExperience implements ExperienceLog {
  constructor(private readonly rows: Experience[]) {}
  read(after: number, limit: number) { return this.rows.filter(row => row.seq > after).slice(0, limit); }
  recent(_source: string, limit: number) { return this.rows.slice(-limit); }
  assertExists(): void {}
  record(): number { return 0; }
}

class FakeMemory implements MemoryRepository {
  readonly published: DreamVersion[] = [];
  private currentCursor = 0;
  constructor(private readonly total = 0) {}
  get(): Memory | undefined { return undefined; }
  search(): Memory[] { return []; }
  recent(): Memory[] { return []; }
  count(): number { return this.total; }
  publish(): void {}
  cursor(): number { return this.currentCursor; }
  publishDream(version: DreamVersion): void { this.published.push(version); this.currentCursor = version.cutoff; }
}

class FakeLock implements DreamLock {
  locked = false;
  acquire(): boolean { if (this.locked) return false; this.locked = true; return true; }
  release(): void { this.locked = false; }
  held(): boolean { return this.locked; }
}

function gateOf(rows: Experience[], overrides: Partial<DreamGateConfig> = {}, memories = 0) {
  const state = new FakeState();
  const lock = new FakeLock();
  const gate = new DreamGate({
    state, experience: new FakeExperience(rows), memory: new FakeMemory(memories), lock,
    config: { ...defaultDreamGate, ...overrides },
  });
  return { gate, state, lock };
}

test('时间下限没到就不整合，哪怕信号很强', () => {
  const { gate } = gateOf([entry(1, 'note.failure')], { minHours: 4 });
  const decision = gate.check(HOUR);
  assert.equal(decision.fire, false);
  assert.equal(decision.blockedBy, 'g2.time');
});

test('一次自己记下的失手就能越过显著性门控，不必先攒够会话数', () => {
  const { gate } = gateOf([entry(1, 'note.failure', { text: '答应小林整理复习节奏，一直没做' }, 'self')], { minHours: 1, minEpisodes: 50 });
  const decision = gate.check(2 * HOUR);
  assert.equal(decision.fire, true);
  assert.equal(decision.snapshot.salience.failures, 1);
});

test('扫描节流挡住紧邻的重复扫描，避免时间门控反复通过', () => {
  const { gate } = gateOf([], { minHours: 1, scanThrottleMs: 600_000 });
  assert.equal(gate.check(2 * HOUR).blockedBy, 'g4.signal');
  assert.equal(gate.check(2 * HOUR + 60_000).blockedBy, 'g3.throttle');
});

test('当天次数用尽后不再触发，跨天自动重置', () => {
  const { gate, state } = gateOf([entry(1, 'note.failure')], { minHours: 1, maxRunsPerDay: 1 });
  state.state.runDay = Math.floor(2 * HOUR / DAY);
  state.state.runsToday = 1;
  assert.equal(gate.check(2 * HOUR).blockedBy, 'g5.budget');
  state.state.runsToday = 0;
  // 隔开扫描节流窗口，否则挡在 g3 而不是真正检验预算重置。
  assert.equal(gate.check(2 * HOUR + 11 * 60_000).fire, true);
});

test('锁在执行侧获取，被占用时不并行整合', () => {
  const { gate, lock } = gateOf([], { minHours: 1 });
  lock.locked = true;
  assert.equal(gate.tryLock(), false);
  lock.locked = false;
  assert.equal(gate.tryLock(), true);
  gate.releaseDream();
  assert.equal(lock.locked, false);
});

test('门控只做决策，不因为作业排队就占住锁', () => {
  const { gate, lock } = gateOf([entry(1, 'note.failure')], { minHours: 1 });
  assert.equal(gate.check(2 * HOUR).fire, true);
  assert.equal(lock.locked, false);
});

test('拦截原因会累计，事后能看出为什么没整理', () => {
  const { gate, state } = gateOf([], { minHours: 4 });
  gate.check(HOUR);
  gate.check(2 * HOUR);
  assert.equal(state.state.blocked['g2.time'], 2);
});

test('普通观察再多也不单独构成整合理由', () => {
  const rows = Array.from({ length: 40 }, (_, index) => entry(index + 1, 'group.message', { text: '哈哈哈' }));
  const score = scoreSalience(rows);
  assert.equal(score.novelty, 40);
  assert.equal(score.total, 6);
});

test('系统流水不算新经验，避免拦得越多越容易触发、报错越多越要「反思人生」', () => {
  const rows = [
    entry(1, 'dream.gate.blocked', { blockedBy: 'g4.signal' }, 'runtime'),
    entry(2, 'dream.completed', { memories: 3 }, 'dream'),
    entry(3, 'job.error', { error: 'boom' }, 'runtime'),
    entry(4, 'schedule.fired', {}, 'runtime'),
    entry(5, 'tool.result', {}, 'operation:1'),
  ];
  const { gate } = gateOf(rows, { minHours: 1, minEpisodes: 1 });
  const decision = gate.check(2 * HOUR);
  assert.equal(decision.snapshot.episodes, 0);
  assert.equal(decision.snapshot.salience.total, 0);
  assert.equal(decision.fire, false);
  assert.equal(decision.blockedBy, 'g4.signal');
});

test('别人的话、自己的纸条和反思都算经历，机器流水一律不算', () => {
  const livedKinds = [
    entry(1, 'group.message', { name: '小林', text: '复习节奏有点乱' }),
    entry(2, 'note.promise', { about: '小林', text: '答应帮忙捋复习节奏' }, 'self'),
    entry(3, 'reflection', {}, 'self'),
    entry(4, 'affect.appraisal', {}, 'self'),
    entry(5, 'memory.miss', { query: '小林' }, 'self'),
  ];
  assert.deepEqual(lived(livedKinds).map(e => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(isLived(entry(6, 'job.error', {}, 'world')), false);
  assert.equal(isLived(entry(7, 'dream.gate', {}, 'runtime')), false);
});

test('记忆压力达到阈值时，即使没有新经验也会整理', () => {
  const { gate } = gateOf([], { minHours: 1, memoryBudget: 10, memoryPressure: 0.8 }, 9);
  assert.equal(gate.check(2 * HOUR).fire, true);
});

test('保留率能量出整合丢掉了哪些关键事实', () => {
  const result = retention(['鸟类数量在过去十年明显下降', '某地开始试点四天工作制'], ['鸟类数量下降']);
  assert.ok(result.rate < 1);
  assert.ok(result.lost.length > 0);
});

test('推论只有一处证据时整次整合被拒，观察允许单点', async () => {
  const service = (kind: 'observation' | 'inference', evidence: number[]) => new DreamService({
    repository: new FakeMemory(), experience: new FakeExperience([entry(1, 'group.message', { text: 'a' })]),
    model: new FakeModel({ summary: 'x', memories: [{ id: 'm1', content: '结论', evidence, kind }], proposals: [] }),
    feedback: { completed(): void {} }, limits: defaultContextLimits,
  });
  await assert.rejects(() => service('inference', [1]).prepare('d1', undefined, 0), /independent evidence/);
  await assert.doesNotReject(() => service('observation', [1]).prepare('d1', undefined, 0));
});

class FakeModel implements LanguageModel {
  constructor(private readonly output: unknown) {}
  async decide<T>(_request: ModelRequest<T>): Promise<T> { return this.output as T; }
}

/** 只记录模型实际看到的上下文，用来验证「系统流水没被当成经历交进去」。 */
class RecordingModel implements LanguageModel {
  readonly contexts: unknown[] = [];
  calls = 0;
  constructor(private readonly output: unknown) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    this.calls += 1;
    this.contexts.push(request.context);
    return this.output as T;
  }
}

test('Dream 只看经历过的事，但仍按全量推进游标', async () => {
  const memory = new FakeMemory();
  const model = new RecordingModel({ summary: 'x', proposals: [],
    memories: [{ id: 'm1', content: '小林最近为复习节奏焦虑', evidence: [1], kind: 'observation' }] });
  const rows = [
    entry(1, 'group.message', { name: '小林', text: '复习节奏有点乱' }),
    entry(2, 'job.error', { error: 'boom' }, 'runtime'),
    entry(3, 'dream.gate.blocked', {}, 'runtime'),
  ];
  const service = new DreamService({ repository: memory, experience: new FakeExperience(rows), model,
    feedback: { completed(): void {} }, limits: defaultContextLimits });
  const commit = await service.prepare('d1', undefined, 0);
  const context = model.contexts[0] as { experiences: Experience[] };
  assert.deepEqual(context.experiences.map(e => e.seq), [1]);
  commit();
  const published = memory.published[0];
  assert.ok(published);
  assert.equal(published.cutoff, 3);
});

test('一批全是机器流水时不调模型、不叫醒 self，但游标照样前进', async () => {
  const memory = new FakeMemory();
  const model = new RecordingModel({ summary: '不该被调用', memories: [], proposals: [] });
  let notified = 0;
  const service = new DreamService({
    repository: memory,
    experience: new FakeExperience([entry(1, 'job.error', {}, 'runtime'), entry(2, 'schedule.fired', {}, 'runtime')]),
    model, feedback: { completed(): void { notified += 1; } }, limits: defaultContextLimits,
  });
  const commit = await service.prepare('d2', undefined, 0);
  commit();
  assert.equal(model.calls, 0);
  assert.equal(notified, 0);
  const published = memory.published[0];
  assert.ok(published);
  assert.equal(published.cutoff, 2);
  assert.deepEqual(published.candidate.memories, []);
});
