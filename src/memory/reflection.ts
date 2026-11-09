import { randomUUID } from 'node:crypto';
import type { ExperienceLog, ReflectionRepository } from './ports.js';
import type { Reflection } from './types.js';
/** 总结/反思是有来源的独立记录，不能通过此接口直接改目标。 */
export class ReflectionService {
  constructor(private readonly repository: ReflectionRepository, private readonly experience: ExperienceLog) {}
  record(input: Omit<Reflection, 'id' | 'at'>, now: number): string {
    this.experience.assertExists(input.sourceRefs);
    const reflection = { ...input, id: randomUUID(), at: now };
    this.repository.save(reflection);
    this.experience.record('self', 'reflection', reflection, now);
    return reflection.id;
  }
  read(id: string) { return this.repository.get(id); }
}
