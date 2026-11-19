// src/infrastructure/ai/conversation/ai-conversation-visualization.module.ts
// 任务05 图形短时通道的装配边界。
//
// 单独成模块的原因：`AiInfrastructureModule` 被公共 RAG 客户端等无关消费者直接装配，
// 若在其中引入 `RedisModule`，任何不关心对话图形的消费方都会被要求提供 Redis 配置。
// 图形通道只服务于对话 handler 与状态查询用例，因此由这两个用例模块显式引入。

import { Module } from '@nestjs/common';

import { RedisModule } from '@src/infrastructure/redis/redis.module';

import {
  AI_CONVERSATION_VISUALIZATION_STORE,
  RedisAiConversationVisualizationStore,
} from './ai-conversation-visualization.store';

@Module({
  imports: [RedisModule],
  providers: [
    RedisAiConversationVisualizationStore,
    {
      provide: AI_CONVERSATION_VISUALIZATION_STORE,
      useExisting: RedisAiConversationVisualizationStore,
    },
  ],
  exports: [AI_CONVERSATION_VISUALIZATION_STORE],
})
export class AiConversationVisualizationModule {}
