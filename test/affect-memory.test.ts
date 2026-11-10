import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemember } from '../src/subject/appraisal.js';

/**
 * 情绪事件要不要变成「关于某个人的记忆」。
 *
 * 不是每轮都写：普通的 ±1 起伏写完就忘，真正值得记住的是这几类——
 * 被怼、被夸、关系明显变化。否则记忆会被噪声淹掉。
 */
test('被怼/被夸这种显著事件值得记住', () => {
  assert.equal(shouldRemember({ deltas: { valence: -3, stress: 3, sociability: -4 }, reason: '被怼了一句' }), true);
  assert.equal(shouldRemember({ deltas: { valence: 2 }, reason: '被夸了一句' }), true);
});

test('普通起伏不写记忆——写多了就是噪声', () => {
  assert.equal(shouldRemember({ deltas: { interest: 2, sociability: 2 }, reason: '有人专门找我说话' }), false);
  assert.equal(shouldRemember({ deltas: {}, reason: '这轮没什么起伏' }), false);
});

test('单维小变化也不写；总幅度够大才写', () => {
  assert.equal(shouldRemember({ deltas: { valence: 1 }, reason: '稍微高兴一点' }), false);
  assert.equal(shouldRemember({ deltas: { valence: 2, stress: 2 }, reason: '有点被压到' }), true);
});

test('显著事件写进记忆时带 subjectUserId——这是「关于这个人」的锚点', async () => {
  const { createSceneAffect } = await import('../src/app/scene-affect.js');
  const written: Record<string, unknown>[] = [];
  const affect = createSceneAffect({
    mood: { observeMood: () => ({ accepted: true }), observeRapport: () => ({ accepted: true }),
      observeReaction: () => ({ accepted: true }), narration: () => '' } as never,
    memory: { observe: (proposal: unknown) => { written.push(proposal as Record<string, unknown>); return { kind: 'inserted' as const, id: 'm1' }; } },
  });
  affect.observeTurn({ scope: 'group:1', userId: '3485823460', text: '你是不是傻', reply: '……', atBot: true, question: false, now: 1794300000000 });
  assert.equal(written.length, 1, '被怼应该写一条记忆');
  assert.equal(written[0]!.subjectUserId, '3485823460', '要挂在人身上，不然下次认不出来');
  assert.match(String(written[0]!.content), /被怼/);
});

test('普通寒暄不写记忆——否则记住的全是噪声', async () => {
  const { createSceneAffect } = await import('../src/app/scene-affect.js');
  const written: unknown[] = [];
  const affect = createSceneAffect({
    mood: { observeMood: () => ({ accepted: true }), observeRapport: () => ({ accepted: true }),
      observeReaction: () => ({ accepted: true }), narration: () => '' } as never,
    memory: { observe: (proposal: unknown) => { written.push(proposal); return { kind: 'inserted' as const, id: 'm2' }; } },
  });
  affect.observeTurn({ scope: 'group:1', userId: 'u1', text: '在吗', reply: '在', atBot: true, question: false, now: 1794300000000 });
  assert.equal(written.length, 0);
});
