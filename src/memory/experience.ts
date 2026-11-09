import type { ExperienceLog, ExperienceRepository } from './ports.js';
export class ExperienceService implements ExperienceLog {
  constructor(private readonly repository: ExperienceRepository) {}
  record(source: string, kind: string, data: unknown, now: number) { return this.repository.append(source, kind, data, now); }
  read(after: number, limit: number, source?: string) { return this.repository.read(after, limit, source); }
  recent(source: string, limit: number) { return this.repository.recent(source, limit); }
  assertExists(refs: number[]) { for (const seq of refs) if (!this.repository.exists(seq)) throw new Error(`Unknown evidence: ${seq}`); }
}
