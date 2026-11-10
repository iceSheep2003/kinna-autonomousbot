import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalQqMemes } from '../src/infrastructure/qq/memes.js';

/** 造一个真实的表情包目录：catalog.json + 若干 png。 */
async function catalog(count: number, tags = ['笑']) {
  const root = mkdtempSync(join(tmpdir(), 'memes-'));
  const dir = join(root, 'pics');
  mkdirSync(dir, { recursive: true });
  const memes: { tag: string; file: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${i}.png`;
    writeFileSync(join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    memes.push({ tag: tags[i % tags.length]!, file: `pics/${name}` });
  }
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ memes }));
  return LocalQqMemes.load(root);
}

test('连续发同一个 tag 会避开最近发过的——纯随机在只有三五张时必然撞', async () => {
  const source = await catalog(5);
  const seen: string[] = [];
  let avoid: string[] = [];
  for (let i = 0; i < 5; i++) {
    const picked = await source.pick('笑', { avoid });
    assert.ok(!avoid.includes(picked.id), `第 ${i + 1} 次撞了: ${picked.id}`);
    seen.push(picked.id);
    avoid = [picked.id, ...avoid].slice(0, 6);
  }
  assert.equal(new Set(seen).size, 5, '五张能各不相同');
});

test('全部发过之后退回全量，不报错', async () => {
  const source = await catalog(2);
  const all = ['pics/0.png', 'pics/1.png'];
  const picked = await source.pick('笑', { avoid: all });
  assert.ok(all.includes(picked.id), '都被排除时仍要能发，只是不再保证新鲜');
});

test('返回的 id 是目录内相对路径，能用来记「最近发过」', async () => {
  const source = await catalog(3);
  const picked = await source.pick('笑');
  assert.match(picked.id, /^pics\/\d\.png$/);
  assert.match(picked.image, /^base64:\/\//);
});

test('未知标签报错，而不是随便给一张', async () => {
  const source = await catalog(2);
  await assert.rejects(() => source.pick('不存在的标签'), /Unknown meme tag/);
});
