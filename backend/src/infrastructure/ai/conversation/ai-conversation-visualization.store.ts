// src/infrastructure/ai/conversation/ai-conversation-visualization.store.ts
// 任务05 短时图形通道（S2.2）：仅在 Redis 保存本轮图形，带 TTL，不进业务库。
//
// 约束（R034-03／A05-04）：
// - 图形不得写入 MySQL，也不得进入浏览器持久存储；
// - 过期或缺失只影响图形，正文照常可读；
// - 任何 Redis 故障都只降级（返回 null／保存失败），不使本轮判失败。

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import type { AiConversationVisualization } from '@src/core/ai/ai-conversation-reply.policy';
import { REDIS_CLIENT } from '@src/infrastructure/redis/redis.module';

export const AI_CONVERSATION_VISUALIZATION_STORE = Symbol('AI_CONVERSATION_VISUALIZATION_STORE');

export const AI_CONVERSATION_VISUALIZATION_DEFAULT_TTL_SECONDS = 1800;

export interface AiConversationVisualizationStoreKey {
  readonly conversationId: number;
  readonly questionUuid: string;
  readonly contentVersion: number;
}

export interface AiConversationVisualizationStore {
  save(
    key: AiConversationVisualizationStoreKey,
    visualization: AiConversationVisualization,
  ): Promise<boolean>;
  load(key: AiConversationVisualizationStoreKey): Promise<AiConversationVisualization | null>;
}

@Injectable()
export class RedisAiConversationVisualizationStore implements AiConversationVisualizationStore {
  private readonly logger = new Logger(RedisAiConversationVisualizationStore.name);
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.ttlSeconds = configService.get<number>(
      'aiConversation.visualizationTtlSeconds',
      AI_CONVERSATION_VISUALIZATION_DEFAULT_TTL_SECONDS,
    );
  }

  async save(
    key: AiConversationVisualizationStoreKey,
    visualization: AiConversationVisualization,
  ): Promise<boolean> {
    try {
      await this.redis.set(
        this.buildKey(key),
        JSON.stringify(visualization),
        'EX',
        this.ttlSeconds,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { ...key, error: sanitize(error) },
        'AI 对话图形临时保存失败（已降级，不影响正文）',
      );
      return false;
    }
  }

  async load(
    key: AiConversationVisualizationStoreKey,
  ): Promise<AiConversationVisualization | null> {
    try {
      const raw = await this.redis.get(this.buildKey(key));
      if (!raw) {
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      return isVisualization(parsed) ? parsed : null;
    } catch (error) {
      this.logger.warn(
        { ...key, error: sanitize(error) },
        'AI 对话图形读取失败（已降级，正文照常返回）',
      );
      return null;
    }
  }

  /** key 含内容版本：同一轮的旧版本图形不会串到新版本 */
  private buildKey(key: AiConversationVisualizationStoreKey): string {
    return `ai:conv:visual:${key.conversationId}:${key.questionUuid}:${key.contentVersion}`;
  }
}

function isVisualization(value: unknown): value is AiConversationVisualization {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  // stage 允许 null（模型证据不足），与回复解析器的口径一致
  return (
    typeof candidate.sceneId === 'string' &&
    (candidate.stage === null || typeof candidate.stage === 'number') &&
    Array.isArray(candidate.parts)
  );
}

function sanitize(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 200);
  }
  return 'visualization_store_error';
}
