import test from 'node:test';
import assert from 'node:assert/strict';
import { formatScope, parseScope, readableScopes, scopeReadable, canPromote } from '../src/memory/scope.js';
import { scopeOf } from '../src/execution/scene.js';

/**
 * QQ 私聊是一个独立的场景层。
 *
 * 之前它被当成群（`group:<userId>`），而且 `private:xxx` 被 parseScope 静默降级成
 * owner——那是**全局可见层**。等于私聊里记的东西可能被当成所有人都能读的事实。
 */

test('私聊有自己的 scope 层，不降级成 owner', () => {
  const scope = parseScope('private:3485823460');
  assert.equal(scope.kind, 'private', 'private 必须被认出来；降级成 owner 就是隐私问题');
  assert.equal(scope.id, '3485823460');
  assert.equal(formatScope(scope), 'private:3485823460');
});

test('私聊和群用同一个 id 时不会串', () => {
  const priv = parseScope('private:123');
  const group = parseScope('group:123');
  assert.notEqual(formatScope(priv), formatScope(group), '同号的人和群是两回事');
});

test('scopeOf 区分私聊和群聊', () => {
  const priv = scopeOf({ environment: 'qq', scope: { type: 'private', id: '3485823460' }, id: 'qq:99:private:3485823460' });
  const group = scopeOf({ environment: 'qq', scope: { type: 'group', id: '3485823460' }, id: 'qq:99:group:3485823460' });
  assert.equal(priv, 'private:3485823460');
  assert.equal(group, 'group:3485823460');
  assert.notEqual(priv, group);
});

test('私聊能读到 owner 和自己的，读不到别人的私聊', () => {
  const mine = readableScopes(parseScope('private:111'));
  assert.ok(mine.has('owner'), '通用的东西要能读到');
  assert.ok(mine.has('private:111'));
  assert.equal(mine.has('private:222'), false, '别人的私聊绝不能读');
  assert.equal(scopeReadable('private:222', parseScope('private:111')), false);
});

test('私聊里的记忆可以提升到 owner（AI 判断跨场景也成立）', () => {
  assert.equal(canPromote(parseScope('private:111'), parseScope('owner')), true);
  assert.equal(canPromote(parseScope('private:111'), parseScope('private:111')), false, '同层不算提升');
});
