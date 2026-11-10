/**
 * 每个场景能用的工具，写在代码里，不用 skill 那种间接层。
 *
 * 为什么不用 skill：线上 kinna 的做法是「内核 12 个工具 + skill 动态加载指令」，
 * 那套是为了在不让模型碰任意代码的前提下扩展行为。但代价是多一层：
 * 工具得先被 skill 声明、再被加载、再被引用，排查时要追三层。
 * 这个版本按场景直接固化清单：群聊就给 qq.*，看视频就给 bilibili.*，
 * 少一个抽象、看清一次调用要走哪条路。以后要加能力，往清单里加一行就行。
 *
 * 清单里可以写还没安装的能力（比如没配 B 站时的 bilibili.*）。
 * 注册表按「已注册 ∩ 本场景清单」取交集，没装的自然不会出现，不会报错。
 */
export const SCENARIO_TOOLS = {
  /**
   * 自己待着的时候。这是唯一需要「跨平台」的场景：
   * 它要能想起来（memory）、能记（note/todo）、能去外面看（各平台读接口）、
   * 也要能真的开口（发消息、发评论）——因为主动做什么由它决定。
   */
  self: [
    'memory.search', 'memory.expand', 'memory.promote', 'experience.read', 'self.note',
    'self.todo_add', 'self.todo_list', 'self.todo_close',
    'self.contact_plan', 'self.contact_done', 'self.contact_drop', 'self.contact_list',
    'web.search', 'web.fetch',
    'bilibili.discover', 'bilibili.search', 'bilibili.video', 'bilibili.comments', 'bilibili.quotas',
    'bilibili.todo', 'bilibili.todo_claim', 'bilibili.todo_done', 'bilibili.todo_skip',
    'bilibili.draft_comment', 'bilibili.draft_dynamic', 'bilibili.delete_post',
    'qq.send_message', 'qq.get_message', 'qq.history', 'qq.group_members', 'qq.group_info',
    // 环境查询：不知道有哪些群/表情，主动开口就只能靠猜。
    'qq.environment',
  ],
  /** 办事：真正能用哪些由任务自己声明（execution.tools），这里只放行长期可用的只读入口。 */
  execution: ['memory.search', 'experience.read'],
} as const;

/** 场景工具清单；未知场景返回空数组（宁可少给，也不默认放开）。 */
export function scenarioTools(scenario: keyof typeof SCENARIO_TOOLS): readonly string[] {
  return SCENARIO_TOOLS[scenario] ?? [];
}

/**
 * 场景清单与部署白名单取交集：
 * 清单说「这个场景可以有什么」，allowedTools 说「这台机器允许什么」，两者都满足才行。
 */
export function allowFor(scenario: keyof typeof SCENARIO_TOOLS, allowedTools: readonly string[]): string[] {
  const allowed = new Set(allowedTools);
  return scenarioTools(scenario).filter(name => allowed.has(name)) as string[];
}
