// src/adapters/api/rest/rest-adapter.module.ts

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AccountUsecasesModule } from '@src/usecases/account/account-usecases.module';
import { AuthUsecasesModule } from '@src/usecases/auth/auth-usecases.module';
import { ContentSubmissionUsecasesModule } from '@src/usecases/content-submission/content-submission-usecases.module';
import { ReferenceDocumentUsecasesModule } from '@src/usecases/reference-document/reference-document-usecases.module';
import { StoredFileUsecasesModule } from '@src/usecases/stored-file/stored-file-usecases.module';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

import { ContentSubmissionRestController } from './content-submission/content-submission-rest.controller';
import { ReferenceDocumentRestController } from './reference-document/reference-document-rest.controller';
import { StoredFileRestController } from './stored-file/stored-file-rest.controller';
import { LocalBackupCloudPackageRestController } from './local-runtime/local-backup-cloud-package-rest.controller';
import { WebSessionRestController } from './web-session/web-session-rest.controller';
import { WEB_SESSION_OPTIONS, type WebSessionOptions } from './web-session/web-session.options';

/**
 * 浏览器会话选项的 DI wiring。
 *
 * 运行时配置读取只允许发生在 module 装配层（架构规则
 * `local-architecture/no-runtime-config-outside-wiring`）：控制器只消费构建好的
 * 选项对象，不直接读 env，保证「开关 → 行为」只有一条映射路径。
 */
export function createWebSessionOptions(configService: ConfigService): WebSessionOptions {
  const accessTokenTtl = configService.get<string | undefined>('webSession.accessTokenTtl');
  const issuer = configService.get<string | undefined>('jwt.issuer');

  return {
    enabled: configService.get<boolean>('webSession.enabled') ?? false,
    ...(accessTokenTtl ? { accessTokenTtl } : {}),
    cookieSecure: configService.get<boolean>('webSession.cookieSecure') ?? false,
    allowedOrigins: configService.get<string[]>('webSession.allowedOrigins') ?? [],
    ...(issuer ? { issuer } : {}),
  };
}

/**
 * REST 边界装配（文件上传/下载等多部分端点；GraphQL 继续负责查询与其他操作）。
 * 上传大小/白名单运行时配置已随业务规则迁移至 usecase 层单一真源
 * （reference-document-usecases.module.ts wiring，负责人 0910 架构要求）。
 *
 * 浏览器会话边界（网页登录 / 恢复 / 退出）也挂在这里：它需要与既有登录用例共用
 * 同一套凭据校验与限制规则（`AuthUsecasesModule`），且必须能直接操作响应头下发
 * HttpOnly Cookie —— GraphQL 上下文只注入 `req`，不适合承担该职责。
 */
@Module({
  imports: [
    ReferenceDocumentUsecasesModule,
    ContentSubmissionUsecasesModule,
    StoredFileUsecasesModule,
    // 云端备份包授权下载（任务 09 S4／A09-07）：包字节走 REST 字节流，避免大包进 GraphQL
    LocalRuntimeUsecasesModule,
    // 浏览器会话：登录/恢复复用认证用例，用户摘要复用账号用例（与 GraphQL 登录同源）
    AuthUsecasesModule,
    AccountUsecasesModule,
  ],
  controllers: [
    ReferenceDocumentRestController,
    ContentSubmissionRestController,
    StoredFileRestController,
    LocalBackupCloudPackageRestController,
    WebSessionRestController,
  ],
  providers: [
    {
      provide: WEB_SESSION_OPTIONS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => createWebSessionOptions(configService),
    },
  ],
})
export class RestAdapterModule {}
