import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './infrastructure/sqlite/database.js';
import { sqliteRepositories } from './infrastructure/sqlite/repositories.js';
import { sqliteAdmin } from './infrastructure/sqlite/admin.js';
import { composeAgent } from './app/agent.js';
import { ConfigSchema } from './app/config.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { registerBraveSearch, registerMemory } from './integrations/builtin.js';
import { OpenAICompatibleModel } from './infrastructure/models/openai-compatible.js';
import { createServer } from './infrastructure/http/server.js';
import { loadPlugins } from './integrations/loader.js';
import { createQqEnvironment } from './infrastructure/qq/environment.js';
import { SqliteQqState } from './infrastructure/sqlite/qq.js';

const { LLM_API_KEY, LLM_MODEL, API_TOKEN } = process.env;
if (!LLM_API_KEY || !LLM_MODEL || !API_TOKEN || API_TOKEN.length < 24) throw new Error('Set LLM_API_KEY, LLM_MODEL, and API_TOKEN (at least 24 characters). See README.');
const config = ConfigSchema.parse(process.env.AGENT_CONFIG ? JSON.parse(readFileSync(process.env.AGENT_CONFIG, 'utf8')) : {});
const databasePath = resolve(process.env.DATABASE_PATH ?? 'data/agent.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const store = new Store(databasePath);
const repositories = sqliteRepositories(store);
const capabilities = new CapabilityRegistry(repositories.operations);
if (process.env.BRAVE_API_KEY) registerBraveSearch(capabilities, process.env.BRAVE_API_KEY);
const plugins = await loadPlugins(config.plugins, capabilities);
if (config.qq) {
  if (plugins.some(plugin => plugin.name === 'qq')) throw new Error('QQ plugin already registered');
  const qq = await createQqEnvironment(config.qq, new SqliteQqState(store), process.env);
  await qq.setup({ register: capability => capabilities.register(capability) });
  plugins.push(qq);
}
const model = new OpenAICompatibleModel({ baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1', apiKey: LLM_API_KEY, model: LLM_MODEL });
const agent = composeAgent(repositories, model, capabilities, config);
registerMemory(capabilities, agent.memory, agent.experience);
capabilities.validate(config.boundaries.allowedTools, config.boundaries.allowedTools);
const runtime = agent.runtime;
runtime.start();
for (const plugin of plugins) await plugin.start?.({ emit: event => { runtime.ingest(event); } });
const app = createServer(sqliteAdmin(store, agent), API_TOKEN);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
let stopped = false;
let active: Promise<unknown> = Promise.resolve();
let inFlight = false;
const timer = setInterval(() => {
  if (stopped || inFlight) return;
  inFlight = true;
  active = runtime.tick().catch(error => app.log.error(error)).finally(() => { inFlight = false; });
}, 1000);
async function shutdown() {
  if (stopped) return;
  stopped = true; clearInterval(timer);
  for (const plugin of [...plugins].reverse()) await plugin.stop?.();
  await app.close();
  // tick 自身串行化；停止接收事件后等在途调用落盘。
  await active;
  runtime.stop(); store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
