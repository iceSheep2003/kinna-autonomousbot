import test from 'node:test';
import assert from 'node:assert/strict';
import { inverseFrequency, similarity, weightedSimilarity } from '../src/memory/text.js';

test('IDF：到处都出现的字组权重低，独一份的权重高', () => {
  const weights = inverseFrequency(['他喜欢什么', '他在做什么', '他什么时候来', '牢e在写Rust']);
  // 「什么」在三条里出现 → 权重低
  // 「ru」「st」只在一条里 → 权重高
  assert.ok((weights.get('什么') ?? 0) < (weights.get('ru') ?? 0));
});

test('IDF 加权后，共享泛词的相似度会被压低', () => {
  const corpus = ['他喜欢什么', '他在做什么', '他什么时候来', '牢e在写Rust'];
  const weights = inverseFrequency(corpus);
  // 「他喜欢什么」vs「他在做什么」：只共享「什么」「么」这类泛词
  const plain = similarity('他喜欢什么', '他在做什么');
  const weighted = weightedSimilarity('他喜欢什么', '他在做什么', weights);
  assert.ok(weighted < plain, `加权应更低：${weighted} vs ${plain}`);
});

test('查询里带语料没有的词，不该把所有候选打成 0 分', () => {
  const weights = inverseFrequency(['牢e在写Rust']);
  // 「量子计算」整个语料里没有，但「写ru」这种共享部分仍应算出来
  const score = weightedSimilarity('Rust 量子计算', '牢e在写Rust', weights);
  assert.ok(score > 0, '罕见词不该让整句归零');
});

test('语料里一个词都没有时退回等权，不返回 0', () => {
  const empty = new Map<string, number>();
  assert.ok(weightedSimilarity('Rust', '牢e在写Rust', empty) > 0);
});
