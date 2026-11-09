import type { Capability } from '../capabilities/ports.js';
import type { IncomingEvent } from '../runtime/types.js';

/** 平台适配器只注册能力、提供资源、投递事件；不直接写主体/目标/记忆。 */
export interface EnvironmentPlugin {
  name: string;
  setup(context: { register(capability: Capability): void }): void | Promise<void>;
  start?(context: { emit(event: IncomingEvent): void }): void | Promise<void>;
  stop?(): void | Promise<void>;
}
