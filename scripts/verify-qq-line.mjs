#!/usr/bin/env node
/**
 * QQ 整条线的端到端验证：起真实的反向网关 + 真实插件，用一个模拟 NapCat 的
 * OneBot 客户端发消息，看解析出来的对话记录长什么样。
 *
 * 为什么用模拟客户端而不是连线上：线上那台是 Node 20（本项目要 Node 22+ 的 node:sqlite），
 * 而且 6199 端口被现有 bot 占着。改 NapCat 配置接第二个客户端有打扰线上回复的风险。
 * 模拟客户端发的是**真实 OneBot 报文格式**，覆盖引用/图片/语音这三条最容易断的路。
 */
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/src/infrastructure/sqlite/database.js';
import { SqliteQqState } from '../dist/src/infrastructure/sqlite/qq.js';
import { ReverseOneBotGateway } from '../dist/src/infrastructure/qq/onebot-gateway.js';
import { createQqPlugin } from '../dist/src/integrations/qq/plugin.js';
import { QqConfigSchema } from '../dist/src/integrations/qq/types.js';
import { transcriptWindow } from '../dist/src/execution/transcript.js';
import { composeAgent } from '../dist/src/app/agent.js';
import { sqliteRepositories } from '../dist/src/infrastructure/sqlite/repositories.js';
import { ConfigSchema } from '../dist/src/app/config.js';
import { CapabilityRegistry } from '../dist/src/capabilities/registry.js';

const SELF = '99', GROUP = '123', USER = '3485823460', TOKEN = 'x'.repeat(32);
const store = new Store(join(mkdtempSync(join(tmpdir(), 'qqline-')), 'q.sqlite'));
const state = new SqliteQqState(store);
const gateway = new ReverseOneBotGateway({ host: '127.0.0.1', port: 0, token: TOKEN, selfId: SELF, requestTimeoutMs: 5000 });
const config = QqConfigSchema.parse({ selfId: SELF, allowedGroups: [GROUP] });

// 假感知：图片识别用固定文案（真实 vision 已单独验证过，见 EXPERIMENTS）
let sent = 0;
const perception = {
  async inspect(media, question) { return media.mimeType.startsWith('image/') ? '一张书单截图：基础30讲现货，题源1000题27年1月发货' : '[这里走 QQ 转文字，不该走外部]'; },
  capabilities: () => ({ image: true, audio: false }),
};
const media = { async acquire() { return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }; } };

// 完整 agent：消息真的流进 scene 会话，才能验证「模型看到什么」
const repositories = sqliteRepositories(store);
const capabilities = new CapabilityRegistry(repositories.operations);
// 第一轮真的发一句话，验证「自己说过的话进不进记录」
let spoke = false;
const model = { async decide(request) {
  const context = request.context;
  if (context?.session !== undefined && !spoke) {
    spoke = true;
    return request.schema.parse({ type: 'tool', name: 'qq.send_message',
      input: { target: context.session.scope, text: '华师那个保研我也听说了，校企合作要看清条款' }, progress: '接一句' });
  }
  return request.schema.parse({ type: 'wait', summary: '观察' });
} };
const agent = composeAgent(repositories, model, capabilities, ConfigSchema.parse({ boundaries: { allowedTools: [] } }));
agent.runtime.start(Date.now());
const emitted = [];
const plugin = createQqPlugin({ config, gateway, state, media, perception });
await plugin.setup({ register: () => {} });
await plugin.start({ emit: event => { emitted.push(event); agent.runtime.ingest(event, Date.now()); } });

// 模拟 NapCat 连上来
await new Promise(resolve => setTimeout(resolve, 100));
const port = gateway.address().port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

// 平台侧应答：get_msg 返回被引用的原话；fetch_ptt_text 返回转写；其余照常
ws.on('message', raw => {
  const frame = JSON.parse(String(raw));
  const respond = data => ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
  if (frame.action === 'get_msg') return respond({ message: [{ type: 'text', data: { text: '华师那个保研是校企合作' } }], sender: { card: '牢e' } });
  if (frame.action === 'fetch_ptt_text') return respond({ text: '明天下午三点在图书馆集合' });
  if (frame.action === 'send_group_msg') { sent++; return respond({ message_id: 900 + sent }); }
  respond({});
});
const send = payload => ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(SELF),
  group_id: Number(GROUP), user_id: Number(USER), message_id: payload.id, time: 1794300000,
  sender: { nickname: '牢e' }, message: payload.message }));

// 三条最容易断的路：普通消息 / 引用别人的话 / 语音 / 图片
send({ id: 1, message: [{ type: 'text', data: { text: '你们觉得华师那个保研怎么样' } }] });
await new Promise(r => setTimeout(r, 300));
send({ id: 2, message: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '我也在犹豫' } }] });
await new Promise(r => setTimeout(r, 400));
send({ id: 3, message: [{ type: 'record', data: { file: 'x.amr' } }] });
await new Promise(r => setTimeout(r, 500));
send({ id: 4, message: [{ type: 'image', data: { url: 'https://x/1.jpg' } }, { type: 'text', data: { text: '这个书单你们看过吗' } }] });
await new Promise(r => setTimeout(r, 800));

console.log('\n=== 模型实际会看到的对话记录 ===');
// 让 runtime 把事件投进 scene 会话
for (let i = 0; i < 3; i++) await agent.runtime.tick(Date.now() + i * 1000);
const sceneRows = store.experiences(0, 50, `session:qq:${SELF}:group:${GROUP}`);
for (const message of transcriptWindow(sceneRows, 6000)) {
  console.log(`  [${message.role}] ${message.content}`);
}
console.log('\n=== 这一轮检测到的说话人 ===');
const sceneId = `qq:${SELF}:group:${GROUP}`;
const state2 = repositories.scenes.get(sceneId);
console.log('  session:', sceneId, '| steps:', state2?.steps, '| cursor:', state2?.cursor);
console.log('\n=== 原始事件里补到的内容 ===');
for (const event of emitted) {
  if (event.data?.quoted) console.log(`  引用: ${JSON.stringify(event.data.quoted.text)}`);
  if (event.data?.text?.includes('[语音')) console.log(`  语音: ${event.data.text.slice(0, 60)}`);
  if (event.data?.text?.includes('[图片')) console.log(`  图片: ${event.data.text.slice(0, 70)}`);
}
ws.close(); await plugin.stop?.(); agent.runtime.stop(); store.close();
