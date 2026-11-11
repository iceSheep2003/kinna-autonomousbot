import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoom, DEFAULT_ROOM } from '../src/execution/read-room.js';

/**
 * 读空气：这一轮值不值得开口。
 *
 * 原线上服务的核心哲学是**沉默便宜、误回昂贵**——错过一句俏皮话没关系，
 * 硬插一句是代价大的那个。所以所有信号累加，够阈值才说。
 *
 * 这里补的是我们之前的洞：只有模型判断时，它看不到「该不该说话」的依据，
 * 只能选最安全的沉默。把空气读出来给它，它才有话可说。
 */

const base = { text: '在吗', atBot: false, atOthers: false, hasImage: false, isPrivate: false, now: 1_000_000, recent: [] as never[] };

test('私聊直接回，不是判断题', () => {
  assert.equal(readRoom({ ...base, isPrivate: true }).reply, true);
});

test('被 @ 直接回，不看分数', () => {
  const v = readRoom({ ...base, atBot: true });
  assert.equal(v.reply, true);
  assert.match(v.reason, /点你|@/);
});

test('@ 的是别人就别插嘴', () => {
  const v = readRoom({ ...base, text: '你看这个', atOthers: true });
  assert.equal(v.reply, false);
  assert.ok(v.score < 0);
});

test('寒暄和语气词不接——群友之间天天这样，每条都接就成壁纸了', () => {
  for (const text of ['哈', '哈哈', '嗯', '好的', '收到', '笑死']) {
    assert.equal(readRoom({ ...base, text }).reply, false, `「${text}」不该接`);
  }
});

test('只有图片没有文字不接', () => {
  assert.equal(readRoom({ ...base, text: '', hasImage: true }).reply, false);
});

test('有人在认真提问，能累积到阈值', () => {
  const v = readRoom({ ...base, text: '华师那个保研怎么样，有人了解吗？' });
  assert.ok(v.score > 0, `提问应该加分，实际 ${v.score}`);
});

test('接着自己上一句往下问，权重更高', () => {
  const recent = [{ role: 'assistant', content: '校企合作要看清条款', at: 999_000 }] as never[];
  const v = readRoom({ ...base, text: '那具体看哪些条款？', recent });
  assert.equal(v.reply, true, `接着自己的话该接，实际 score=${v.score}`);
});

test('刚说过话，别人没理会，就别再追', () => {
  const recent = [{ role: 'assistant', content: '我觉得还行', at: 995_000 }] as never[];
  const v = readRoom({ ...base, text: '哦', recent });
  assert.equal(v.reply, false);
});

test('判断必须可解释：每条都带理由和信号', () => {
  const v = readRoom({ ...base, text: '这个怎么弄？' });
  assert.ok(v.reason.length > 0);
  assert.ok(Array.isArray(v.signals));
});

test('阈值可配，但默认是 0.5', () => {
  assert.equal(DEFAULT_ROOM.threshold, 0.5);
});

test('热聊里说实质内容值得插一句——「人多所以有话说」和「人多别插嘴」不能互相抵消', () => {
  const now = 1_000_000;
  const recent = [
    { role: 'user', content: '华师那个怎么样', at: now - 30_000, userId: 'a' },
    { role: 'user', content: '我看还行', at: now - 20_000, userId: 'b' },
    { role: 'user', content: '学费多少', at: now - 10_000, userId: 'c' },
    { role: 'user', content: '不清楚', at: now - 8_000, userId: 'd' },
  ] as never[];
  const v = readRoom({ ...base, text: '我觉得保研这事得看导师方向对不对', now, recent });
  assert.equal(v.reply, true, `热聊机会该成立，实际 score=${v.score} signals=${v.signals.join(',')}`);
});
