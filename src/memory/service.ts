import type { MemoryRepository, MemoryView } from './ports.js';
export class MemoryService implements MemoryView {
  constructor(private readonly repository: MemoryRepository) {}
  recall(query: string, limit: number) { return this.repository.search(query, limit); }
}
