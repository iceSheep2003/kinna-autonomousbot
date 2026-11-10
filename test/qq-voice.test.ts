import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPtt, transcribePtt } from '../src/integrations/qq/voice.js';

function gateway(result: unknown | Error) {
  return { async call(action: string, params: Record<string, unknown>) {
    assert.equal(action, 'fetch_ptt_text', '用 QQ 自己的转文字接口');
    assert.equal(params.message_id, '123');
    if (result instanceof Error) throw result;
    return result;
  }, async start() {}, async stop() {} } as never;
}

test('用 QQ 的 fetch_ptt_text 转写，参数是消息 id 不是文件', async () => {
  const result = await transcribePtt(gateway({ text: '今天下午三点在图书馆集合' }), '123');
  assert.equal(result.text, '今天下午三点在图书馆集合');
  assert.equal(result.reason, undefined);
});

test('QQ 没转出文字时说清「QQ 没返回」，不当作成功', async () => {
  const result = await transcribePtt(gateway({ text: '' }), '123');
  assert.equal(result.text, '');
  assert.match(result.reason ?? '', /没有返回文字/);
});

test('平台报错原样带回来：消息已撤回/不包含语音这些信息有用', async () => {
  const result = await transcribePtt(gateway(new Error('消息不存在或已被撤回')), '123');
  assert.equal(result.text, '');
  assert.match(result.reason ?? '', /撤回/, `实际 reason: ${JSON.stringify(result.reason)}`);
});

test('转写结果拼进文本', () => {
  assert.equal(applyPtt('牢e: [语音]', { text: '今天下午三点集合' }), '牢e: [语音：今天下午三点集合]');
});

test('转不出来时把原因写进文本——「听到但听不清」和「没听到」是两回事', () => {
  const out = applyPtt('牢e: [语音]', { text: '', reason: '消息不存在或已被撤回' });
  assert.match(out, /转不出文字（消息不存在或已被撤回）/);
});

test('没有语音占位的文本不动', () => {
  assert.equal(applyPtt('纯文字', { text: 'x' }), '纯文字');
});

test('转写结果限长，不让一段长语音吃掉上下文', () => {
  const out = applyPtt('[语音]', { text: '字'.repeat(1000) });
  assert.ok(out.length < 650);
});
