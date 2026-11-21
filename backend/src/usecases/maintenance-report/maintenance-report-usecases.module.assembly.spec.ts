// src/usecases/maintenance-report/maintenance-report-usecases.module.assembly.spec.ts
//
// MaintenanceReportUsecasesModule 离线装配回归（不连接数据库）。
//
// 2026-11-21 需求：任务 06 的工单总结 AI 查询用例（ListWorkOrderSummaryAiConversationsUsecase）
// 依赖任务 05 的 AiConversationQueryService（经 LithographyModule 导出），此前只有
// `new Usecase(...)` 形态的单测，无法证明真实 Nest 容器能解析这条 DI 链。
// 本规格用 Test.createTestingModule 编译真实模块（含 LithographyModule /
// AccountInstallerModule / DocumentExportModule 全量 imports）验证 provider 可解析。
//
// 替身边界：只替换 `TypeOrmModule.forFeature()` 的 Repository provider 与
// TRANSACTION_RUNNER / STORED_FILE_STORAGE 两个端口绑定；DataSource 不注册、
// 不初始化。只证明依赖可被 Nest 解析，不证明 SQL 行为。

/// <reference types="jest" />
import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { DocumentExportModule } from '@src/infrastructure/document-export/document-export.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { STORED_FILE_STORAGE } from '@src/usecases/common/ports/stored-file-storage.contract';
import { TRANSACTION_RUNNER } from '@src/usecases/common/ports/transaction-runner.contract';
import { GetMyWorkOrderSummaryUsecase } from './get-my-work-order-summary.usecase';
import { ListWorkOrderSummaryAiConversationsUsecase } from './list-work-order-summary-ai-conversations.usecase';
import { MaintenanceReportUsecasesModule } from './maintenance-report-usecases.module';
import { SubmitMaintenanceReportFormalUsecase } from './submit-maintenance-report-formal.usecase';

/** 递归收集模块树内 DynamicModule（forFeature 等）声明的 provider token */
const collectDynamicProviderTokens = (entries: unknown[], seen: Set<unknown>): unknown[] => {
  const tokens: unknown[] = [];
  const moduleOf = (entry: unknown): Type<unknown> | null => {
    if (typeof entry === 'function') return entry as Type<unknown>;
    if (typeof entry === 'object' && entry !== null && 'module' in entry) {
      return (entry as DynamicModule).module as Type<unknown>;
    }
    return null;
  };
  for (const entry of entries) {
    if (entry === null || entry === undefined || seen.has(entry)) continue;
    seen.add(entry);
    // DynamicModule（forFeature 等）：收集其声明的 provider token
    if (typeof entry === 'object' && entry !== null && 'providers' in entry) {
      for (const provider of (entry as DynamicModule).providers ?? []) {
        if (typeof provider === 'object' && provider !== null && 'provide' in provider) {
          tokens.push((provider as { provide: unknown }).provide);
        }
      }
    }
    // DynamicModule 自身运行时构建的 imports（如 AccountModule.forRoot()）也要下钻
    if (typeof entry === 'object' && entry !== null && 'imports' in entry) {
      tokens.push(...collectDynamicProviderTokens((entry as DynamicModule).imports ?? [], seen));
    }
    // 类模块与 DynamicModule 都继续下钻装饰器元数据里的 imports
    const moduleRef = moduleOf(entry);
    if (moduleRef !== null) {
      const nestedImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleRef) ??
        []) as unknown[];
      tokens.push(...collectDynamicProviderTokens(nestedImports, seen));
    }
  }
  return tokens;
};

// 离线装配不加载真实 env：部分模块级服务（字段加密）在实例化时读取必需配置，
// 提供满足格式要求的占位值（仅用于 DI 解析，不做真实加密）。
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.FIELD_ENCRYPTION_IV = process.env.FIELD_ENCRYPTION_IV ?? '0'.repeat(32);

/**
 * 离线端口绑定：正式装配中 TRANSACTION_RUNNER / STORED_FILE_STORAGE 由全局
 * TypeOrmTransactionModule / 存储模块提供；离线装配用全局模块显式提供替身。
 */
@Global()
@Module({
  providers: [
    { provide: TRANSACTION_RUNNER, useValue: { run: jest.fn() } },
    { provide: STORED_FILE_STORAGE, useValue: {} },
  ],
  exports: [TRANSACTION_RUNNER, STORED_FILE_STORAGE],
})
class OfflinePortsModule {}

describe('MaintenanceReportUsecasesModule 依赖装配（离线）', () => {
  it('真实容器可解析工单总结 AI 查询与提交用例的完整依赖链（含任务 05 会话读侧）', async () => {
    const imports = (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      MaintenanceReportUsecasesModule,
    ) ?? []) as unknown[];
    const repositoryTokens = collectDynamicProviderTokens(imports, new Set());

    const builder = Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        // DocumentExportModule 渲染器依赖 ConfigService（全局）：离线装配用空配置提供
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, envFilePath: [] as string[] }),
        OfflinePortsModule,
        MaintenanceReportUsecasesModule,
      ],
    });
    for (const token of repositoryTokens) {
      builder.overrideProvider(token).useValue({});
    }
    builder.overrideProvider(getDataSourceToken()).useValue({});

    const moduleRef = await builder.compile();
    try {
      const aiQueryUsecase = moduleRef.get(ListWorkOrderSummaryAiConversationsUsecase);
      expect(aiQueryUsecase).toBeInstanceOf(ListWorkOrderSummaryAiConversationsUsecase);
      const submitUsecase = moduleRef.get(SubmitMaintenanceReportFormalUsecase);
      expect(submitUsecase).toBeInstanceOf(SubmitMaintenanceReportFormalUsecase);
      const entryUsecase = moduleRef.get(GetMyWorkOrderSummaryUsecase);
      expect(entryUsecase).toBeInstanceOf(GetMyWorkOrderSummaryUsecase);
    } finally {
      await moduleRef.close();
    }
  });

  it('模块树覆盖 LithographyModule / AccountInstallerModule / DocumentExportModule', () => {
    const imports = (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      MaintenanceReportUsecasesModule,
    ) ?? []) as unknown[];
    const moduleRefs = imports.map((entry) =>
      typeof entry === 'function'
        ? entry
        : typeof entry === 'object' && entry !== null && 'module' in entry
          ? (entry as DynamicModule).module
          : null,
    );
    expect(moduleRefs).toContain(LithographyModule);
    expect(moduleRefs).toContain(AccountInstallerModule);
    expect(moduleRefs).toContain(DocumentExportModule);
  });
});
