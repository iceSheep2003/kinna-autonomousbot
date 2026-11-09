import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { OneBotActionError, OneBotNotConnected, OneBotUncertain, type OneBotPort } from '../../integrations/qq/ports.js';
interface Options { host: string; port: number; token: string; selfId: string; requestTimeoutMs: number; maxFrameBytes?: number; backlog?: number; maxLanes?: number }
interface Pending { socket: WebSocket; resolve(value: unknown): void; reject(error: Error): void; clean(): void }
/** NapCat 的 reverse WebSocket server。每次调用只发送一次，echo 回执不进入事件队列。 */
export class ReverseOneBotGateway implements OneBotPort {
  private server?: Server;
  private wsServer?: WebSocketServer;
  private socket?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private readonly lanes = new Map<string, { queue: Record<string, unknown>[]; active: boolean }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private handler?: (event: Record<string, unknown>) => Promise<void>;
  readonly stats = { accepted: 0, dropped: 0, failed: 0, malformed: 0 };
  constructor(private readonly options: Options) { if (options.token.length < 24) throw new Error('OneBot token must have at least 24 characters'); }
  address(): AddressInfo { if (!this.server) throw new Error('Gateway not started'); return this.server.address() as AddressInfo; }
  async start(handler: (event: Record<string, unknown>) => Promise<void>): Promise<void> {
    if (this.server) throw new Error('Gateway already started');
    this.handler = handler;
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxFrameBytes ?? 1024 * 1024, perMessageDeflate: false });
    this.server = server; this.wsServer = wss;
    server.on('upgrade', (req, socket, head) => {
      const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${this.options.token}`);
      if (req.url !== '/ws' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
        (req.headers['x-self-id'] && req.headers['x-self-id'] !== this.options.selfId)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        const old = this.socket; this.socket = ws;
        if (old) old.close(1012, 'Connection replaced');
        ws.on('message', data => this.receive(ws, data));
        ws.on('error', () => {});
        ws.on('close', () => {
          if (this.socket === ws) this.socket = undefined;
          for (const [echo, item] of this.pending) if (item.socket === ws) { item.clean(); item.reject(new OneBotUncertain('OneBot disconnected before receipt')); this.pending.delete(echo); }
        });
        let alive = true;
        ws.on('pong', () => { alive = true; });
        const ping = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 20000);
        ping.unref(); ws.once('close', () => clearInterval(ping));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.options.port, this.options.host, () => { server.off('error', reject); resolve(); }); });
  }
  private receive(socket: WebSocket, raw: RawData): void {
    const data = this.parse(raw);
    if (!data) return;
    if (data.echo !== undefined) { this.settle(socket, data); return; }
    if (!this.accepts(socket, data)) return;
    this.enqueue(data);
  }
  private parse(raw: RawData): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { this.stats.malformed++; return undefined; }
  }
  /** 调用回执按 echo 配对；拒绝的 action 不能当成成功。 */
  private settle(socket: WebSocket, data: Record<string, unknown>): void {
    const key = String(data.echo); const pending = this.pending.get(key);
    if (!pending || pending.socket !== socket) return;
    this.pending.delete(key); pending.clean();
    if (data.status !== 'ok' || Number(data.retcode ?? 0) !== 0) { pending.reject(new OneBotActionError(`OneBot action rejected (retcode ${String(data.retcode)})`)); return; }
    pending.resolve(data.data ?? {});
  }
  private accepts(socket: WebSocket, data: Record<string, unknown>): boolean {
    return socket === this.socket && String(data.self_id ?? '') === this.options.selfId && data.post_type !== 'meta_event';
  }
  private enqueue(data: Record<string, unknown>): void {
    const key = data.group_id !== undefined ? `group:${String(data.group_id)}` : `private:${String(data.user_id ?? 'other')}`;
    const lane = this.laneFor(key);
    if (!lane) return;
    if (lane.queue.length >= (this.options.backlog ?? 64)) { this.stats.dropped++; return; }
    lane.queue.push(data); this.stats.accepted++;
    if (!lane.active) void this.drain(key, lane);
  }
  /** 每个会话一条 lane，保证同群消息按序处理；lane 数有上限。 */
  private laneFor(key: string): { queue: Record<string, unknown>[]; active: boolean } | undefined {
    const existing = this.lanes.get(key);
    if (existing) return existing;
    if (this.lanes.size >= (this.options.maxLanes ?? 32)) { this.stats.dropped++; return undefined; }
    const lane = { queue: [], active: false };
    this.lanes.set(key, lane);
    return lane;
  }
  private async drain(key: string, lane: { queue: Record<string, unknown>[]; active: boolean }) {
    lane.active = true;
    try { while (lane.queue.length) { try { await this.handler?.(lane.queue.shift()!); } catch { this.stats.failed++; } } }
    finally { this.lanes.delete(key); }
  }
  async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new OneBotNotConnected('NapCat is not connected');
    if (this.pending.size >= 128) throw new OneBotNotConnected('OneBot pending request limit');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (message: string) => { const item = this.pending.get(echo); if (!item) return; this.pending.delete(echo); item.clean(); reject(new OneBotUncertain(message)); };
      const timer = setTimeout(() => fail('OneBot receipt timed out; action may have taken effect'), this.options.requestTimeoutMs);
      const abort = () => fail('OneBot call aborted; action may have taken effect');
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(echo, { socket, resolve, reject, clean: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
      socket.send(JSON.stringify({ action, params, echo }), error => { if (error) fail('OneBot transport failed before receipt'); });
    });
  }
  async stop(): Promise<void> {
    const wss = this.wsServer; const server = this.server;
    for (const ws of wss?.clients ?? []) ws.terminate();
    for (const [key, item] of this.pending) { item.clean(); item.reject(new OneBotUncertain('Gateway stopped')); this.pending.delete(key); }
    this.handler = undefined;
    await new Promise<void>(resolve => { if (wss) wss.close(() => resolve()); else resolve(); });
    await new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve(); });
    this.server = undefined; this.wsServer = undefined; this.socket = undefined;
  }
}
