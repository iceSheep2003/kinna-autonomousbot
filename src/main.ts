import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './infrastructure/sqlite/database.js';
import { sqliteRepositories } from './infrastructure/sqlite/repositories.js';
import { sqliteAdmin } from './infrastructure/sqlite/admin.js';
import { composeAgent } from './app/agent.js';
import { ConfigSchema } from './app/config.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { registerBraveSearch, registerConversation, registerMemory, registerNotes } from './integrations/builtin.js';
import { OpenAICompatibleModel } from './infrastructure/models/openai-compatible.js';
import { profilesFromEnv } from './infrastructure/models/profiles.js';
import { createDreamLock } from './infrastructure/locks/dream-lock.js';
import { createServer } from './infrastructure/http/server.js';
import { loadPlugins } from './integrations/loader.js';
import { createQqEnvironment } from './infrastructure/qq/environment.js';
import { SqliteQqState } from './infrastructure/sqlite/qq.js';
import { createBilibiliPlugin } from './integrations/bilibili/plugin.js';
import { DraftQueue } from './integrations/bilibili/drafts.js';
import { BilibiliConfigSchema } from './integrations/bilibili/types.js';
import { BilibiliHttp } from './infrastructure/bilibili/client.js';
import { BilibiliLogin } from './infrastructure/bilibili/login.js';
import { SqliteSessionStore } from './infrastructure/sqlite/bilibili-session.js';
import { SessionHost } from './app/bilibili-session.js';
import { credentialsOf, sessionFromEnv } from './integrations/bilibili/session.js';
import { BilibiliApi } from './infrastructure/bilibili/api.js';
import { DanmakuHeat } from './infrastructure/bilibili/heat.js';
import { BrowserShots } from './infrastructure/bilibili/shots.js';
import { recentVideosOf } from './infrastructure/bilibili/space.js';
import { SqliteBilibiliState } from './infrastructure/sqlite/bilibili.js';

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
// B 站：登录态只从环境读；草稿与额度存本地库；没有登录态也能读，但不能写。
const bilibiliConfig = config.bilibili ?? BilibiliConfigSchema.parse({});
const bilibiliState = new SqliteBilibiliState(store);
// 登录会话：环境变量优先（部署在密钥管理里时不用扫码），否则用库里托管的扫码会话。
const sessionStore = new SqliteSessionStore(store);
const sessionHost = new SessionHost({ store: sessionStore, refresher: new BilibiliLogin() });
const envSession = sessionFromEnv(process.env);
if (envSession && !sessionStore.read()) sessionHost.adopt(envSession);
const bilibiliTransport = new BilibiliHttp(credentialsOf(sessionHost.session()), reason => sessionHost.markInvalid(reason));
const bilibiliApi = new BilibiliApi(bilibiliTransport);
const bilibiliDrafts = new DraftQueue({ state: bilibiliState, config: bilibiliConfig, messages: bilibiliApi });
if (bilibiliConfig.enabled) {
  plugins.push(createBilibiliPlugin({
    config: bilibiliConfig, video: bilibiliApi, messages: bilibiliApi, drafts: bilibiliDrafts,
    heat: new DanmakuHeat(bilibiliTransport), stream: input => bilibiliApi.streamUrl(input),
    // 没配 publicBaseUrl 时截图以内联 data URL 给出，本地不用架隧道；配了就走 URL 省带宽。
    ...(bilibiliConfig.publicBaseUrl ? { publicBaseUrl: bilibiliConfig.publicBaseUrl } : {}),
    ...(bilibiliConfig.readVideo ? { shots: new BrowserShots({
      ...(bilibiliConfig.publicBaseUrl ? { publicBaseUrl: bilibiliConfig.publicBaseUrl } : {}),
      outputDir: resolve(process.env.BILIBILI_SHOT_DIR ?? 'data/public/shots'),
    }) } : {}),
    recentVideos: process.env.BILIBILI_MID ? recentVideosOf(bilibiliTransport, process.env.BILIBILI_MID) : undefined,
  }));
}
const model = new OpenAICompatibleModel({ baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1', apiKey: LLM_API_KEY, model: LLM_MODEL, profiles: profilesFromEnv(process.env) });
const agent = composeAgent(repositories, model, capabilities, { ...config, dreamLock: createDreamLock(resolve(process.env.DREAM_LOCK_PATH ?? 'data/dream.lock')) });
registerMemory(capabilities, agent.memory, agent.experience);
registerNotes(capabilities, agent.experience);
registerConversation(capabilities, agent.experience);
capabilities.validate(config.boundaries.allowedTools, config.boundaries.allowedTools);
const runtime = agent.runtime;
runtime.start();
for (const plugin of plugins) await plugin.start?.({ emit: event => { runtime.ingest(event); } });
const adminApi = sqliteAdmin(store, agent);
// 只有 owner 令牌能走到这里；模型没有任何工具能调用 approvals。
const approvals = bilibiliConfig.enabled ? {
  list: () => { bilibiliDrafts.expire(); return bilibiliDrafts.pending(); },
  approve: async (id: string) => { const r = await bilibiliDrafts.approve(id, { by: 'owner' }); return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), ...(r.draft?.postedId ? { postedId: r.draft.postedId } : {}) }; },
  reject: (id: string, note?: string) => { const r = bilibiliDrafts.reject(id, { by: 'owner', ...(note ? { note } : {}) }); return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) }; },
} : undefined;
// 登录：二维码内容给 owner 扫，cookie 只在服务端保存；任何响应都不回传 SESSDATA/bili_jct。
const login = new BilibiliLogin();
const bilibiliAuth = bilibiliConfig.enabled ? {
  status: () => {
    const session = sessionHost.session();
    return { loggedIn: Boolean(session), ...(session ? { source: session.source, verifiedAt: session.verifiedAt ?? session.obtainedAt } : {}),
      hasRefreshToken: Boolean(session?.refreshToken) };
  },
  startQr: () => login.generateQr(AbortSignal.timeout(15000)),
  pollQr: async (qrcodeKey: string) => {
    const result = await login.pollQr(qrcodeKey, AbortSignal.timeout(15000));
    if (result.status === 'ok' && result.session) {
      sessionHost.adopt(result.session);
      bilibiliTransport.setCredentials(credentialsOf(result.session));
    }
    return { status: result.status };
  },
  refresh: () => sessionHost.ensureFresh(),
  logout: () => { sessionHost.clear(); bilibiliTransport.setCredentials(undefined); return { ok: true }; },
} : undefined;
const app = createServer({ ...adminApi,
  ...(approvals ? { approvals: () => approvals } : {}),
  ...(bilibiliAuth ? { bilibiliAuth: () => bilibiliAuth } : {}) }, API_TOKEN);
// 启动后每天检查一次 Cookie 是否需要刷新；失败只记日志，不影响其他能力。
setInterval(() => { void sessionHost.ensureFresh().then(result => {
  if (result.refreshed) console.log('[bilibili] session refreshed');
  else if (result.reason && !result.reason.includes('还没到')) console.log('[bilibili] session check:', result.reason);
}); }, 6 * 3600_000).unref();
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
