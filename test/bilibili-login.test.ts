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
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.reason ?? '', /重新扫码/);
});

test('会话托管：到点检查时询问刷新器；不需要刷新就保留原会话', async () => {
  let calls = 0;
  const host = new SessionHost({ store: fakeStore(baseSession()), refresher: { refreshIfNeeded: async () => { calls += 1; return undefined; } }, now: () => NOW });
  const result = await host.ensureFresh();
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'not-needed', '不需要刷新是正常结果，不能算失败');
  assert.equal(host.session()?.sessdata, 'sess');
});

test('会话托管：刷新成功会替换并落库；同一检查周期内不重复问', async () => {
  const store = fakeStore(baseSession());
  const next = baseSession({ sessdata: 'sess-new', refreshToken: 'rt-new', verifiedAt: NOW });
  const host = new SessionHost({ store, refresher: { refreshIfNeeded: async () => next }, now: () => NOW });
  assert.equal((await host.ensureFresh()).outcome, 'refreshed');
  assert.equal(host.session()?.sessdata, 'sess-new');
  assert.equal(store.read()?.refreshToken, 'rt-new');
  assert.equal((await host.ensureFresh()).outcome, 'not-due', '刚检查过，不再触发');
});

test('会话托管：刷新抛错时保留旧会话，不让账号突然下线', async () => {
  const host = new SessionHost({ store: fakeStore(baseSession()), refresher: { refreshIfNeeded: async () => { throw new Error('86095'); } }, now: () => NOW });
  const result = await host.ensureFresh();
  assert.equal(result.outcome, 'failed');
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

test('平台没发放 refresh_csrf 时报「续期不可用、会话仍可用」，而不是把它说成登录失效', async () => {
  const { BilibiliLogin, RefreshUnavailable } = await import('../src/infrastructure/bilibili/login.js');
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    // cookie/info 说「需要刷新」，但 correspond 不发令牌（平台按需发放时的真实表现）
    if (String(url).includes('cookie/info')) return new Response(JSON.stringify({ code: 0, data: { refresh: true, timestamp: Date.now() } }), { status: 200 });
    if (String(url).includes('/correspond/')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const login = new BilibiliLogin();
    const error = await login.refreshIfNeeded(baseSession(), AbortSignal.timeout(1000)).then(() => null, e => e);
    assert.ok(error instanceof RefreshUnavailable, `应抛 RefreshUnavailable，实际 ${error}`);
    assert.match(error.message, /会话仍可用/);
  } finally { globalThis.fetch = original; }
});

test('平台说不需要刷新时，refreshIfNeeded 直接返回 undefined（不发任何刷新请求）', async () => {
  const { BilibiliLogin } = await import('../src/infrastructure/bilibili/login.js');
  const original = globalThis.fetch; let refreshCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('cookie/info')) return new Response(JSON.stringify({ code: 0, data: { refresh: false } }), { status: 200 });
    if (String(url).includes('cookie/refresh')) refreshCalls += 1;
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await new BilibiliLogin().refreshIfNeeded(baseSession(), AbortSignal.timeout(1000));
    assert.equal(result, undefined);
    assert.equal(refreshCalls, 0, '不需要刷新时不该调用刷新接口');
  } finally { globalThis.fetch = original; }
});

test('加密前要做 B 站前端那一步 ij()：每个字符转十六进制再拼接', async () => {
  const { preprocess } = await import('../src/infrastructure/bilibili/login.js');
  // 取自 B 站首页打包产物：function ij(e){…e.charCodeAt(n).toString(16)…}
  assert.equal(preprocess('refresh_1234567890'), '726566726573685f31323334353637383930');
  assert.equal(preprocess('ab'), '6162');
  // 与前端行为一致：不做 base64/padding，也不区分大小写以外的格式。
  assert.equal(preprocess(''), '');
});
