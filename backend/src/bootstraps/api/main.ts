// src/bootstraps/api/main.ts
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { useContainer } from 'class-validator';
import type { Express } from 'express';
import * as bodyParser from 'body-parser';
import { Logger } from 'nestjs-pino';
import { initGraphQLSchema } from '@src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '@src/bootstraps/api/api.module';

/**
 * 应用程序启动函数
 * 使用 NestJS ConfigService 获取配置信息
 */
async function bootstrap() {
  initGraphQLSchema();
  // 关闭 Nest 默认 body parser（express.json() 默认 100kb，会拒绝维修报告等
  // 合法长文/多步骤表单：12 步 × 10000 汉字约 310KB，实测 413），改用下方
  // 显式注册的、带配置上限的 parser；路由在 listen 阶段 init 时注册，
  // 此处先注册 parser 顺序安全（与 Nest 官方 rawBody 文档模式一致）。
  const app = await NestFactory.create(ApiModule, { bodyParser: false });
  app.enableShutdownHooks();

  // 隐匿技术栈：移除 Express 默认的 X-Powered-By 响应头
  const expressApp = app.getHttpAdapter().getInstance() as unknown as Express;
  expressApp.disable('x-powered-by');

  // 启用 class-validator 的依赖注入支持
  useContainer(app.select(ApiModule), { fallbackOnErrors: true });

  // 获取 ConfigService 实例
  const configService = app.get<ConfigService>(ConfigService);

  // 有界 JSON/表单请求体上限（server.bodyLimit，默认 2mb）：
  // 覆盖任务 06 合法上限（长文/多步骤导出与提交），超限仍由 body-parser
  // 明确返回 413（已按项目依赖离线实测：2.1MB → 413，310KB → 200）。
  // 上传（multipart）由 multer 独立限额，不经过本限制。
  const bodyLimit = configService.get<string>('server.bodyLimit', '2mb');
  expressApp.use(bodyParser.json({ limit: bodyLimit }));
  expressApp.use(bodyParser.urlencoded({ extended: true, limit: bodyLimit }));

  // 全局启用 CORS（按配置限制来源与凭据）
  const corsEnabled = configService.get<boolean>('server.cors.enabled', true);
  if (corsEnabled) {
    const originsStr = configService.get<string>('server.cors.origins', '');
    const origins = originsStr
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    app.enableCors({
      origin: origins.length > 0 ? origins : true,
      credentials: configService.get<boolean>('server.cors.credentials', true),
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['Content-Length', 'ETag'],
      maxAge: 600,
    });
  }

  // 获取 PinoLogger 实例
  const logger = app.get(Logger);

  // 从配置服务中获取服务器配置
  const host = configService.get<string>('server.host', '127.0.0.1');
  const port = configService.get<number>('server.port', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  await app.listen(port, host);

  // 使用 PinoLogger 记录服务器启动信息
  logger.log(`🚀 NestJS 服务在 http://${host}:${port} 上以 ${nodeEnv} 模式启动成功`);
}

void bootstrap();
