import Fastify from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { adminCollections, type AdminApi } from '../../app/admin.js';
import { EventSchema } from '../../runtime/types.js';

export function createServer(api: AdminApi, token: string) {
  const app = Fastify({ logger: true, bodyLimit: 32768 });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? 'Request failed; inspect server logs' : error instanceof Error ? error.message : String(error) });
    if (status === 500) app.log.error(error);
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1/self', async () => api.self());
  const collections = adminCollections;
  for (const collection of collections) app.get(`/v1/${collection}`, async request => {
    const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return api.list(collection, limit, offset);
  });
  app.get('/v1/experiences', async request => {
    const args = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30), source: z.string().optional() }).parse(request.query);
    return api.experiences(args.after, args.limit, args.source);
  });
  app.get('/v1/sessions/:id/turns', async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return api.turns(id, 20);
  });
  app.get('/v1/jobs', async () => api.jobs());
  app.get('/v1/capabilities', async () => api.capabilities());
  app.post('/v1/events', async (request, reply) => { const result = api.ingest(EventSchema.parse(request.body)); return reply.code(202).send(result); });
  // 登录：扫码走三步（生成 → 轮询 → 入库），凭证不会出现在任何响应里。
  app.get('/v1/bilibili/auth', async (_request, reply) => {
    const auth = api.bilibiliAuth?.();
    if (!auth) return reply.code(404).send({ error: 'Bilibili is not configured' });
    return auth.status();
  });
  app.post('/v1/bilibili/auth/qr', async (_request, reply) => {
    const auth = api.bilibiliAuth?.();
    if (!auth) return reply.code(404).send({ error: 'Bilibili is not configured' });
    return auth.startQr();
  });
  app.get('/v1/bilibili/auth/qr/:key', async (request, reply) => {
    const auth = api.bilibiliAuth?.();
    if (!auth) return reply.code(404).send({ error: 'Bilibili is not configured' });
    const { key } = z.object({ key: z.string().min(8).max(64) }).parse(request.params);
    return auth.pollQr(key);
  });
  app.post('/v1/bilibili/auth/refresh', async (_request, reply) => {
    const auth = api.bilibiliAuth?.();
    if (!auth) return reply.code(404).send({ error: 'Bilibili is not configured' });
    return auth.refresh();
  });
  app.post('/v1/bilibili/auth/logout', async (_request, reply) => {
    const auth = api.bilibiliAuth?.();
    if (!auth) return reply.code(404).send({ error: 'Bilibili is not configured' });
    return auth.logout();
  });
  // 公开动作的批准：只有持 owner 令牌的人能调用，模型没有这条路径。
  app.get('/v1/bilibili/drafts', async (_request, reply) => {
    const approvals = api.approvals?.();
    if (!approvals) return reply.code(404).send({ error: 'Bilibili is not configured' });
    return { drafts: approvals.list() };
  });
  app.post('/v1/bilibili/drafts/:id/approve', async (request, reply) => {
    const approvals = api.approvals?.();
    if (!approvals) return reply.code(404).send({ error: 'Bilibili is not configured' });
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(request.params);
    const result = await approvals.approve(id);
    return reply.code(result.ok ? 200 : 409).send(result);
  });
  app.post('/v1/bilibili/drafts/:id/reject', async (request, reply) => {
    const approvals = api.approvals?.();
    if (!approvals) return reply.code(404).send({ error: 'Bilibili is not configured' });
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(request.params);
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});
    const result = approvals.reject(id, note);
    return reply.code(result.ok ? 200 : 409).send(result);
  });
  return app;
}
