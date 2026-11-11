import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQqEvent } from '../src/integrations/qq/events.js';
import { QqConfigSchema } from '../src/integrations/qq/types.js';

/**
 * @ 必须出现在文本里。
 *
 * 之前只记进 atUsers，text 里没有任何痕迹——模型看到的是一条普通消息，
 * 不知道有人在叫它。线上就出现了「没人点我，所以不说话」，
 * 而真相是**它看不见自己被点了**。
 */

const config = QqConfigSchema.parse({ selfId: '3078163242', allowedGroups: ['123'] });
const parse = (message: unknown[]) => parseQqEvent({
  post_type: 'message', message_type: 'group', self_id: 3078163242, group_id: 123,
  user_id: 2, message_id: 1, time: 1, sender: { nickname: '牢e' }, message,
}, config, 1)!.event;

test('@ 自己的时候，文本里要明确是「你」', () => {
  const event = parse([{ type: 'at', data: { qq: '3078163242' } }, { type: 'text', data: { text: ' 在吗' } }]);
  assert.match(event.text, /@你/, '要写成 @你，模型才知道是在叫自己');
  assert.match(event.text, /在吗/);
  assert.equal(event.atBot, true);
});

test('@ 别人的时候保留原样，不带「你」', () => {
  const event = parse([{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' 你看' } }]);
  assert.match(event.text, /@999/, '别人的 id 无所谓，但不能写成 @你');
  assert.doesNotMatch(event.text, /@你/);
  assert.equal(event.atBot, false);
});

test('@全体成员 单独表示，不当成 @ 自己', () => {
  const event = parse([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 开会' } }]);
  assert.match(event.text, /@全体/);
  assert.equal(event.atBot, false, '全体不等于点我一个人');
});

test('只有 @ 没有文字也算一条消息，不能变空', () => {
  const event = parse([{ type: 'at', data: { qq: '3078163242' } }]);
  assert.match(event.text, /@你/);
  assert.ok(event.text.length > 0);
});
