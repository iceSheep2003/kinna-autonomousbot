import type { DreamLock, DreamState, DreamStateRepository, ExperienceLog, MemoryRepository } from './ports.js';
import { scoreSalience, type SalienceScore } from './salience.js';
import { lived } from './lived.js';

/**
 * Dream 触发门控：按开销从低到高逐级淘汰，任一道拦下就静默返回。
 *
 * 与 AutoDream 的两处关键差异：
 *
 * 1. 信号之间是「或」不是「且」。AutoDream 要求时间够 24h **且** 攒够 5 个会话，
 *    于是一次严重失败要等到明天。这里只要体积、显著性、压力任一达标就触发，
 *    时间只作为下限，防止高频抖动。
 * 2. 多了一道「值不值得」的判断。数量够不等于有事发生，显著性按信息密度加权。
 *
 * 每次检查都写回 state.blocked 计数，所以「为什么没触发」是可观测的，不是猜的。
 */
export const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface DreamGateConfig {
  enabled: boolean;
  /** 时间下限：两次整合至少隔多久，防抖。 */
  minHours: number;
  /** 扫描节流：时间门控通过但后续门控没过时，锁时间不前进，否则每轮都会重扫。 */
  scanThrottleMs: number;
  /** 体积：未整合经验达到多少条就值得整合。 */
  minEpisodes: number;
  /** 显著性：失败/纠正/落空的加权分达到多少就值得整合。 */
  salienceThreshold: number;
  /** 压力：记忆条数 / memoryBudget，超过比例说明检索精度在下降。 */
  memoryBudget: number;
  memoryPressure: number;
  /** 预算：每个逻辑日最多整合几次。 */
  maxRunsPerDay: number;
  /** 单批最多读多少条未整合经验。 */
  batch: number;
}

export const defaultDreamGate: DreamGateConfig = {
  enabled: true, minHours: 4, scanThrottleMs: 10 * 60_000, minEpisodes: 20,
  salienceThreshold: 3, memoryBudget: 60, memoryPressure: 0.8, maxRunsPerDay: 6, batch: 80,
};

export interface GateSnapshot {
  hoursSince: number; episodes: number; salience: SalienceScore;
  memories: number; memoryPressure: number; runsToday: number;
}

export interface GateDecision {
  fire: boolean; blockedBy: string; snapshot: GateSnapshot;
}

export interface DreamGateDeps {
  state: DreamStateRepository; experience: ExperienceLog; memory: MemoryRepository;
  lock: DreamLock; config: DreamGateConfig;
}

export class DreamGate {
  private readonly deps: DreamGateDeps;
  private locked = false;
  constructor(deps: DreamGateDeps) { this.deps = deps; }

  check(now: number): GateDecision {
    const state = this.deps.state.read();
    const next: DreamState = { ...state, blocked: { ...state.blocked } };
    if (next.runDay !== Math.floor(now / DAY)) { next.runDay = Math.floor(now / DAY); next.runsToday = 0; }
    const snapshot = this.snapshot(state, now);
    const blockedBy = this.evaluate(next, snapshot, now);
    if (blockedBy !== 'fire') next.blocked[blockedBy] = (next.blocked[blockedBy] ?? 0) + 1;
    this.deps.state.write(next);
    return { fire: blockedBy === 'fire', blockedBy, snapshot };
  }

  /** 由 Dream 提交成功时回调，推进「上次整合时间」。失败不推进，下次自然重试。 */
  markConsolidated(now: number): void {
    const state = this.deps.state.read();
    this.deps.state.write({ ...state, lastAt: now, runsToday: state.runsToday + 1 });
  }

  /**
   * 锁只在执行侧获取。门控只回答「该不该整合」，不该在 enqueue→claim 的空档里占着锁：
   * 作业可能排在别的作业后面，这段时间门控会一直看到锁被占，白白刷出一堆拦截记录。
   */
  tryLock(): boolean {
    if (this.locked) return true;
    this.locked = this.deps.lock.acquire();
    return this.locked;
  }

  releaseDream(): void {
    if (!this.locked) return;
    this.deps.lock.release();
    this.locked = false;
  }

  private evaluate(state: DreamState, snapshot: GateSnapshot, now: number): string {
    const config = this.deps.config;
    if (!config.enabled) return 'g1.disabled';
    if (now - state.lastAt < config.minHours * HOUR) return 'g2.time';
    if (now - state.lastScanAt < config.scanThrottleMs) return 'g3.throttle';
    state.lastScanAt = now;
    if (!this.signal(snapshot)) return 'g4.signal';
    if (snapshot.runsToday >= config.maxRunsPerDay) return 'g5.budget';
    return 'fire';
  }

  /** 三条信号取「或」：攒够了、有事发生、或者记忆该整理了。 */
  private signal(snapshot: GateSnapshot): boolean {
    const config = this.deps.config;
    return snapshot.episodes >= config.minEpisodes
      || snapshot.salience.total >= config.salienceThreshold
      || snapshot.memoryPressure >= config.memoryPressure;
  }

  private snapshot(state: DreamState, now: number): GateSnapshot {
    const pending = this.deps.experience.read(this.deps.memory.cursor(), this.deps.config.batch);
    // 只数「经历过的事」。门控自己的记账、作业报错、调度心跳都不算新生活，
    // 否则会自我触发：拦下 → 写一条拦截记录 → 记录被算成新经验 → 下次更容易触发。
    const informative = lived(pending);
    const memories = this.deps.memory.count();
    return {
      hoursSince: Number(((now - state.lastAt) / HOUR).toFixed(2)),
      episodes: informative.length,
      salience: scoreSalience(informative),
      memories,
      memoryPressure: Number((memories / this.deps.config.memoryBudget).toFixed(2)),
      runsToday: state.runsToday,
    };
  }
}
