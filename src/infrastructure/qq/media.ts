import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { realpath, stat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import ipaddr from 'ipaddr.js';
import type { MediaBytes, OneBotPort, QqMediaSource } from '../../integrations/qq/ports.js';
import type { MediaRef } from '../../integrations/qq/types.js';

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export function publicAddress(address: string): boolean { try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; } }
export function qqMediaHost(host: string): boolean { return host === 'qpic.cn' || host.endsWith('.qpic.cn') || ['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'gxh.vip.qq.com'].includes(host); }
export async function downloadPublicMedia(url: string, allowed: (host: string) => boolean, signal: AbortSignal): Promise<Uint8Array> {
  const parsed = new URL(url); const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !allowed(host) || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) throw new Error('Unapproved media URL');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Media address is not public');
  const chosen = addresses[0]!;
  return new Promise((resolve, reject) => {
    // DNS 地址在这里固定，TLS SNI/Host 仍是原域名，防止校验后再次解析。
    const req = request(parsed, { signal, headers: { 'Accept-Encoding': 'identity' }, lookup: (_host, options, callback) => {
      if (options.all) callback(null, [chosen]); else callback(null, chosen.address, chosen.family);
    } }, response => {
      if (response.statusCode !== 200 || !['identity', undefined].includes(response.headers['content-encoding'])) { response.resume(); reject(new Error('Media transport rejected')); return; }
      const size = Number(response.headers['content-length'] ?? 0);
      if (!Number.isFinite(size) || size > MAX_MEDIA_BYTES) { response.destroy(); reject(new Error('Media exceeds byte limit')); return; }
      let total = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > MAX_MEDIA_BYTES) response.destroy(new Error('Media exceeds byte limit')); else chunks.push(chunk); });
      response.on('error', () => reject(new Error('Media transport failed')));
      response.on('end', () => total ? resolve(Buffer.concat(chunks)) : reject(new Error('Empty media')));
    });
    req.on('error', () => reject(new Error('Media transport failed'))); req.end();
  });
}
export function mediaMime(bytes: Uint8Array, kind: string): string {
  const b = Buffer.from(bytes);
  if (kind === 'audio') {
    if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
    if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 255 && ((b[1] ?? 0) & 224) === 224)) return 'audio/mpeg';
    if (b.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
    if (b.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  } else if (kind === 'image') {
    if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return 'image/gif';
    if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  }
  throw new Error('Unsupported or mismatched QQ media type');
}
export class NapCatMediaSource implements QqMediaSource {
  constructor(private readonly gateway: OneBotPort, private readonly roots: string[], private readonly pathMap: Record<string, string>) {
    if (roots.some(root => !isAbsolute(root) || [resolve('/'), homedir()].includes(resolve(root)))) throw new Error('QQ media roots must be narrow absolute directories');
  }
  async acquire(ref: MediaRef, signal: AbortSignal): Promise<MediaBytes> {
    if (ref.kind === 'video') throw new Error('QQ video understanding requires a separate video provider');
    let bytes: Uint8Array | undefined;
    if (ref.url && ref.kind === 'image') { try { bytes = await downloadPublicMedia(ref.url, qqMediaHost, signal); } catch { signal.throwIfAborted(); } }
    if (!bytes) {
      if (!ref.file) throw new Error('QQ media has no usable locator');
      const result = await this.gateway.call(ref.kind === 'image' ? 'get_image' : 'get_record', { file: ref.file, ...(ref.kind === 'audio' ? { out_format: 'wav' } : {}) }, signal) as { url?: string; file?: string };
      bytes = result.url ? await downloadPublicMedia(result.url, qqMediaHost, signal) : await this.readLocal(result.file ?? '', signal);
    }
    return { bytes, mimeType: mediaMime(bytes, ref.kind) };
  }
  private async readLocal(file: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (!isAbsolute(file)) throw new Error('QQ media local path is not absolute');
    let mapped = file;
    for (const [source, target] of Object.entries(this.pathMap)) {
      if (file === source || file.startsWith(source.replace(/\/$/, '') + '/')) { mapped = resolve(target, file.slice(source.length).replace(/^\//, '')); break; }
    }
    const path = await realpath(mapped); const roots = await Promise.all(this.roots.map(root => realpath(root)));
    if (!roots.some(root => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); })) throw new Error('QQ media path is outside owner mounts');
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size <= 0 || info.size > MAX_MEDIA_BYTES) throw new Error('QQ media byte limit');
      const buffer = Buffer.alloc(MAX_MEDIA_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_MEDIA_BYTES) throw new Error('QQ media byte limit'); signal.throwIfAborted(); return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
}
