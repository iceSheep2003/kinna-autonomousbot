import test from 'node:test';
import assert from 'node:assert/strict';
import { correspondPath, cookiesFrom, mergedSession, parseRefreshCsrf } from '../src/infrastructure/bilibili/login.js';
import { SessionHost } from '../src/app/bilibili-session.js';
import { credentialsOf, sessionFromEnv, type Session } from '../src/integrations/bilibili/session.js';

/** 登录与托管都是纯逻辑：不联网，用假存储与假刷新器。 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function fakeStore(initial?: Session) {
  let current = initial;
  return { read: () => current, save: (session: Session) => { current = session; }, clear: () => { current = undefined; } };
}
function baseSession(overrides: Partial<Session> = {}): Session {
  return { sessdata: 'sess', biliJct: 'jct', refreshToken: 'rt-old', obtainedAt: NOW - 2 * DAY, source: 'qr', ...overrides };
}

test('从 Set-Cookie 里只取需要的字段，忽略属性', () => {
  const jar = cookiesFrom([
    'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
    'bili_jct=def456; Path=/',
    'DedeUserID=789; Path=/',
  ]);
  assert.equal(jar.SESSDATA, 'abc%2C123');
  assert.equal(jar.bili_jct, 'def456');
  assert.equal(jar.DedeUserID, '789');
});

test('correspondPath 是 RSA-OAEP(SHA-256) 的 256 位 base16 密文', async () => {
  const path = await correspondPath(NOW);
  // 1024 位 RSA 密文 = 128 字节 = 256 个十六进制字符，全小写。
  assert.match(path, /^[0-9a-f]{256}$/);
  // OAEP 带随机填充：同样输入两次结果不同，说明没有退化成确定性的 PKCS#1 v1.5。
  assert.notEqual(await correspondPath(NOW), path);
});

test('correspond 页面里能取到 refresh_csrf；页面变了就返回空，不猜', () => {
  const html = '<html><body><div id="1-name">b0cc8411ded2f9db2cff2edb3123acac</div></body></html>';
  assert.equal(parseRefreshCsrf(html), 'b0cc8411ded2f9db2cff2edb3123acac');
  assert.equal(parseRefreshCsrf('<html>no token</html>'), undefined);
});

test('环境变量会话：缺一项就当未登录，不会带半套凭证去请求', () => {
  assert.equal(sessionFromEnv({ BILIBILI_SESSDATA: 'x' }), undefined);
  const session = sessionFromEnv({ BILIBILI_SESSDATA: 'x', BILIBILI_BILI_JCT: 'y' }, NOW);
  assert.equal(session?.source, 'env');
  assert.equal(session?.refreshToken, undefined);
});

test('会话托管：没有 refresh_token 时不尝试刷新，并说明原因', async () => {
  const host = new SessionHost({ store: fakeStore(baseSession({ refreshToken: undefined })), refresher: { refreshIfNeeded: async () => { throw new Error('不该被调用'); } }, now: () => NOW });
  const result = await host.ensureFresh();
  assert.equal(result.refreshed, false);
  assert.match(result.reason ?? '', /重新扫码/);
});

test('会话托管：到点检查时询问刷新器；不需要刷新就保留原会话', async () => {
  let calls = 0;
  const host = new SessionHost({ store: fakeStore(baseSession()), refresher: { refreshIfNeeded: async () => { calls += 1; return undefined; } }, now: () => NOW });
  const result = await host.ensureFresh();
  assert.equal(calls, 1);
  assert.equal(result.refreshed, false);
  assert.equal(host.session()?.sessdata, 'sess');
});

test('会话托管：刷新成功会替换并落库；同一检查周期内不重复问', async () => {
  const store = fakeStore(baseSession());
  const next = baseSession({ sessdata: 'sess-new', refreshToken: 'rt-new', verifiedAt: NOW });
  const host = new SessionHost({ store, refresher: { refreshIfNeeded: async () => next }, now: () => NOW });
  assert.equal((await host.ensureFresh()).refreshed, true);
  assert.equal(host.session()?.sessdata, 'sess-new');
  assert.equal(store.read()?.refreshToken, 'rt-new');
  assert.equal((await host.ensureFresh()).refreshed, false, '刚检查过，不再触发');
});

test('会话托管：刷新抛错时保留旧会话，不让账号突然下线', async () => {
  const host = new SessionHost({ store: fakeStore(baseSession()), refresher: { refreshIfNeeded: async () => { throw new Error('86095'); } }, now: () => NOW });
  const result = await host.ensureFresh();
  assert.equal(result.refreshed, false);
  assert.match(result.reason ?? '', /86095/);
  assert.equal(host.session()?.sessdata, 'sess');
});

test('会话托管：还在检查周期内就什么都不做', async () => {
  let calls = 0;
  const host = new SessionHost({ store: fakeStore(baseSession()), refresher: { refreshIfNeeded: async () => { calls += 1; return undefined; } }, now: () => NOW });
  await host.ensureFresh();
  assert.equal(calls, 1);
  // 时间几乎没动，第二次不会再问
  await host.ensureFresh();
  assert.equal(calls, 1);
});

test('登出清空会话；扫码会话可以直接接入并立即生效', () => {
  const host = new SessionHost({ store: fakeStore(), refresher: { refreshIfNeeded: async () => undefined }, now: () => NOW });
  assert.equal(host.session(), undefined);
  const session = baseSession({ source: 'qr' });
  host.adopt(session);
  assert.deepEqual(credentialsOf(host.session()), { sessdata: 'sess', biliJct: 'jct' });
  host.clear();
  assert.equal(host.session(), undefined);
  assert.equal(credentialsOf(undefined), undefined);
});

test('刷新后合并：新 cookie 优先，缺的字段沿用旧的，绝不拼出半套凭证', () => {
  const old = baseSession({ sessdata: 'old-sess', biliJct: 'old-jct', refreshToken: 'rt-old', source: 'env' });
  const full = mergedSession(old, { SESSDATA: 'new-sess', bili_jct: 'new-jct' }, 'rt-new');
  assert.equal(full.sessdata, 'new-sess');
  assert.equal(full.refreshToken, 'rt-new');
  assert.equal(full.source, 'env', '来源不因为刷新而改变');
  // 平台只回了 SESSDATA：bili_jct 必须沿用旧的，否则 csrf 会失效。
  const partial = mergedSession(old, { SESSDATA: 'new-sess' }, undefined);
  assert.equal(partial.biliJct, 'old-jct');
  assert.equal(partial.refreshToken, 'rt-old');
});
