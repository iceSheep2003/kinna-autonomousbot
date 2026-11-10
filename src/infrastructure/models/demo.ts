import type { LanguageModel, ModelRequest } from '../../shared/model.js';
/** 离线流程演示，不声称具备真实自主推理；生产入口禁止隐式回退到此模型。 */
export class DemoModel implements LanguageModel {
  async decide<T>(request: ModelRequest<T>): Promise<T> {
    const c = request.context as Record<string, any>;
    let result: unknown;
    if (request.role === 'self') {
      result = (c.state?.revision ?? 0) === 0 ? {
        reflection: '我对环境中的知识感兴趣，先看看有哪些可探索的内容，再决定是否深入。',
        direction: '探索可接触的知识，形成有依据的兴趣。',
        goals: [{ id: 'learn-environment', content: '了解可探索的内容', horizon: 'short', status: 'active', reason: '初始好奇倾向', evidence: [] }],
        launch: [{ intent: '浏览演示环境并报告发现', goalId: 'learn-environment', tools: ['sandbox.observe'] }],
        nextWakeAt: c.state.now + 3600000,
      } : { reflection: '保留本次探索经验，等待新的线索；不重复启动相同活动。', nextWakeAt: c.state.now + 3600000 };
    } else if (request.role === 'execution') {
      result = c.state.steps === 0
        ? { type: 'tool', name: 'sandbox.observe', input: {}, progress: '观察当前环境' }
        : { type: 'complete', result: '演示环境中有一篇关于鸟类迁徙的内容，可以作为后续兴趣线索。', evidence: c.observations.map((e: any) => e.seq) };
    } else if (request.role === 'scene') {
      result = { type: 'wait', summary: '演示场景暂时等待新的观察。' };
    } else {
      const observation = c.experiences.find((e: any) => e.kind === 'tool.result' && e.data.name === 'sandbox.observe');
      result = { summary: '已整理当前探索记录', memories: observation ? [{ id: 'environment-observation', content: '演示环境提供了鸟类迁徙内容。此记录仅是流程演示。', kind: 'observation', evidence: [observation.seq] }] : [], proposals: observation ? ['下次可考虑是否进一步了解迁徙。'] : [] };
    }
    return request.schema.parse(result);
  }
}
