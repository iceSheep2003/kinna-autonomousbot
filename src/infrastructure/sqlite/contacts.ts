import type { ContactPlan, ContactStore } from '../../self/contacts.js';
import type { Store } from './database.js';

/** 「打算找谁聊聊」的计划：存 documents，和待办平级。 */
export class SqliteContactStore implements ContactStore {
  constructor(private readonly store: Store) {}
  list(): ContactPlan[] { return this.store.list<ContactPlan>('self.contacts'); }
  save(plan: ContactPlan): void { this.store.put('self.contacts', plan.id, plan); }
  get(id: string): ContactPlan | undefined { return this.store.get<ContactPlan>('self.contacts', id); }
}
