import type { Repositories } from '../../app/repositories.js';
import type { Store } from './database.js';
import { SqliteSubjectRepository, SqliteGoalRepository } from './subject.js';
import { SqliteAffectStore } from './affect.js';
import { SqliteSelfSessionRepository } from './sessions.js';
import { SqliteExecutionRepository } from './execution.js';
import { SqliteExperienceRepository, SqliteMemoryRepository, SqliteReflectionRepository, SqliteDreamStateRepository } from './memory.js';
import { SqliteJobQueue, SqliteRuntimeRepository, SqliteBudgetRepository, SqliteScheduleRepository } from './runtime.js';
import { SqliteOperationRepository } from './operations.js';
import { SqliteSceneSessions } from './scenes.js';
export function sqliteRepositories(db: Store): Repositories {
  return { transaction: { run: fn => db.transaction(fn) }, subject: new SqliteSubjectRepository(db), goals: new SqliteGoalRepository(db),
    affect: new SqliteAffectStore(db),
    selfSession: new SqliteSelfSessionRepository(db), execution: new SqliteExecutionRepository(db),
    experience: new SqliteExperienceRepository(db), memory: new SqliteMemoryRepository(db), reflection: new SqliteReflectionRepository(db),
    dreamState: new SqliteDreamStateRepository(db),
    jobs: new SqliteJobQueue(db), runtime: new SqliteRuntimeRepository(db), budget: new SqliteBudgetRepository(db),
    schedules: new SqliteScheduleRepository(db), operations: new SqliteOperationRepository(db), scenes: new SqliteSceneSessions(db) };
}
