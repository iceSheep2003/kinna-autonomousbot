import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIO_TOOLS, allowFor, scenarioTools } from '../src/capabilities/scenarios.js';

test('每个场景的工具清单是显式的，不靠「全集减一点」', () => {
  assert.ok(SCENARIO_TOOLS.self.length > 0);
  assert.ok(SCENARIO_TOOLS.execution.length > 0);
  // 清单里不写通配符：固化意味着能一眼看全
  for (const name of SCENARIO_TOOLS.self) assert.doesNotMatch(name, /\*/, `${name} 不该是通配符`);
});

test('self 场景同时有「去外面看」和「真的开口」——主动做什么由它决定', () => {
  const self = SCENARIO_TOOLS.self as readonly string[];
  assert.ok(self.includes('self.note'));
  assert.ok(self.includes('bilibili.discover'));
  assert.ok(self.includes('web.fetch'));
  assert.ok(self.includes('qq.send_message'), '要能开口，否则「主动」只是空话');
});

test('办事场景默认只放行只读入口，具体工具由任务自己声明', () => {
  const execution = SCENARIO_TOOLS.execution as readonly string[];
  assert.ok(execution.includes('memory.search'));
  assert.ok(!execution.includes('qq.send_message'), '办事场景不该默认拿到群发权限');
});

test('清单与部署白名单取交集：没装的能力自动消失，不报错', () => {
  // 举例：这台机器没配 B 站，白名单里就没有 bilibili.*
  const allowed = ['self.note', 'memory.search', 'qq.send_message'];
  const names = allowFor('self', allowed);
  assert.deepEqual(names.sort(), ['memory.search', 'qq.send_message', 'self.note']);
  // 清单里有 bilibili.*，但因为白名单没有，结果里不会出现
  assert.ok(!names.some(name => name.startsWith('bilibili.')));
});

test('白名单里有、但清单里没有的工具不会被放进来', () => {
  const names = allowFor('self', ['self.note', 'dangerous.admin']);
  assert.deepEqual(names, ['self.note']);
});

test('未知场景默认不给任何工具（宁可少给）', () => {
  assert.deepEqual(scenarioTools('nope' as never), []);
  assert.deepEqual(allowFor('nope' as never, ['self.note']), []);
});
