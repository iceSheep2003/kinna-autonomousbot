import type { LanguageModel, ModelRequest } from '../shared/model.js';
import type { BudgetRepository } from './ports.js';
export class BudgetExceeded extends Error {}
/** 只在真正调用模型时扣额度；恢复已保存的工具选择不会重复计费。 */
export class BudgetedModel implements LanguageModel {
  constructor(private readonly model: LanguageModel, private readonly repository: BudgetRepository,
    private readonly max: number, private readonly clock: () => number) {}
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    if (!this.repository.reserve(this.clock(), this.max)) throw new BudgetExceeded('Hourly model budget exhausted');
    return this.model.decide(request);
  }
}
