import type { z } from 'zod';
export interface CapabilityScope { environment: string; scope: Record<string, string> }
export interface Capability {
  name: string; description: string; input: z.ZodType; effect: 'read' | 'write';
  authorize?(input: unknown, scope: CapabilityScope): void;
  run(input: unknown, context: { operationId: string; signal: AbortSignal; scope?: CapabilityScope }): Promise<unknown>;
}
export interface CapabilityRegistrar { register(capability: Capability): void }
export interface Operation {
  id: string; name: string; input: unknown; effect: 'read' | 'write';
  status: 'started' | 'completed' | 'uncertain' | 'failed'; at: number; result?: unknown; error?: string;
}
export interface OperationRepository { get(id: string): Operation | undefined; save(operation: Operation): void }
export interface CapabilityAccess {
  catalog(allowed: string[]): { name: string; description: string; effect: 'read' | 'write'; inputSchema: unknown }[];
  validate(names: string[], allowed: string[]): void;
  invoke(operationId: string, name: string, input: unknown, allowed: string[], now: number, scope?: CapabilityScope): Promise<unknown>;
}
export class UncertainOperation extends Error {}
