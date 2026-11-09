import { z } from 'zod';
import type { EnvironmentPlugin } from '../src/integrations/plugin.js';

/** 替换此处的模拟内容为平台 SDK。不要把 API 密钥或原始 cookie 返回给模型。 */
const plugin: EnvironmentPlugin = {
  name: 'local-environment',
  setup({ register }) {
    register({
      name: 'local.explore', description: '读取本地模拟环境的公开内容',
      effect: 'read', input: z.object({}),
      async run() {
        return { simulated: true, items: [{ id: 'a', title: '鸟类迁徙', excerpt: '用于测试探索行为的模拟资料。' }] };
      },
    });
  },
  start({ emit }) {
    emit({ id: 'environment-ready-v1', source: 'local', kind: 'environment.available',
      data: { description: '可以通过 local.explore 观察环境' }, route: { type: 'self' } });
  },
};
export default plugin;
