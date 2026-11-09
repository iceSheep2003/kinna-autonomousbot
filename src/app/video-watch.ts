import { z } from 'zod';
import type { LanguageModel } from '../shared/model.js';
import { groundedPoints } from '../integrations/bilibili/policy.js';

export interface VideoMaterial {
  title: string; owner: string; duration: number; frameReading: string;
  comments: Array<{ user: string; text: string }>;
}

const ReadingSchema = z.object({
  reading: z.string().min(1).max(1200),
  keyPoints: z.array(z.string().min(1).max(200)).max(8).default([]),
  tone: z.string().max(200).default(''),
  worthReplying: z.string().max(500).default(''),
});

const READING_INSTRUCTIONS = `你刚看完一个视频，现在要把它讲清楚，给同一个人看（不是给观众写简介）。
只写画面里确实有的东西：场景、人物、动作、屏幕上的文字。没看到的不许补。
keyPoints 写 2-5 条真正值得记住的点；有评论能印证就写，不能印证就只写画面。
tone 说这个视频是什么口气（认真讲、随手记录、吐槽……）。
worthReplying 写「如果要回一句，回什么才有价值」；没什么可回的就留空。输出 JSON。`;

/**
 * 把「抽帧读到的画面 + 几条评论」变成结构化的观看笔记。
 *
 * 用 LanguageModel 端口而不是另开一套模型调用：这是「读完以后的判断」，
 * 跟 dream / self 用的是同一种结构化输出。画面细节要能被 frameReading 支撑，
 * 否则就是模型在脑补，直接丢掉——读视频最怕的就是看图说话。
 */
export async function translateVideo(input: { model: Pick<LanguageModel, 'decide'>; material: VideoMaterial }): Promise<z.infer<typeof ReadingSchema> & { dropped: string[] }> {
  const raw = await input.model.decide({
    role: 'execution', schema: ReadingSchema, instructions: READING_INSTRUCTIONS,
    context: {
      title: input.material.title, owner: input.material.owner, durationSeconds: input.material.duration,
      frameReading: input.material.frameReading, sampleComments: input.material.comments.slice(0, 5),
    },
  });
  const { kept, dropped } = groundedPoints(raw.keyPoints, input.material.frameReading);
  return { ...raw, keyPoints: kept, dropped };
}
