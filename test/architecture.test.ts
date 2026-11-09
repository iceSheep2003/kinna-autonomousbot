import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src', import.meta.url));
const core = new Set(['subject', 'self', 'execution', 'memory', 'runtime', 'capabilities', 'shared']);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(directory, item.name)) : item.name.endsWith('.ts') ? [join(directory, item.name)] : []);
}
function imports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source); return result;
}

test('模块目录与主体/self/执行/记忆/运行时/能力/接入/基础设施/应用层一一对应', () => {
  for (const module of ['subject', 'self', 'execution', 'memory', 'runtime', 'capabilities', 'integrations', 'infrastructure', 'app']) assert.ok(existsSync(join(root, module)), module);
  for (const obsolete of ['cognition', 'domain', 'storage', 'providers', 'http', 'plugins']) assert.equal(existsSync(join(root, obsolete)), false, `旧职责聚合目录仍存在: ${obsolete}`);
});

test('核心模块不能依赖基础设施、应用层、平台插件或数据库，跨模块仅使用契约', () => {
  for (const file of files(root)) {
    const local = relative(root, file); const owner = local.split('/')[0]!;
    if (!core.has(owner)) continue;
    for (const specifier of imports(file)) {
      assert.ok(!['node:sqlite', 'fastify'].includes(specifier), `${local} imports ${specifier}`);
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(dirname(file), specifier));
      const targetOwner = target.split('/')[0]!;
      assert.ok(core.has(targetOwner), `${local} -> ${target}: core must not depend on adapters`);
      if (targetOwner !== owner && targetOwner !== 'shared') assert.match(target, /\/(ports|types)\.js$/, `${local} imports implementation ${target}`);
    }
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\.db\b|\.prepare\(['"`]|\bStore\b/, `${local} leaked database API`);
  }
});

test('subject 不依赖会话执行或运行时；memory 没有修改主体/执行的通道', () => {
  for (const owner of ['subject', 'memory']) for (const file of files(join(root, owner))) {
    for (const specifier of imports(file)) {
      if (!specifier.startsWith('.')) continue;
      const targetOwner = relative(root, resolve(dirname(file), specifier)).split('/')[0];
      assert.ok(targetOwner === owner || targetOwner === 'shared', `${relative(root, file)} -> ${specifier}`);
    }
  }
});

test('应用协调不依赖具体存储，插件不依赖领域写服务', () => {
  for (const file of files(join(root, 'app'))) for (const specifier of imports(file)) assert.doesNotMatch(specifier, /infrastructure|sqlite/, relative(root, file));
  for (const file of files(join(root, 'integrations'))) for (const specifier of imports(file)) {
    if (!specifier.startsWith('.')) continue;
    const target = relative(root, resolve(dirname(file), specifier));
    if (!target.startsWith('integrations/')) assert.match(target, /\/(ports|types)\.js$/, `${relative(root, file)} imports implementation ${target}`);
  }
});
