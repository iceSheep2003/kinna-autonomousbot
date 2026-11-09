import type { UnitOfWork } from '../shared/transaction.js';
import type { SubjectRepository, GoalRepository } from '../subject/ports.js';
import type { SelfSessionRepository } from '../self/ports.js';
import type { ExecutionRepository, SceneSessionRepository } from '../execution/ports.js';
import type { ExperienceRepository, MemoryRepository, ReflectionRepository, DreamStateRepository } from '../memory/ports.js';
import type { JobQueue, RuntimeRepository, BudgetRepository, ScheduleRepository } from '../runtime/ports.js';
import type { OperationRepository } from '../capabilities/ports.js';
/** 仅 composition root 持有全套依赖；每个模块拿到自己需要的窄接口。 */
export interface Repositories {
  transaction: UnitOfWork; subject: SubjectRepository; goals: GoalRepository; selfSession: SelfSessionRepository;
  execution: ExecutionRepository; experience: ExperienceRepository; memory: MemoryRepository; reflection: ReflectionRepository;
  dreamState: DreamStateRepository;
  scenes: SceneSessionRepository;
  jobs: JobQueue; runtime: RuntimeRepository; budget: BudgetRepository; schedules: ScheduleRepository; operations: OperationRepository;
}
