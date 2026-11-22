// src/usecases/reference-document/reference-document-usecases.module.assembly.spec.ts
//
// ReferenceDocumentUsecasesModule 离线装配回归（不连接数据库 / Redis）。
//
// 2026-11-22 需求：任务 07 结构化管理修订的两个用例
// （GetReferenceDocumentEditableContentUsecase / ReviseReferenceDocumentStructuredUsecase）
// 此前只有 `new Usecase(...)` 形态的单测，无法证明真实 Nest 容器能解析其 DI 链；
// 且构造器参数曾以 `import type` 引入 QueryService，type-only import 不生成
// design:paramtypes 元数据，导致真实启动失败而离线单测全部通过。
// 本规格用 Test.createTestingModule 编译真实模块（含 LithographyModule /
// AccountInstallerModule 全量 imports）验证 provider 可解析。
//
// 替身边界：只替换 `TypeOrmModule.forFeature()` 的 Repository provider 与
// TRANSACTION_RUNNER / REFERENCE_DOCUMENT_STORAGE 两个端口绑定；DataSource 不注册、
// 不初始化、不连接 Redis。只证明依赖可被 Nest 解析，不证明 SQL / 存储行为，
// 也不等同于 API 真实启动成功（启动还涉及全局模块、配置加载与 schema 生成）。

/// <reference types="jest" />
import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { STORED_FILE_STORAGE } from '@src/usecases/common/ports/stored-file-storage.contract';
import { TRANSACTION_RUNNER } from '@src/usecases/common/ports/transaction-runner.contract';
import { DownloadReferenceDocumentSourceAttachmentUsecase } from './download-reference-document-source-attachment.usecase';
import { GetReferenceDocumentEditableContentUsecase } from './get-reference-document-editable-content.usecase';
import { GetReferenceDocumentFileUsecase } from './get-reference-document-file.usecase';
import { REFERENCE_DOCUMENT_STORAGE } from './reference-document-storage.contract';
import { ReferenceDocumentUsecasesModule } from './reference-document-usecases.module';
import { ReviseReferenceDocumentStructuredUsecase } from './revise-reference-document-structured.usecase';
import { ReviseReferenceDocumentUsecase } from './revise-reference-document.usecase';

/** 递归收集模块树内 DynamicModule（forFeature 等）声明的 provider token */
const collectDynamicProviderTokens = (entries: unknown[], seen: unknown[] = []): unknown[] => {
  const tokens: unknown[] = [];
  const moduleOf = (entry: unknown): Type<unknown> | null => {
    if (typeof entry === 'function') return entry as Type<unknown>;
    if (typeof entry === 'object' && entry !== null && 'module' in entry) {
      return (entry as DynamicModule).module as Type<unknown>;
    }
    return null;
  };
  for (const entry of entries) {
    if (entry === null || entry === undefined || seen.includes(entry)) continue;
    seen.push(entry);
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
 * 离线端口绑定：正式装配中 TRANSACTION_RUNNER 由全局 TypeOrmTransactionModule、
 * REFERENCE_DOCUMENT_STORAGE / STORED_FILE_STORAGE 由存储模块提供；离线装配用
 * 全局模块显式提供替身（STORED_FILE_STORAGE 为任务 07 P2 来源报告原件下载用例新增依赖）。
 */
@Global()
@Module({
  providers: [
    { provide: TRANSACTION_RUNNER, useValue: { run: jest.fn() } },
    { provide: REFERENCE_DOCUMENT_STORAGE, useValue: {} },
    { provide: STORED_FILE_STORAGE, useValue: {} },
  ],
  exports: [TRANSACTION_RUNNER, REFERENCE_DOCUMENT_STORAGE, STORED_FILE_STORAGE],
})
class OfflinePortsModule {}

describe('ReferenceDocumentUsecasesModule 依赖装配（离线）', () => {
  it('真实容器可解析结构化修订与编辑初值读侧用例的完整依赖链', async () => {
    const imports = (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ReferenceDocumentUsecasesModule,
    ) ?? []) as unknown[];
    const repositoryTokens = collectDynamicProviderTokens(imports);

    const builder = Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, envFilePath: [] as string[] }),
        OfflinePortsModule,
        ReferenceDocumentUsecasesModule,
      ],
    });
    for (const token of repositoryTokens) {
      builder.overrideProvider(token).useValue({});
    }
    builder.overrideProvider(getDataSourceToken()).useValue({});

    const moduleRef = await builder.compile();
    try {
      const editableContentUsecase = moduleRef.get(GetReferenceDocumentEditableContentUsecase);
      expect(editableContentUsecase).toBeInstanceOf(GetReferenceDocumentEditableContentUsecase);
      const structuredReviseUsecase = moduleRef.get(ReviseReferenceDocumentStructuredUsecase);
      expect(structuredReviseUsecase).toBeInstanceOf(ReviseReferenceDocumentStructuredUsecase);
      const reviseUsecase = moduleRef.get(ReviseReferenceDocumentUsecase);
      expect(reviseUsecase).toBeInstanceOf(ReviseReferenceDocumentUsecase);
      const fileUsecase = moduleRef.get(GetReferenceDocumentFileUsecase);
      expect(fileUsecase).toBeInstanceOf(GetReferenceDocumentFileUsecase);
      // 任务 07 P2：来源报告冻结版本原件下载用例依赖链（含 STORED_FILE_STORAGE）可解析
      const sourceAttachmentDownloadUsecase = moduleRef.get(
        DownloadReferenceDocumentSourceAttachmentUsecase,
      );
      expect(sourceAttachmentDownloadUsecase).toBeInstanceOf(
        DownloadReferenceDocumentSourceAttachmentUsecase,
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('模块树覆盖 LithographyModule / AccountInstallerModule', () => {
    const imports = (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ReferenceDocumentUsecasesModule,
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
  });
});
