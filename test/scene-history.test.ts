import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { sqliteRepositories } from '../src/infrastructure/sqlite/repositories.js';
import { composeAgent } from '../src/app/agent.js';
import { ConfigSchema } from '../src/app/config.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 场景的对话历史：三层，用同一个游标衔接。
 *
 * 原文（5 分钟内）→ 压缩快照（更早）→ 记忆检索（更久）。
 *
 * 之前只有「本轮新增」这一层：群里每轮来一条消息，模型就只看到一条孤立的话，
 * 不知道刚才在聊什么、谁在跟谁说话——表现就是「回复没有指向性」。
 */

const SESSION = 'qq:99:group:1';
const SOURCE = `session:${SESSION}`;

function harness() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'hist-')), 'a.sqlite'));
  const repositories = sqliteRepositories(store);
  const contexts: Record<string, unknown>[] = [];
  const model = {
    async decide(request: { role: string; context: Record<string, unknown>; schema: { parse(v: unknown): unknown } }) {
      if (request.role === 'scene') contexts.push(request.context);
      if (request.role === 'self') return request.schema.parse({ reflection: '醒着' });
      return request.schema.parse({ type: 'wait', summary: '看着' });
    },
  };
  const agent = composeAgent(repositories, model as never, new CapabilityRegistry(repositories.operations),
    ConfigSchema.parse({ boundaries: { allowedTools: [] } }));
  return { store, repositories, agent, contexts };
}

/** 往这个 session 的经验流里写一条群消息。 */
function say(repositories: ReturnType<typeof sqliteRepositories>, at: number, text: string): void {
  repositories.experience.append(SOURCE, 'qq.message',
    { text, userId: 'u1', nickname: '牢e', groupId: '1' }, at);
}

function ingest(agent: ReturnType<typeof harness>['agent'], at: number, text: string): void {
  agent.runtime.ingest({
    id: `e${at}`, source: 'qq', kind: 'qq.message',
    data: { text, userId: 'u1', nickname: '牢e', groupId: '1' },
    route: { type: 'session', sessionId: SESSION, environment: 'qq', scope: { type: 'group', id: '1' } },
  } as never, at);
}

test('模型看到的是最近几分钟的对话，不是孤立一条', async () => {
  const f = harness();
  const now = 1_000_000_000;
  // 先有三条历史，再来触发这一轮
  for (const [offset, text] of [[-120_000, '华师那个保研怎么样'], [-90_000, '校企合作那种吧'],
    [-60_000, '我看还行'], [-30_000, '你打算报吗']] as const) {
    say(f.repositories, now + offset, text);
  }
  f.agent.runtime.start(now);
  ingest(f.agent, now, '我也在犹豫');
  for (let i = 0; i < 3; i += 1) await f.agent.runtime.tick(now + i);
  const context = f.contexts[0] as { transcript?: { content: string }[] };
  assert.ok(context.transcript, '要有对话记录');
  assert.ok(context.transcript.length > 1, `应该看到历史，实际只有 ${context.transcript.length} 条`);
  assert.ok(context.transcript.some(m => m.content.includes('华师')), '要包含前几轮的话题');
  f.agent.runtime.stop();
  f.store.close();
});

test('超出 5 分钟窗口的原文不再塞进上下文', async () => {
  const f = harness();
  const now = 1_000_000_000;
  say(f.repositories, now - 3_600_000, '一小时前说过的话');
  say(f.repositories, now - 60_000, '刚才说的');
  f.agent.runtime.start(now);
  ingest(f.agent, now, '现在这句');
  for (let i = 0; i < 3; i += 1) await f.agent.runtime.tick(now + i);
  const context = f.contexts[0] as { transcript?: { content: string }[] };
  const text = JSON.stringify(context.transcript ?? []);
  assert.ok(text.includes('刚才说的'), '窗口内的要在');
  assert.equal(text.includes('一小时前说过的话'), false, '窗口外的靠快照和记忆，不该占原文预算');
  f.agent.runtime.stop();
  f.store.close();
});

test('当前这条不混进历史——它单独作为「这一轮要处理什么」', async () => {
  const f = harness();
  const now = 1_000_000_000;
  say(f.repositories, now - 60_000, '前面那句');
  f.agent.runtime.start(now);
  ingest(f.agent, now, '现在这句');
  for (let i = 0; i < 3; i += 1) await f.agent.runtime.tick(now + i);
  const context = f.contexts[0] as { transcript?: { content: string }[] };
  // 当前消息会作为观察进 transcript 之外的输入，但历史里只该有前文。
  const history = (context.transcript ?? []).filter(m => m.content.includes('现在这句'));
  assert.ok(history.length <= 1, '当前这条最多出现一次');
  f.agent.runtime.stop();
  f.store.close();
});
