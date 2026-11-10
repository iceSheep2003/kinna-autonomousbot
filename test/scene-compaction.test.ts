import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_EVERY, EMPTY_SCENE_STATE, SceneStateSchema, renderSceneState, shouldCompact, type SceneState } from '../src/execution/scene-compaction.js';
import { ModelSceneCompactor } from '../src/execution/scene-compactor.js';
import type { Experience } from '../src/memory/types.js';

function state(overrides: Partial<SceneState> = {}): SceneState {
  return { ...EMPTY_SCENE_STATE, sceneSummary: '大家在聊考研择校', ...overrides };
}
function row(text: string, nickname = '群友'): Experience {
  return { seq: 1, source: 's', kind: 'message', data: { nickname, text }, at: 0 } as Experience;
}

/* ------------------------------ 触发时机 ------------------------------ */

test('攒够一批才压；刚压过不重复压', () => {
  assert.equal(shouldCompact(COMPACT_EVERY - 1, 0), false);
  assert.equal(shouldCompact(COMPACT_EVERY, undefined), true);
  assert.equal(shouldCompact(COMPACT_EVERY * 2, COMPACT_EVERY), true);
  assert.equal(shouldCompact(COMPACT_EVERY + 1, COMPACT_EVERY), false, '刚压过就不再压');
});

/* ------------------------------ 渲染 ------------------------------ */

test('没有状态就不占上下文（不是给一段空标题）', () => {
  assert.equal(renderSceneState(undefined), '');
  assert.equal(renderSceneState({ ...EMPTY_SCENE_STATE, sceneSummary: '  ' }), '');
});

test('渲染出来的是「背景」而不是「原文」，避免模型把它当成刚发生的话', () => {
  const text = renderSceneState(state());
  assert.match(text, /不是这一轮的原文，是背景/);
  assert.match(text, /大家在聊考研择校/);
});

test('区分群友和我：我的承诺与群友的说法分开列', () => {
  const text = renderSceneState(state({
    participantStances: [{ participant: '牢e', topic: '实习', stance: '国企当保底' }],
    botContinuity: { recentStatements: ['我说过会看那个视频'], commitments: ['答应明天回他'], stances: [] },
  }));
  assert.match(text, /表过态：牢e 说 实习：国企当保底/);
  assert.match(text, /我答应过的：答应明天回他/);
  assert.match(text, /我说过的：我说过会看那个视频/);
});

test('空列表不渲染出空标题，上下文不掺噪', () => {
  const text = renderSceneState(state({ openLoops: [], callbacks: [] }));
  assert.doesNotMatch(text, /还没接住/);
  assert.doesNotMatch(text, /可以接的梗/);
});

/* ------------------------------ schema 约束 ------------------------------ */

test('每个列表都有上限：状态不会越压越大', () => {
  const tooMany = Array.from({ length: 10 }, (_, i) => ({ summary: `话题${i}`, participants: [] }));
  assert.throws(() => SceneStateSchema.parse({ ...EMPTY_SCENE_STATE, activeThreads: tooMany }));
  // 6 项以内可接受
  assert.doesNotThrow(() => SceneStateSchema.parse({ ...EMPTY_SCENE_STATE, activeThreads: tooMany.slice(0, 6) }));
});

test('ttlTurns 限制在 1-40：越依赖时效的梗取越小', () => {
  const callbacks = (ttlTurns: number) => ({ ...EMPTY_SCENE_STATE, callbacks: [{ summary: '那个梗', ttlTurns }] });
  assert.doesNotThrow(() => SceneStateSchema.parse(callbacks(1)));
  assert.doesNotThrow(() => SceneStateSchema.parse(callbacks(40)));
  assert.throws(() => SceneStateSchema.parse(callbacks(0)));
  assert.throws(() => SceneStateSchema.parse(callbacks(41)));
});

test('botContinuity 三个列表都必须存在：省掉就等于丢了一部分我自己', () => {
  assert.throws(() => SceneStateSchema.parse({ ...EMPTY_SCENE_STATE, botContinuity: { commitments: [] } }));
});

/* ------------------------------ 模型适配 ------------------------------ */

test('压成一行时跳过没有文本的系统流水，不把日志当对话', async () => {
  let sent = '';
  const compactor = new ModelSceneCompactor({
    decide: async (request: { context?: { transcript?: string } }) => {
      sent = request.context?.transcript ?? '';
      return state();
    },
  } as never);
  await compactor.compact({
    prior: undefined,
    rows: [row('今天聊什么'), { seq: 2, source: 's', kind: 'job', data: { jobId: 'x' }, at: 0 } as Experience],
  });
  assert.match(sent, /群友: 今天聊什么/);
  assert.doesNotMatch(sent, /jobId/);
});

test('没有更早状态时给一句占位，而不是空字符串（空字符串容易被误读成「没内容」）', async () => {
  let earlier = '';
  const compactor = new ModelSceneCompactor({
    decide: async (request: { context?: { earlier?: string } }) => {
      earlier = request.context?.earlier ?? '';
      return state();
    },
  } as never);
  await compactor.compact({ prior: undefined, rows: [row('hi')] });
  assert.match(earlier, /还没有更早的状态/);
});
