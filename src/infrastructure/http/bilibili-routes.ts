import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminApi } from '../../app/admin.js';

/** B 站相关路由：登录、每日任务、公开动作的批准。全部需要 owner 令牌（外层已校验）。 */
export function registerBilibiliRoutes(app: FastifyInstance, api: AdminApi): void {
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
  app.get('/v1/bilibili/todo', async (_request, reply) => {
    const todo = api.bilibiliTodo?.();
    if (!todo) return reply.code(404).send({ error: 'Bilibili todo is not configured' });
    return todo.view();
  });
  app.post('/v1/bilibili/todo/remind', async (_request, reply) => {
    const todo = api.bilibiliTodo?.();
    if (!todo) return reply.code(404).send({ error: 'Bilibili todo is not configured' });
    return todo.remind();
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
}
