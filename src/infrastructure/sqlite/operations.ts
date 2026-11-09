import type { OperationRepository, Operation } from '../../capabilities/ports.js';
import type { Store } from './database.js';
export class SqliteOperationRepository implements OperationRepository {
  constructor(private readonly db: Store) {}
  get(id: string) { return this.db.get<Operation>('operations', id); }
  save(operation: Operation) { this.db.put('operations', operation.id, operation); }
}
