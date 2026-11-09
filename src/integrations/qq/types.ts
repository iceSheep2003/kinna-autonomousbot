import { z } from 'zod';
export const QqId = z.string().regex(/^\d{1,16}$/);
export const MessageId = z.string().regex(/^-?\d{1,18}$/);
export const TargetSchema = z.object({ type: z.enum(['group', 'private']), id: QqId });
export type Target = z.infer<typeof TargetSchema>;
export const QqConfigSchema = z.object({
  selfId: QqId, host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(6199),
  allowedGroups: z.array(QqId).default([]), privateEnabled: z.boolean().default(false), allowedPrivateUsers: z.array(QqId).default([]),
  ambientMessages: z.enum(['session', 'experience']).default('session'), operatorIds: z.array(QqId).default([]),
  maxMuteSeconds: z.number().int().min(0).max(86400).default(600), operatorEventTtlMs: z.number().int().min(1000).default(900000),
  textPartChars: z.number().int().min(20).max(3000).default(500), maxTextParts: z.number().int().min(1).max(10).default(6),
  sendIntervalMs: z.number().int().min(0).max(5000).default(500), requestTimeoutMs: z.number().int().min(10).max(25000).default(20000),
  titleEnabled: z.boolean().default(true), titleVoteThreshold: z.number().int().min(2).max(20).default(3),
  titleExpiresMs: z.number().int().min(60000).max(86400000).default(600000),
  joinReviewEnabled: z.boolean().default(false), joinApproveKeywords: z.array(z.string().min(1)).default([]), joinRejectKeywords: z.array(z.string().min(1)).default([]),
  welcomeEnabled: z.boolean().default(true), mediaRoots: z.array(z.string()).max(4).default([]), pathMap: z.record(z.string(), z.string()).default({}),
  channel: z.object({ enabled: z.boolean().default(false), sandbox: z.boolean().default(false), operatorIds: z.array(QqId).default([]), allowedGuilds: z.array(QqId).default([]), allowedChannels: z.array(QqId).default([]) }).optional(),
});
export type QqConfig = z.infer<typeof QqConfigSchema>;
export interface Segment { type: string; data: Record<string, unknown> }
export interface QqPart { kind: string; text?: string; targetId?: string; resourceId?: string; faceId?: string }
export interface QqEvent {
  id: string; kind: string; selfId: string; groupId?: string; userId: string; messageId?: string; time: number; receivedAt: number;
  nickname?: string; text: string; atBot: boolean; atUsers: string[]; replyTo?: string; parts: QqPart[];
  targetId?: string; flag?: string; subType?: string; comment?: string;
  published?: boolean; processed?: boolean; outcome?: unknown;
}
export interface MediaRef { id: string; scope: Target; kind: 'image' | 'audio' | 'video'; file?: string; url?: string; eventId: string }
export interface SendReceipt { messageIds: string[]; target: Target; sentParts: number }
export interface TitleProposal {
  id: string; groupId: string; userId: string; title: string; reason: string; expiresAt: number;
  promptMessageId?: string; voters: string[]; status: 'proposed' | 'awaiting_consent' | 'executing' | 'completed' | 'rejected' | 'expired' | 'uncertain';
}
export interface PlatformOperation { id: string; kind: string; status: 'started' | 'completed' | 'uncertain'; result?: unknown }
