import type { AdminApi } from '../../app/admin.js';
import type { Agent } from '../../app/agent.js';
import type { Store } from './database.js';
export function sqliteAdmin(db: Store, agent: Agent): AdminApi {
  return {
    self: () => agent.subject.read(), list: (collection, limit, offset) => db.list(collection === 'scenes' ? 'scene.sessions' : collection, limit, offset),
    experiences: (after, limit, source) => agent.experience.read(after, limit, source),
    turns: (id, limit) => db.turns(id, limit),
    jobs: () => db.db.prepare('SELECT id,kind,key,status,attempts,dueAt,error FROM jobs ORDER BY rowid DESC LIMIT 100').all(),
    capabilities: agent.capabilities, ingest: event => agent.runtime.ingest(event),
  };
}
