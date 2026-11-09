#!/usr/bin/env node
/** 用 node:test 跑 tsx 测试并落 JUnit XML；失败时保持非零退出，交给 cqg 判定。 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const files = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join('test', name));
const report = join(root, '.quality', 'tests.junit.xml');
mkdirSync(join(root, '.quality'), { recursive: true });
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=junit', ...files], {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
writeFileSync(report, result.stdout ?? '');
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
