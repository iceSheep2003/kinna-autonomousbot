import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { EnvironmentPlugin } from './plugin.js';
import type { CapabilityRegistrar } from '../capabilities/ports.js';

export async function loadPlugins(paths: string[], registry: CapabilityRegistrar): Promise<EnvironmentPlugin[]> {
  const plugins: EnvironmentPlugin[] = [];
  for (const path of paths) {
    // 只有部署配置能载入本地代码，模型不能安装/修改插件。
    const module = await import(pathToFileURL(resolve(path)).href) as { default: EnvironmentPlugin };
    const plugin = module.default;
    if (!plugin?.name || typeof plugin.setup !== 'function') throw new Error(`Invalid plugin: ${path}`);
    if (plugins.some(p => p.name === plugin.name)) throw new Error(`Duplicate plugin: ${plugin.name}`);
    await plugin.setup({ register: capability => registry.register(capability) });
    plugins.push(plugin);
  }
  return plugins;
}
