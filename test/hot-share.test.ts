import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEYWORDS, hotShareFromEnv } from '../src/features/hot-share/config.js';
import { firstUnseen, canShare, nextKeyword, remember, rollDay, EMPTY_STATE } from '../src/features/hot-share/state.js';
import { looksLikeArticle, isNoise, normalizeUrl, pick, type SearchHit } from '../src/features/hot-share/search.js';
import { sharePrompt } from '../src/features/hot-share/prompt.js';
import { HotShareWorker } from '../src/features/hot-share/worker.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return { title: '一个有内容的标题', url: 'https://example.com/news/1', summary: '摘要内容', site: 'example', date: '2026-11-10', ...overrides };
}

/* ------------------------------ 配置 ------------------------------ */

test('默认配置不允许发出去：未启用 + dryRun 开 + 每天 1 条', () => {
  const config = hotShareFromEnv({});
  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.dailyLimit, 1);
  assert.deepEqual(config.keywords, DEFAULT_KEYWORDS);
});

test('坏配置退回默认，不会因为写错就放开上限', () => {
  const config = hotShareFromEnv({ BOT_HOT_SHARE_DAILY_LIMIT: 'abc', BOT_HOT_SHARE_INTERVAL_MINUTES: '-5' });
  assert.equal(config.dailyLimit, 1);
  assert.equal(config.intervalMs, 90 * 60_000);
  // 上限被夹到 10，避免把配置写成 999
  assert.equal(hotShareFromEnv({ BOT_HOT_SHARE_DAILY_LIMIT: '999' }).dailyLimit, 10);
});

test('关键词可以按逗号配置，空白被丢掉', () => {
  assert.deepEqual(hotShareFromEnv({ BOT_HOT_SHARE_KEYWORDS: '408 考研, , 计算机就业' }).keywords, ['408 考研', '计算机就业']);
});

/* ------------------------------ 状态 ------------------------------ */

test('关键词轮换会循环，且列表变短也不会越界', () => {
  let state = EMPTY_STATE;
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) { const r = nextKeyword(state, ['a', 'b']); seen.push(r.keyword); state = r.state; }
  assert.deepEqual(seen, ['a', 'b', 'a', 'b', 'a']);
  assert.equal(nextKeyword(state, []).keyword, '');
});

test('dryRun 不占每日额度；真发才占', () => {
  const state = { ...EMPTY_STATE, day: '2026-11-10', count: 1 };
  assert.equal(canShare(state, 1, true), true, 'dryRun 不受限制');
  assert.equal(canShare(state, 1, false), false, '真发已经用满');
});

test('去重记录有上限，不会无限增长', () => {
  let state = EMPTY_STATE;
  for (let i = 0; i < 250; i++) state = remember(state, `https://example.com/${i}`, { shared: false });
  assert.equal(state.seen.length, 200);
  assert.equal(state.seen.includes('https://example.com/0'), false, '最早的被丢掉');
});

test('跨日只重置计数，保留去重与轮换位置', () => {
  const state = { seen: ['u1'], day: '2026-11-09', count: 3, cursor: 2 };
  const next = rollDay(state, '2026-11-10');
  assert.equal(next.count, 0);
  assert.deepEqual(next.seen, ['u1']);
  assert.equal(next.cursor, 2);
  assert.equal(rollDay(next, '2026-11-10'), next, '同一天是幂等的');
});

test('挑一条没见过的，优先新日期和有摘要的', () => {
  const state = { ...EMPTY_STATE, seen: ['https://a'] };
  const chosen = firstUnseen([
    hit({ url: 'https://a', date: '2026-11-11' }),
    hit({ url: 'https://b', date: '2026-11-09', summary: '' }),
    hit({ url: 'https://c', date: '2026-11-10', summary: '有摘要' }),
  ], state);
  assert.equal(chosen?.url, 'https://c');
  assert.equal(firstUnseen([hit({ url: 'https://a' })], state), undefined);
});

/* ------------------------------ 搜索过滤 ------------------------------ */

test('过滤掉搜索引擎在描述自己', () => {
  assert.equal(isNoise(hit({ title: '必应搜索结果' })), true);
  assert.equal(isNoise(hit({ site: 'Bing' })), true);
  assert.equal(isNoise(hit({ title: '正常的一条新闻' })), false);
});

test('落地页不算文章：首页没有发生什么，模型对它也只能沉默', () => {
  assert.equal(looksLikeArticle({ url: 'https://example.com/', title: '某官网' }), false);
  assert.equal(looksLikeArticle({ url: 'https://example.com/news/1', title: '英雄联盟赛事官网' }), false);
  assert.equal(looksLikeArticle({ url: 'https://example.com/news/1', title: 'BLG 3:2 TES' }), true);
  assert.equal(looksLikeArticle({ url: '不是链接', title: '标题够长了吧' }), false);
});

test('pick：保留平台排序，只做「是文章」和「有摘要优先」', () => {
  const picked = pick([
    hit({ url: 'https://e.com/1', title: '短', summary: 'x' }),
    hit({ url: 'https://e.com/2', title: '没有摘要的文章标题', summary: '' }),
    hit({ url: 'https://e.com/3', title: '有摘要的文章标题', summary: '有内容' }),
  ]);
  assert.equal(picked[0]!.url, 'https://e.com/3', '有摘要的排前面');
  assert.equal(picked.length, 2, '标题过短的被丢掉');
});

/* ------------------------------ 提示词 ------------------------------ */

test('提示词明确允许「不说话」——没有这句，模型会把搜到当成该说', () => {
  const prompt = sharePrompt('408 考研', hit());
  assert.match(prompt, /如果没什么意思，就不要说话/);
  assert.match(prompt, /别写成新闻播报/);
});

/* ------------------------------ worker ------------------------------ */

function worker(options: { config?: Partial<ReturnType<typeof hotShareFromEnv>>; hits?: SearchHit[]; fail?: boolean } = {}) {
  let state = { ...EMPTY_STATE };
  const offers: unknown[] = [];
  const logs: string[] = [];
  const config = { ...hotShareFromEnv({ BOT_HOT_SHARE_ENABLED: 'true' }), ...(options.config ?? {}) };
  const w = new HotShareWorker({
    config,
    search: async () => { if (options.fail) throw new Error('搜索挂了'); return options.hits ?? [hit()]; },
    store: { read: () => state, save: next => { state = next; } },
    offer: offer => { offers.push(offer); },
    now: () => NOW,
    log: message => { logs.push(message); },
  });
  return { worker: w, offers, logs, state: () => state };
}

test('dryRun：不投递，只记日志；但照样去重，避免老在同一条上打转', async () => {
  const f = worker();
  const result = await f.worker.tick();
  assert.equal(result.ran, true);
  assert.equal(result.offered, false);
  assert.equal(f.offers.length, 0);
  assert.match(f.logs.join(' '), /dryRun/);
  assert.equal(f.state().seen.length, 1);
});

test('关掉 dryRun 才投给 self；投递是「候选」，不是「已经发了」', async () => {
  const f = worker({ config: { dryRun: false, dailyLimit: 5 } });
  assert.equal((await f.worker.tick()).offered, true);
  assert.equal(f.offers.length, 1);
  assert.equal(f.state().count, 1);
});

test('同一个链接不会被提第二次', async () => {
  const f = worker({ config: { dryRun: false, intervalMs: 0, dailyLimit: 5 } });
  await f.worker.tick();
  const second = await f.worker.tick();
  assert.equal(second.ran, false);
  assert.equal(second.reason, '没有新链接');
  assert.equal(f.offers.length, 1);
});

test('搜索失败不推进关键词，下次还用同一个词再试', async () => {
  const f = worker({ fail: true, config: { dryRun: false, dailyLimit: 5 } });
  const result = await f.worker.tick();
  assert.equal(result.ran, false);
  assert.equal(result.reason, '搜索失败');
  assert.equal(f.state().cursor, 0, '关键词不该因为失败而前进');
});

test('未启用时什么都不做', async () => {
  const f = worker({ config: { enabled: false } });
  assert.equal((await f.worker.tick()).ran, false);
});

test('没到间隔不重复跑', async () => {
  const f = worker({ config: { dryRun: false, intervalMs: 3_600_000, dailyLimit: 5 } });
  assert.equal((await f.worker.tick()).ran, true);
  const again = await f.worker.tick();
  assert.equal(again.ran, false);
  assert.equal(again.reason, '还没到间隔');
});

test('归一化 URL：剥掉追踪参数与 fragment，同一篇文章不该算两条', () => {
  const a = normalizeUrl('https://blog.csdn.net/x/article/details/1?utm_source=a&request_id=b&spm=1');
  const b = normalizeUrl('https://BLOG.csdn.net/x/article/details/1?utm_medium=c#section');
  assert.equal(a, b);
  assert.doesNotMatch(a, /utm_|request_id|spm/);
});

test('招聘/报名/职位页面不算可分享的文章（实测搜考研会把这些排前面）', () => {
  assert.equal(looksLikeArticle({ url: 'https://career.bnu.edu.cn/frontpage/html/recruitmentinfoForm.html?positionDetailId=x', title: '就业资讯' }), false);
  assert.equal(looksLikeArticle({ url: 'https://e.com/apply/1', title: '报名入口' }), false);
  assert.equal(looksLikeArticle({ url: 'https://e.com/jobs/1', title: '好岗位' }), false);
  assert.equal(looksLikeArticle({ url: 'https://e.com/news/1', title: '408 大纲有变化' }), true);
});

test('pick 去重：同一篇文章的不同渠道链接只留一条', () => {
  const picked = pick([
    hit({ url: 'https://e.com/a?utm_source=x', title: '同一篇新闻标题' }),
    hit({ url: 'https://e.com/a?utm_medium=y', title: '同一篇新闻标题' }),
  ]);
  assert.equal(picked.length, 1);
});

test('整站不适合分享的域名被排除：高校就业网、招聘平台', () => {
  assert.equal(looksLikeArticle({ url: 'https://career.csu.edu.cn/campus/view/id/591254', title: '宣讲会通知' }), false);
  assert.equal(looksLikeArticle({ url: 'https://www.zhaopin.com/job/1', title: '某岗位' }), false);
  assert.equal(looksLikeArticle({ url: 'https://wenku.baidu.com/view/1', title: '资料' }), false);
  // 正常新闻站不受影响
  assert.equal(looksLikeArticle({ url: 'https://news.qq.com/rain/a/1', title: '一条新闻的标题' }), true);
});
