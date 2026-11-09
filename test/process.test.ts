import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('真实服务进程接本地模型 HTTP stub，自动思考并优雅停止', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-process-'));
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body);
    assert.ok(request.messages[0].content.includes('self'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reflection: '启动后决定先休息，等待环境信息。' }) } }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = (upstream.address() as { port: number }).port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATABASE_PATH: join(dir, 'agent.sqlite'), AGENT_CONFIG: '', BRAVE_API_KEY: '',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_API_KEY: 'local-test-only', LLM_MODEL: 'stub', API_TOKEN: 'local-test-token-with-24-characters' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  try {
    let base = '';
    for (let i = 0; i < 100; i++) {
      base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
      if (base) break;
      if (child.exitCode !== null) throw new Error(output);
      await delay(50);
    }
    assert.ok(base, output);
    let revision = 0;
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${base}/v1/self`, { headers: { authorization: 'Bearer local-test-token-with-24-characters' } });
      assert.equal(response.status, 200);
      revision = ((await response.json()) as { revision: number }).revision;
      if (revision > 0) break;
      await delay(50);
    }
    assert.equal(revision, 1);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await exited)[0], 0, output);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true });
  }
});
