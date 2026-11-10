/**
 * 关键词搜索。
 *
 * 用 DeepSeek 官方搜索（线上同款），它返回已排序的候选。这里只做两件搜索服务
 * 自己不会做、但「分享」这件事必须做的事：
 *
 * 1. 去掉搜索引擎在描述自己（「必应」「Bing」）；
 * 2. 去掉落地页（「官网」「首页」「下载」）—— 首页没有发生什么，模型对它也只能沉默。
 *
 * 排序交给平台的 rerank，不另写热度公式：真正决定「说不说」的是模型，不是分数。
 */
export interface SearchHit {
  title: string;
  url: string;
  summary: string;
  /** 站点名与日期，给模型判断新鲜度用。 */
  site: string;
  date: string;
}

const NOISE = ['必应', 'bing', '微软', '百度'];
const LANDING = ['官网', '官方网站', '首页', '官方站点', '下载', '登录'];
/**
 * 不是文章、没什么可说的页面：招聘列表、报名表单、职位详情。
 * 实测搜「408 考研」会把这些排到前面——它们对一个考研群确实是信息，
 * 但那是招生门户该干的事，不是「看到一条东西想跟群里说」。
 */
const NOT_ARTICLE_URL = /(?:recruitment|zhaopin|job|positionDetail|apply|signup|form|login|register)/i;
const NOT_ARTICLE_TITLE = ['招聘', '报名', '职位', '岗位', '招生简章', '报考指南'];
/**
 * 整站都不适合分享的域名：高校就业网、招聘平台、文库。
 * 实测搜「408 考研」时，这些站会因为「硕士」「计算机」被大量召回，
 * 但它们发的是通知和岗位，不是「看到了什么想说一句」。
 */
const NOT_SHAREABLE_HOST = /(?:^|\.)(?:career|job|zhaopin|zp|employ|xiaoyuanzhaopin)\.|(?:^|\.)career\.[^.]*\.edu\.cn$|(?:^|\.)(?:wenku|doc88|docin|zhaopin\.com|zhipin\.com|lagou\.com)\b/i;

/** 去重时要剥掉的追踪参数：同一条链接带不同 utm 会被当成两条。 */
const TRACKING_PARAMS = /^(utm_|request_id|biz_id|ops_request|spm|from|share_|fr_|ref$|fbclid$)/i;

/** 搜到的最多留几条；分享只需要一条能说的。 */
const MAX_RESULTS = 8;
/** 标题太短的多半是导航或广告位。 */
const MIN_TITLE = 6;

/**
 * 归一化 URL：剥掉追踪参数、去 fragment、小写 host。
 * 用于去重——同一条新闻被不同渠道转发时，链接长得不一样但说的是同一件事。
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return raw;
  }
}

/** 从一段 URL 里看它是不是文章（有 path、不是首页、不是表单/招聘页）。 */
export function looksLikeArticle(hit: Pick<SearchHit, 'url' | 'title'>): boolean {
  let path = '';
  let host = '';
  try {
    const parsed = new URL(hit.url);
    path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    host = parsed.hostname;
  } catch {
    return false;
  }
  if (path === '') return false;
  if (NOT_SHAREABLE_HOST.test(host)) return false;
  if (NOT_ARTICLE_URL.test(path)) return false;
  const title = hit.title;
  if (NOT_ARTICLE_TITLE.some(word => title.includes(word))) return false;
  return !LANDING.some(word => title.includes(word));
}

export function isNoise(hit: Pick<SearchHit, 'title' | 'summary' | 'site'>): boolean {
  const text = `${hit.title} ${hit.summary} ${hit.site}`.toLowerCase();
  return NOISE.some(word => text.includes(word));
}

/**
 * 挑候选：先要文章，再要有摘要的（有摘要模型才有东西可反应），最多 8 条。
 * 顺序保留平台给的 rerank，不做二次打分。
 */
export function pick(hits: readonly SearchHit[]): SearchHit[] {
  const cleaned = hits
    .filter(hit => hit.title.length >= MIN_TITLE && hit.url.startsWith('http'))
    .filter(hit => !isNoise(hit))
    .filter(hit => looksLikeArticle(hit))
    .map(hit => ({ ...hit, url: normalizeUrl(hit.url) }));
  // 归一化之后可能撞车（同一篇文章的两个渠道链接），只留第一条。
  const seen = new Set<string>();
  return cleaned
    .filter(hit => (seen.has(hit.url) ? false : (seen.add(hit.url), true)))
    .sort((a, b) => Number(b.summary.length > 0) - Number(a.summary.length > 0))
    .slice(0, MAX_RESULTS);
}

/** 搜索接口只返回候选，不替模型作答。 */
export type SearchFn = (query: string, signal: AbortSignal) => Promise<SearchHit[]>;

interface DeepSeekRow { title?: unknown; url?: unknown; summary?: unknown; site_name?: unknown; date?: unknown }

/** DeepSeek 搜索适配器：字段名归一化，异常一律抛错（让上层决定跳过还是停）。 */
export function deepSeekSearch(options: { apiKey: string; baseUrl?: string; timeoutMs?: number }): SearchFn {
  const base = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  return async (query, signal) => {
    const response = await fetch(`${base}/v1/tools/search`, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)]),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 10 }),
    });
    if (!response.ok) throw new Error(`搜索失败 HTTP ${response.status}`);
    const body = await response.json() as { results?: DeepSeekRow[] };
    return (body.results ?? []).map(row => ({
      title: String(row.title ?? '').slice(0, 200),
      url: String(row.url ?? '').slice(0, 1000),
      summary: String(row.summary ?? '').slice(0, 600),
      site: String(row.site_name ?? '').slice(0, 80),
      date: String(row.date ?? '').slice(0, 40),
    }));
  };
}
