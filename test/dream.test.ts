import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageModel, ModelRequest } from '../src/shared/model.js';
import type { DreamLock, DreamState, DreamStateRepository, ExperienceLog, MemoryRepository } from '../src/memory/ports.js';
import type { Experience, Memory } from '../src/memory/types.js';
import { scoreSalience } from '../src/memory/salience.js';
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
  constructor(private readonly total = 0) {}
  get(): Memory | undefined { return undefined; }
  search(): Memory[] { return []; }
  recent(): Memory[] { return []; }
  count(): number { return this.total; }
  publish(): void {}
  cursor(): number { return 0; }
  publishDream(): void {}
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
  const { gate } = gateOf([entry(1, 'job.error')], { minHours: 4 });
  const decision = gate.check(HOUR);
  assert.equal(decision.fire, false);
  assert.equal(decision.blockedBy, 'g2.time');
});

test('一次失败就能越过显著性门控，不必先攒够会话数', () => {
  const { gate } = gateOf([entry(1, 'job.error', { error: 'boom' })], { minHours: 1, minEpisodes: 50 });
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
  const { gate, state } = gateOf([entry(1, 'job.error')], { minHours: 1, maxRunsPerDay: 1 });
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
  const { gate, lock } = gateOf([entry(1, 'job.error')], { minHours: 1 });
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

test('门控自己的记账不算新经验，避免拦得越多越容易触发', () => {
  const rows = [entry(1, 'dream.gate.blocked', { blockedBy: 'g4.signal' }), entry(2, 'dream.completed', { memories: 3 })];
  const { gate } = gateOf(rows, { minHours: 1, minEpisodes: 1 });
  const decision = gate.check(2 * HOUR);
  assert.equal(decision.snapshot.episodes, 0);
  assert.equal(decision.fire, false);
  assert.equal(decision.blockedBy, 'g4.signal');
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
