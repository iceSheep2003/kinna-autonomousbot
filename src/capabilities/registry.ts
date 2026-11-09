import { z } from 'zod';
import { UncertainOperation, type Capability, type CapabilityAccess, type CapabilityScope, type OperationRepository } from './ports.js';
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
  async invoke(operationId: string, name: string, input: unknown, allowed: string[], now: number, scope?: CapabilityScope): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool || !allowed.includes(name)) throw new Error(`Capability denied: ${name}`);
    const parsed = tool.input.parse(input);
    if (scope) tool.authorize?.(parsed, scope);
    const existing = this.operations.get(operationId);
    if (existing?.status === 'completed') return existing.result;
    if (existing && existing.effect === 'write') throw new UncertainOperation(`Operation ${operationId} may have taken effect; reconciliation required`);
    this.operations.save( { id: operationId, name, input: parsed, effect: tool.effect, status: 'started', at: now });
    try {
      const signal = AbortSignal.timeout(30000);
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => tool.run(parsed, { operationId, signal, scope }))
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      // 工具返回值限制在上下文预算内；完整大文件应由插件保存为资源引用。
      if (JSON.stringify(result ?? null).length > 24000) throw new Error('Tool output too large; return resource references');
      this.operations.save( { id: operationId, name, input: parsed, effect: tool.effect, status: 'completed', result: result ?? null, at: now });
      return result ?? null;
    } catch (error) {
      this.operations.save( { id: operationId, name, input: parsed, effect: tool.effect, status: tool.effect === 'write' ? 'uncertain' : 'failed', error: String(error), at: now });
      if (tool.effect === 'write') throw new UncertainOperation(String(error));
      throw error;
    }
  }
}
