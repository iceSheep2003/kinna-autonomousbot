import { z } from 'zod';
import type { LanguageModel, ModelImage } from '../shared/model.js';
import { stamp } from '../integrations/bilibili/heat.js';

export interface VideoMaterial {
  bvid: string; title: string; owner: string; durationSeconds: number;
  shots: Array<{ url: string; at: number; why: string }>;
  comments: Array<{ user: string; text: string }>;
}

const ReadingSchema = z.object({
  reading: z.string().min(1).max(1500),
  keyPoints: z.array(z.string().min(1).max(200)).max(8).default([]),
  tone: z.string().max(200).default(''),
  worthReplying: z.string().max(500).default(''),
});

/**
 * 看视频的指令。图是按热度选出来的几帧，所以先要求「对应时间点」再谈「整体讲了什么」：
 * 零散几帧最容易被读成一段连续剧情，而它们之间其实隔着好几分钟。
 */
const READING_INSTRUCTIONS = `你在看一个 B 站视频的几张截图，按时间顺序排列，每张图前面标了它对应的时间点。
这些时间点是观众弹幕最密的地方（高能进度条），所以只是「他们在意的段落」，不是全部画面。

先逐张说这帧画面里确实有什么：场景、人物、动作、屏幕上的文字。
再判断：这些时间点连起来像是一个什么主题；如果几帧之间接不上，就直说接不上，不要编一个连贯的故事。
看不到的不许补。keyPoints 写 2-5 条真正被画面支持的点，每条注明是哪一帧（用时间点）。
tone 说视频的口气；worthReplying 写「如果要回一句，回什么才有价值」，没什么可回就留空。
输出 JSON。`;

/**
 * 把「截图 + 一条评论样本」变成结构化的观看笔记。
 *
 * 图片直接作为多模态输入交给 DeepSeek（它自己能用 URL 下载图片），
 * 所以这里没有本地视觉模型、没有 base64 编码，也读不到任何 cookie——
 * 发给模型的就是公开的视频页截图地址。
 */
export async function watchVideo(input: {
  model: Pick<LanguageModel, 'decide'>;
  material: VideoMaterial;
}): Promise<z.infer<typeof ReadingSchema>> {
  const images: ModelImage[] = input.material.shots.map(shot => ({
    url: shot.url, detail: 'high', label: `第 ${stamp(shot.at)} 帧 · ${shot.why}`,
  }));
  return input.model.decide({
    role: 'execution', schema: ReadingSchema, instructions: READING_INSTRUCTIONS, images,
    context: {
      bvid: input.material.bvid, title: input.material.title, owner: input.material.owner,
      durationSeconds: input.material.durationSeconds,
      frames: input.material.shots.map(shot => ({ at: stamp(shot.at), why: shot.why, url: shot.url })),
      sampleComments: input.material.comments.slice(0, 5),
    },
  });
}
