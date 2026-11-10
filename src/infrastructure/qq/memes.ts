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
  /**
   * 挑一张表情包，尽量避开最近发过的。
   *
   * 纯随机的问题：tag 下只有三五张时，连着发两次就有一半概率撞同一张。
   * 群里连续刷同一张图很出戏——实际表现就是「总爱发那几个重复的」。
   *
   * 做法：先排除 avoid，剩下的随机；全被排除（tag 太小）就退回全量随机，
   * 不因为「都发过」而报错。返回 id 让调用方能记住这次发了哪张。
   */
  async pick(tag: string, options: { avoid?: readonly string[] } = {}): Promise<{ image: string; id: string }> {
    const files = this.entries.get(tag);
    if (!files?.length) throw new Error('Unknown meme tag');
    const file = await realpath(this.choose(files, options.avoid ?? []));
    if (relative(this.root, file).startsWith('..') || isAbsolute(relative(this.root, file))) throw new Error('Meme path escaped catalog root');
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Meme exceeds byte budget');
    return { image: `base64://${bytes.toString('base64')}`, id: this.memeId(file) };
  }

  /** 避开最近发过的；全被排除就退回全量——不因为「都发过」而发不出去。 */
  private choose(files: readonly string[], avoid: readonly string[]): string {
    const seen = new Set(avoid);
    const fresh = files.filter(file => !seen.has(this.memeId(file)));
    const pool = fresh.length > 0 ? fresh : files;
    return pool[randomInt(pool.length)]!;
  }

  /** 表情包的稳定标识：目录内相对路径。用来记「最近发过哪几张」。 */
  private memeId(file: string): string {
    return relative(this.root, file);
  }
}
