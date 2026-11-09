import type { ChannelRequest, QqChannelPort } from '../../integrations/qq/ports.js';
const PATH_PATTERN = /^\/(users\/@me\/guilds|guilds\/\d+\/(api_permission|channels|members(?:\/\d+)?|roles\/\d+\/members|announces)|channels\/\d+(?:\/(online_nums|threads(?:\/\d+(?:\/comment)?)?|schedules(?:\/\d+)?))?)$/;
export class QqChannelClient implements QqChannelPort {
  private token = ''; private expiresAt = 0; private refreshing?: Promise<string>;
  constructor(private readonly config: { appId: string; appSecret: string; sandbox: boolean }, private readonly clock = Date.now) {}
  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.clock() < this.expiresAt - 60000) return this.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await fetch('https://bots.qq.com/app/getAppAccessToken', { method: 'POST', signal: signal ?? AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }) });
      if (!response.ok) throw new Error(`QQ token HTTP ${response.status}`);
      const data = await response.json() as { access_token?: string; expires_in?: string | number };
      if (!data.access_token) throw new Error('QQ token response is empty');
      this.token = data.access_token; this.expiresAt = this.clock() + Number(data.expires_in ?? 600) * 1000; return this.token;
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async request(request: ChannelRequest): Promise<unknown> {
    const { method, path, body, signal, query } = request;
    if (!PATH_PATTERN.test(path)) throw new Error('Unsupported QQ channel path');
    const token = await this.accessToken(signal);
    const response = await fetch(this.url(path, query), { method, signal: signal ?? AbortSignal.timeout(15000), headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`QQ channel HTTP ${response.status}`);
    const content = await response.text(); return content ? JSON.parse(content) as unknown : {};
  }
  private url(path: string, query?: Record<string, string>): URL {
    const url = new URL(`https://${this.config.sandbox ? 'sandbox.' : ''}api.sgroup.qq.com${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url;
  }
}
