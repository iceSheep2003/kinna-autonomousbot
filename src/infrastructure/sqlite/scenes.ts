import type { SceneSessionRepository } from '../../execution/ports.js';
import type { SceneSessionState, SceneStep } from '../../execution/scene-types.js';
import type { Store } from './database.js';
import { recentDecisions } from './sessions.js';
export class SqliteSceneSessions implements SceneSessionRepository {
  constructor(private readonly db: Store) {}
  get(id: string) { return this.db.get<SceneSessionState>('scene.sessions', id); }
  save(session: SceneSessionState) { this.db.put('scene.sessions', session.id, session); }
  step(id: string) { return this.db.get<SceneStep>('scene.steps', id); }
  saveStep(id: string, step: SceneStep) { this.db.put('scene.steps', id, step); }
  recentDecisions(id: string, limit: number) { return recentDecisions(this.db, `scene:${id}`, limit); }
  appendTurn(id: string, turn: { at: number; context: unknown; decision: unknown }) { this.db.appendTurn(`scene:${id}`, turn); }
}
