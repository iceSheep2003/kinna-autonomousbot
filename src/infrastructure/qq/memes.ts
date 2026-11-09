import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { randomInt } from 'node:crypto';
import type { QqMemeSource } from '../../integrations/qq/ports.js';
/** 兼容线上 catalog.json 的 memes 与 packs 两种目录声明。 */
export class LocalQqMemes implements QqMemeSource {
  private constructor(private readonly root: string, private readonly entries: Map<string, string[]>) {}
  static async load(directory: string): Promise<LocalQqMemes> {
    const root = await realpath(directory); const data = JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8')) as {
      memes?: { tag: string; file: string }[]; packs?: { root: string; category_tags: Record<string, string> }[];
    };
    const entries = new Map<string, string[]>();
    const check = async (path: string) => { const value = await realpath(path); const rel = relative(root, value); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Meme path escaped catalog root'); return value; };
    const add = async (tag: string, file: string) => { const path = await check(file); if (!['.png','.jpg','.jpeg','.gif','.webp'].includes(extname(path).toLowerCase()) || !(await stat(path)).isFile()) return;
      const list = entries.get(tag) ?? []; list.push(path); entries.set(tag, list); };
    for (const item of data.memes ?? []) await add(item.tag, resolve(root, item.file));
    for (const pack of data.packs ?? []) {
      const packRoot = await check(resolve(root, pack.root));
      for (const [category, tag] of Object.entries(pack.category_tags)) {
        const directory = await check(resolve(packRoot, category));
        for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) await add(tag, resolve(directory, entry.name));
      }
    }
    return new LocalQqMemes(root, entries);
  }
  tags() { return [...this.entries.keys()].sort(); }
  async pick(tag: string): Promise<string> {
    const files = this.entries.get(tag); if (!files?.length) throw new Error('Unknown meme tag');
    const file = await realpath(files[randomInt(files.length)]!); const rel = relative(this.root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Meme path escaped catalog root');
    const info = await stat(file); if (info.size > 4 * 1024 * 1024) throw new Error('Meme exceeds byte budget');
    const bytes = await readFile(file); if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Meme exceeds byte budget');
    return `base64://${bytes.toString('base64')}`;
  }
}
