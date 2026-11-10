import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/sqlite/database.js';
import { SqliteMemoryRepository } from '../src/infrastructure/sqlite/memory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 私聊与群聊之间的记忆可见性是**不对称**的。
 *
 * 同一个人：群里说的话，私聊时该记得（都是他自己说的）；
 * 但私聊里说的话，群里绝不能说——那是把私下的事搬到台面上。
 */

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'vis-')), 'm.sqlite'));
  const repository = new SqliteMemoryRepository(store);
  let n = 0;
  const put = (content: string, scope: string, subjectUserId: string) => repository.publish({
    id: `m${++n}`, content, subjectUserId, scope, factType: 'fact', kind: 'observation',
    confidence: 0.8, importance: 3, visibility: 'personal', evidence: [], status: 'active',
    createdAt: 1794300000000, updatedAt: 1794300000000, revision: 0, stale: false, accessCount: 0,
  } as never);
  put('在群里说过喜欢猫', 'group:456', 'u1');
  put('私聊里说过在考虑辞职', 'private:u1', 'u1');
  put('别的群说过要考研', 'group:999', 'u1');
  put('别人私聊里的秘密', 'private:u2', 'u2');
  return { store, repository };
}

test('私聊里能读到这个人在群里说过的话——都是他自己说的', () => {
  const { store, repository } = setup();
  const rows = repository.factsAbout('u1', 'private:u1', 20, { includeOtherScopes: true });
  const contents = rows.map(row => row.content);
  assert.ok(contents.some(text => text.includes('喜欢猫')), '群里说过的话私聊要记得');
  assert.ok(contents.some(text => text.includes('考研')), '别的群也是他自己说的');
  assert.ok(contents.some(text => text.includes('辞职')), '他自己的私聊当然记得');
  store.close();
});

test('私聊也读不到别人的私聊内容', () => {
  const { store, repository } = setup();
  const rows = repository.factsAbout('u1', 'private:u1', 20, { includeOtherScopes: true });
  assert.equal(rows.some(row => row.content.includes('别人私聊')), false, '别人的私聊绝不跨人可见');
  store.close();
});

test('群聊读不到这个人的私聊内容——私下的不能搬到台面上', () => {
  const { store, repository } = setup();
  const rows = repository.factsAbout('u1', 'group:456', 20);
  const contents = rows.map(row => row.content);
  assert.ok(contents.some(text => text.includes('喜欢猫')));
  assert.equal(contents.some(text => text.includes('辞职')), false, '群里不能说私聊里的事');
  assert.equal(contents.some(text => text.includes('考研')), false, '别的群的事也不该在这个群说');
  store.close();
});

test('默认（群聊）行为不变：只看 owner + 本场景', () => {
  const { store, repository } = setup();
  const rows = repository.factsAbout('u1', 'group:456', 20);
  assert.ok(rows.length > 0);
  assert.equal(rows.every(row => row.scope === 'owner' || row.scope === 'group:456'), true);
  store.close();
});
