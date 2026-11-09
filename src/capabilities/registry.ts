import { z } from 'zod';
import { payloadBudget } from '../shared/limits.js';
import { UncertainOperation, type Capability, type CapabilityAccess, type InvocationRequest, type OperationRepository } from './ports.js';

const TOOL_TIMEOUT_MS = 30000;

export class CapabilityRegistry implements CapabilityAccess {
  constructor(private readonly operations: OperationRepository) {}
  private readonly tools = new Map<string, Capability>();
  register(tool: Capability): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate capability: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  catalog(allowed: string[]) {
    return [...this.tools.values()].filter(t => allowed.includes(t.name)).map(t => ({ name: t.name, description: t.description, effect: t.effect, inputSchema: z.toJSONSchema(t.input, { io: 'input' }) }));
  }
  validate(names: string[], allowed: string[]): void {
    for (const name of names) {
      if (!allowed.includes(name) || !this.tools.has(name)) throw new Error(`Capability unavailable: ${name}`);
    }
  }
  async invoke(request: InvocationRequest): Promise<unknown> {
    const tool = this.resolve(request.name, request.allowed);
    const input = tool.input.parse(request.input);
    if (request.scope) tool.authorize?.(input, request.scope);
    const replay = this.replay(request.operationId);
    if (replay.hit) return replay.result;
    return this.execute(tool, input, request);
  }
  /** 先记账再调用：崩溃后重放能区分“没发生”和“可能已发生”。 */
  private async execute(tool: Capability, input: unknown, request: InvocationRequest): Promise<unknown> {
    this.record(tool, request, input, { status: 'started' });
    try {
      const result = await this.runTool(tool, input, request);
      this.assertSize(result);
      this.record(tool, request, input, { status: 'completed', result: result ?? null });
      return result ?? null;
    } catch (error) {
      this.record(tool, request, input, { status: tool.effect === 'write' ? 'uncertain' : 'failed', error: String(error) });
      if (tool.effect === 'write') throw new UncertainOperation(String(error));
      throw error;
    }
  }
  private assertSize(result: unknown): void {
    // 工具返回值必须留在上下文预算内；完整大文件由插件保存为资源引用。
    if (JSON.stringify(result ?? null).length > payloadBudget.toolResultChars) throw new Error('Tool output too large; return resource references');
  }
  private resolve(name: string, allowed: string[]): Capability {
    const tool = this.tools.get(name);
    if (!tool || !allowed.includes(name)) throw new Error(`Capability denied: ${name}`);
    return tool;
  }
  /** 已完成的调用复用回执；写操作状态未知时暂停，不盲目重发。 */
  private replay(operationId: string): { hit: boolean; result?: unknown } {
    const existing = this.operations.get(operationId);
    if (existing?.status === 'completed') return { hit: true, result: existing.result };
    if (existing?.effect === 'write') throw new UncertainOperation(`Operation ${operationId} may have taken effect; reconciliation required`);
    return { hit: false };
  }
  private record(tool: Capability, request: InvocationRequest, input: unknown, outcome: Pick<import('./ports.js').Operation, 'status'> & { result?: unknown; error?: string }): void {
    this.operations.save({ id: request.operationId, name: tool.name, input, effect: tool.effect, at: request.now, ...outcome });
  }
  private runTool(tool: Capability, input: unknown, request: InvocationRequest): Promise<unknown> {
    const signal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => tool.run(input, { operationId: request.operationId, signal, scope: request.scope }))
        .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
