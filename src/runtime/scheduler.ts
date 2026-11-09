import type { SchedulePolicy, ScheduleRepository } from './ports.js';
import { ScheduleInputSchema, type ScheduleInput } from './types.js';

export class Scheduler {
  constructor(private readonly repository: ScheduleRepository, private readonly policy: SchedulePolicy,
    private readonly notify: (kind: string, data: unknown, now: number) => void, private readonly hasCapacity: () => boolean) {}
  pending(limit: number) { return this.repository.pending(limit); }
  schedule(raw: ScheduleInput, now: number): void {
    const input = ScheduleInputSchema.parse(raw);
    if (input.id.startsWith('system.')) throw new Error('Reserved schedule id');
    this.save(input, now);
  }
  wakeAt(at: number, now: number): void {
    this.save({ id: 'system.self.next', dueAt: at, action: { type: 'wake', reason: 'self requested reconsideration' } }, now);
  }
  private save(input: ScheduleInput, now: number): void {
    if (input.dueAt <= now) throw new Error('Schedule must be in the future');
    this.policy.validate(input.action);
    const goalRevision = this.policy.goalRevision(input.goalId);
    this.repository.save({ ...input, goalRevision, status: 'pending' });
  }
  cancel(id: string): void {
    const schedule = this.repository.get(id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    if (schedule.status === 'pending') this.repository.save({ ...schedule, status: 'cancelled' });
  }
  invalidateGoal(id: string): void { this.repository.cancelForGoal(id); }
  fireDue(now: number): void {
    for (const schedule of this.repository.due(now, 20)) {
      if (!this.hasCapacity()) break;
      if (!this.policy.stillValid(schedule)) { this.repository.save({ ...schedule, status: 'cancelled' }); continue; }
      try {
        this.policy.validate(schedule.action);
      } catch (error) {
        this.notify('schedule.rejected', { scheduleId: schedule.id, error: String(error) }, now);
        this.repository.save({ ...schedule, status: 'cancelled' }); continue;
      }
      if (schedule.action.type === 'wake') this.notify('schedule.due', { scheduleId: schedule.id, reason: schedule.action.reason }, now);
      else this.policy.execute(schedule, now);
      this.repository.save({ ...schedule, status: 'fired' });
    }
  }
}
