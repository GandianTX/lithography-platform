// src/adapters/api/graphql/graphql-adapter.module.ts

import { AccountUsecasesModule } from '@src/usecases/account/account-usecases.module';
import { AiQueueUsecasesModule } from '@src/usecases/ai-queue/ai-queue-usecases.module';
import { AuthUsecasesModule } from '@src/usecases/auth/auth-usecases.module';
import { AsyncTaskRecordUsecasesModule } from '@src/usecases/async-task-record/async-task-record-usecases.module';
import { AdminDocumentDatabaseUsecasesModule } from '@src/usecases/admin-document-database/admin-document-database-usecases.module';
import { ContentSubmissionUsecasesModule } from '@src/usecases/content-submission/content-submission-usecases.module';
import { EmailQueueUsecasesModule } from '@src/usecases/email-queue/email-queue-usecases.module';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { MaintenanceReportUsecasesModule } from '@src/usecases/maintenance-report/maintenance-report-usecases.module';
import { RegistrationUsecasesModule } from '@src/usecases/registration/registration-usecases.module';
import { ReferenceDocumentUsecasesModule } from '@src/usecases/reference-document/reference-document-usecases.module';
import { RepairRequestUsecasesModule } from '@src/usecases/repair-request/repair-request-usecases.module';
import { ThirdPartyAccountsUsecasesModule } from '@src/usecases/third-party-accounts/third-party-accounts-usecases.module';
import { VerificationRecordUsecasesModule } from '@src/usecases/verification-record/verification-record-usecases.module';
import { VerificationUsecasesModule } from '@src/usecases/verification/verification-usecases.module';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';

// Resolvers
import { AccountResolver } from './account/account.resolver';
import { AdminUserResolver } from './account/admin-user.resolver';
import { MyAccountSettingsResolver } from './account/my-account-settings.resolver';
import { AdminDocumentDatabaseResolver } from './admin-document-database/admin-document-database.resolver';
import { AiResolver } from './ai/ai.resolver';
import { UserInfoResolver } from './account/user-info.resolver';
import { AuthResolver } from './auth/auth.resolver';
import { ContentSubmissionResolver } from './content-submission/content-submission.resolver';
import { EmailResolver } from './email/email.resolver';
import { EquipmentModelResolver } from './equipment-model/equipment-model.resolver';
import { ReferenceDocumentResolver } from './reference-document/reference-document.resolver';
import { RegistrationResolver } from './registration/registration.resolver';
import { RepairRequestResolver } from './repair-request/repair-request.resolver';
import { ThirdPartyAuthResolver } from './third-party-auth/third-party-auth.resolver';
import { VerificationRecordResolver } from './verification-record/verification-record.resolver';

// Guards
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { QmWorkerEntryGuard } from './guards/qm-worker-entry.guard';
import {
  QM_WORKER_ENTRY_OPTIONS,
  type QmWorkerEntryOptions,
} from './guards/qm-worker-entry.options';
import { JWT_STRATEGY_OPTIONS, type JwtStrategyOptions } from './strategies/jwt-strategy.options';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * GraphQL 适配器模块
 * 统一管理所有 GraphQL Resolvers 和相关的 Guards，遵循适配器层架构原则
 */
@Module({
  imports: [
    // 导入业务模块以获取服务
    AccountUsecasesModule,
    AdminDocumentDatabaseUsecasesModule,
    AiQueueUsecasesModule,
    AsyncTaskRecordUsecasesModule,
    AuthUsecasesModule,
    ContentSubmissionUsecasesModule,
    EmailQueueUsecasesModule,
    MaintenanceReportUsecasesModule,
    // 本地运行数据：上传/备份为本机代理与调度器的内部用例，
    // 真实接收端接入前不暴露 GraphQL 字段（当前无 resolver 消费）
    LocalRuntimeUsecasesModule,
    RegistrationUsecasesModule,
    ReferenceDocumentUsecasesModule,
    RepairRequestUsecasesModule,
    ThirdPartyAccountsUsecasesModule,
    VerificationRecordUsecasesModule,
    VerificationUsecasesModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  providers: [
    {
      provide: JWT_STRATEGY_OPTIONS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtStrategyOptions => {
        const secret = configService.get<string>('jwt.secret');
        if (!secret) {
          throw new Error('JWT secret 配置缺失');
        }
        const issuer = configService.get<string>('jwt.issuer')?.trim() || undefined;
        const audience = configService
          .get<string>('jwt.audience')
          ?.split(',')
          .map((audienceItem) => audienceItem.trim())
          .filter((audienceItem) => audienceItem.length > 0);
        return {
          secret,
          issuer,
          audience: audience && audience.length > 0 ? audience : undefined,
        };
      },
    },
    {
      provide: QM_WORKER_ENTRY_OPTIONS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): QmWorkerEntryOptions => ({
        aiEnabled: configService.get<boolean | undefined>('qmWorkerEntry.ai.enabled') === true,
        emailEnabled:
          configService.get<boolean | undefined>('qmWorkerEntry.email.enabled') === true,
      }),
    },
    // Resolvers
    AccountResolver,
    AdminUserResolver,
    MyAccountSettingsResolver,
    AdminDocumentDatabaseResolver,
    AiResolver,
    AuthResolver,
    ContentSubmissionResolver,
    ThirdPartyAuthResolver,
    EmailResolver,
    EquipmentModelResolver,
    ReferenceDocumentResolver,
    RegistrationResolver,
    RepairRequestResolver,
    VerificationRecordResolver,
    UserInfoResolver,
    // Guards
    QmWorkerEntryGuard,
    JwtAuthGuard,
    RolesGuard,
    JwtStrategy,
  ],
  exports: [
    // Resolvers
    AccountResolver,
    AdminUserResolver,
    MyAccountSettingsResolver,
    AdminDocumentDatabaseResolver,
    AiResolver,
    AuthResolver,
    ContentSubmissionResolver,
    ThirdPartyAuthResolver,
    EmailResolver,
    EquipmentModelResolver,
    ReferenceDocumentResolver,
    RegistrationResolver,
    RepairRequestResolver,
    VerificationRecordResolver,
    UserInfoResolver,
    QmWorkerEntryGuard,
    JwtAuthGuard,
    RolesGuard,
    JwtStrategy,
  ],
})
export class GraphQLAdapterModule {}
