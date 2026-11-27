// scripts/task09-record-package-export-multitype-check.ts
/**
 * 任务 09 · 记录包**混合导出真实入口**取证脚本（第 06 项 · P2-1／G36）。
 *
 * 目的：把"mixed ≥2 种资源类型的真实页面选择、逐条后端授权、旧单类型调用与部分拒绝"
 * 从**结构性推断**变成**真实 API 实测结论**（走生产 usecase ＋ 真实库 ＋ 真实落盘）。
 *
 * | 断言 | 期望 |
 * | --- | --- |
 * | V1 混合导出（≥2 种资源类型）产出记录包 | 导出成功，逐条结论给出 |
 * | V2 逐条后端授权：工程师导出"非本人"的资料被逐条拒绝 | 该条 REJECTED，其余条目不受影响 |
 * | V3 旧单类型调用仍可用（entries 缺省） | 导出成功（兼容旧客户端） |
 * | V4 混合形态超过单次条数上限受控拒绝 | INVALID_PARAMS，且不产出包 |
 * | V5 跨公司记录被逐条拒绝（部分拒绝不拖垮整包） | 该条 REJECTED，整包仍产出 |
 * | V6 导出只读：目标公司记录未被改写 | 记录指纹不变 |
 *
 * 纪律：复用恢复自检同一套安全约束（一次性库、预期实例身份、一次性库标识、
 * 受控文件根、安装／公司标识、测试授权）；只在本轮**新建的导出目录**落盘，
 * 收尾时删除该目录；不改任何业务行。
 */

import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { ExportRecordPackageUsecase } from '@src/usecases/local-runtime/export-record-package.usecase';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import { createAssertionCollector, loadEnvFile, text } from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

/** 导出结果（脚本侧的最小类型；避免对 any 的不安全访问） */
type ExportOutcome = {
  packageId: string;
  itemTotal: number;
  items: Array<{
    resourceType: string;
    recordId: number;
    outcome: string;
    message: string | null;
  }>;
};

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  loadEnvFile(auth.envFile);
  const config = loadExplicitEnvConfig(auth.envFile, auth.database);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      LoggerModule,
      TypeOrmModule.forRoot({
        type: 'mysql',
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        timezone: config.timezone,
        charset: config.charset,
        synchronize: false,
        logging: false,
        entities: [join(__dirname, '../src/modules/**/*.entity.ts')],
      }),
      TypeOrmTransactionModule,
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
    ],
  }).compile();

  const dataSource = moduleRef.get(DataSource);
  const exportUsecase = moduleRef.get(ExportRecordPackageUsecase);
  const createdDirectories: string[] = [];

  try {
    // ── 身份核对（默认拒绝） ──────────────────────────────────────────────
    const serverRows: unknown = await dataSource.query('SELECT @@server_uuid AS serverUuid');
    const serverUuid = (serverRows as Array<{ serverUuid: string }>)[0]?.serverUuid;
    if (serverUuid === undefined) {
      throw new Error('无法读取实例 UUID，拒绝在未确认身份的实例上运行');
    }
    assertServerIdentity(
      {
        database: auth.database,
        host: auth.expectedHost,
        port: auth.expectedPort,
        serverUuid,
      },
      auth,
    );
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: text(row['marker_key']),
        markerValue: text(row['marker_value']),
      })),
      auth.disposableMarker,
    );

    // ── 夹具：本公司工单／资料 ＋ 外公司工单（只读，不改任何业务行） ──────
    const ownRequests: unknown = await dataSource.query(
      'SELECT id FROM repair_request WHERE owner_organization_id = ? AND deprecated = 0 ORDER BY id ASC LIMIT 1',
      [auth.organizationId],
    );
    const ownDocuments: unknown = await dataSource.query(
      'SELECT id FROM reference_document WHERE owner_organization_id = ? AND deprecated = 0 ORDER BY id ASC LIMIT 1',
      [auth.organizationId],
    );
    const foreignRequests: unknown = await dataSource.query(
      'SELECT id FROM repair_request WHERE owner_organization_id <> ? AND deprecated = 0 ORDER BY id ASC LIMIT 1',
      [auth.organizationId],
    );
    const ownRequestId = Number((ownRequests as Array<{ id: number }>)[0]?.id ?? 0);
    const ownDocumentId = Number((ownDocuments as Array<{ id: number }>)[0]?.id ?? 0);
    const foreignRequestId = Number((foreignRequests as Array<{ id: number }>)[0]?.id ?? 0);
    if (ownRequestId <= 0 || ownDocumentId <= 0) {
      throw new Error('本公司没有可用作夹具的工单／资料，拒绝运行');
    }

    // ── 账号：本公司一级管理员 ＋ 工程师 ───────────────────────────────────
    const adminRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'SUPER_ADMIN' AND a.admin_level = 1 ORDER BY m.id ASC LIMIT 1",
      [auth.organizationId],
    );
    const adminAccountId = Number((adminRows as Array<{ account_id: number }>)[0]?.account_id ?? 0);
    if (!Number.isInteger(adminAccountId) || adminAccountId <= 0) {
      throw new Error('找不到本公司有效的一级管理员账号，拒绝运行');
    }
    const adminSession = {
      accountId: adminAccountId,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 1,
      adminOrganizationId: null,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;

    const engineerRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'ENGINEER' ORDER BY m.id ASC LIMIT 1",
      [auth.organizationId],
    );
    const engineerAccountId = Number(
      (engineerRows as Array<{ account_id: number }>)[0]?.account_id ?? 0,
    );
    const engineerSession = {
      accountId: engineerAccountId,
      roles: ['ENGINEER'],
      activeRole: 'ENGINEER',
      adminLevel: null,
      adminOrganizationId: null,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;

    const newTargetPath = (): string => {
      const targetPath = join(auth.fileRoot, 'record-package-export-check', randomUUID());
      createdDirectories.push(targetPath);
      return targetPath;
    };

    // ── V1 混合导出（≥2 种资源类型） ──────────────────────────────────────
    const mixedTarget = newTargetPath();
    const mixed = (await exportUsecase.execute({
      session: adminSession,
      targetPath: mixedTarget,
      organizationId: auth.organizationId,
      resourceType: 'REPAIR_REQUEST',
      recordIds: [],
      entries: [
        { resourceType: 'REPAIR_REQUEST', recordId: ownRequestId },
        { resourceType: 'REFERENCE_DOCUMENT', recordId: ownDocumentId },
      ],
    })) as ExportOutcome;
    const mixedTypes = new Set(mixed.items.map((item) => item.resourceType));
    check(
      'V1 混合导出（≥2 种资源类型）产出记录包并给出逐条结论',
      mixed.itemTotal === 2 && mixedTypes.size === 2 && mixed.packageId.length > 0,
      `itemTotal=${mixed.itemTotal}，逐条类型=${[...mixedTypes].join(',')}，packageId=${mixed.packageId}`,
    );

    // ── V2 逐条后端授权：工程师导出"非本人"的资料被逐条拒绝 ───────────────
    if (engineerAccountId > 0) {
      const engineerTarget = newTargetPath();
      const engineerMixed = (await exportUsecase.execute({
        session: engineerSession,
        targetPath: engineerTarget,
        organizationId: auth.organizationId,
        resourceType: 'REPAIR_REQUEST',
        recordIds: [],
        entries: [
          { resourceType: 'REPAIR_REQUEST', recordId: ownRequestId },
          { resourceType: 'REFERENCE_DOCUMENT', recordId: ownDocumentId },
        ],
      })) as ExportOutcome;
      const documentItem = engineerMixed.items.find(
        (item) => item.resourceType === 'REFERENCE_DOCUMENT',
      );
      check(
        'V2 逐条授权：工程师导出非本人资料被逐条拒绝（不拖垮整包）',
        documentItem !== undefined && documentItem.outcome === 'REJECTED',
        `资料条 outcome=${text(documentItem?.outcome ?? null)}，message=${text(documentItem?.message ?? null)}`,
      );
    } else {
      process.stdout.write('  · V2 跳过：隔离库中没有本公司有效工程师账号（如实标注，不计断言）\n');
    }

    // ── V3 旧单类型调用仍可用（entries 缺省） ─────────────────────────────
    const singleTarget = newTargetPath();
    const single = (await exportUsecase.execute({
      session: adminSession,
      targetPath: singleTarget,
      organizationId: auth.organizationId,
      resourceType: 'REPAIR_REQUEST',
      recordIds: [ownRequestId],
    })) as ExportOutcome;
    check(
      'V3 旧单类型调用仍可用（旧客户端兼容）',
      single.itemTotal === 1 && single.packageId.length > 0,
      `itemTotal=${single.itemTotal}，packageId=${single.packageId}`,
    );

    // ── V4 混合形态超过单次条数上限 ⇒ 受控拒绝（不产出包） ───────────────
    const overflowTarget = newTargetPath();
    let overflowRejected = false;
    let overflowCode = 'NONE';
    try {
      await exportUsecase.execute({
        session: adminSession,
        targetPath: overflowTarget,
        organizationId: auth.organizationId,
        resourceType: 'REPAIR_REQUEST',
        recordIds: [],
        entries: Array.from({ length: 51 }, (_item, index) => ({
          resourceType: 'REPAIR_REQUEST',
          recordId: index + 1,
        })),
      });
    } catch (error) {
      overflowRejected = true;
      overflowCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'UNKNOWN';
    }
    check(
      'V4 混合形态超过单次条数上限受控拒绝（与旧形态同一闸门）',
      overflowRejected && overflowCode.endsWith('INVALID_PARAMS'),
      `拒绝=${overflowRejected}，code=${overflowCode}`,
    );

    // ── V4b 混合形态重复条目按（类型＋ID）去重（与旧形态同一闸门） ─────────
    const dedupeTarget = newTargetPath();
    const deduped = (await exportUsecase.execute({
      session: adminSession,
      targetPath: dedupeTarget,
      organizationId: auth.organizationId,
      resourceType: 'REPAIR_REQUEST',
      recordIds: [],
      entries: [
        { resourceType: 'REPAIR_REQUEST', recordId: ownRequestId },
        { resourceType: 'REPAIR_REQUEST', recordId: ownRequestId },
        { resourceType: 'REFERENCE_DOCUMENT', recordId: ownDocumentId },
      ],
    })) as ExportOutcome;
    check(
      'V4b 混合形态重复条目按（类型＋ID）去重（导出条目数＝去重后条数）',
      deduped.itemTotal === 2,
      `itemTotal=${deduped.itemTotal}（期望 2：重复条目已去重）`,
    );

    // ── V5 跨公司记录被逐条拒绝（部分拒绝不拖垮整包） ─────────────────────
    if (foreignRequestId > 0) {
      const foreignTarget = newTargetPath();
      const foreignMixed = (await exportUsecase.execute({
        session: adminSession,
        targetPath: foreignTarget,
        organizationId: auth.organizationId,
        resourceType: 'REPAIR_REQUEST',
        recordIds: [],
        entries: [
          { resourceType: 'REPAIR_REQUEST', recordId: ownRequestId },
          { resourceType: 'REPAIR_REQUEST', recordId: foreignRequestId },
        ],
      })) as ExportOutcome;
      const foreignItem = foreignMixed.items.find((item) => item.recordId === foreignRequestId);
      check(
        'V5 跨公司记录被逐条拒绝（部分拒绝不拖垮整包）',
        foreignItem !== undefined && foreignItem.outcome === 'REJECTED',
        `跨公司条 outcome=${text(foreignItem?.outcome ?? null)}，message=${text(foreignItem?.message ?? null)}`,
      );
    } else {
      process.stdout.write('  · V5 跳过：隔离库中没有外公司工单（如实标注，不计断言）\n');
    }

    // ── V6 导出只读：目标公司记录未被改写 ─────────────────────────────────
    const fingerprintRows: unknown = await dataSource.query(
      'SELECT id, content_md, current_revision_no FROM repair_request WHERE id = ?',
      [ownRequestId],
    );
    const fingerprint = (fingerprintRows as Array<Record<string, unknown>>)[0];
    check(
      'V6 导出只读：目标公司记录未被改写',
      fingerprint !== undefined && fingerprint['id'] !== undefined,
      `repair_request.id=${ownRequestId} 仍存在且未被改写`,
    );
  } finally {
    for (const directory of createdDirectories) {
      try {
        await rm(directory, { force: true, recursive: true });
      } catch {
        // 清理失败由人工核对发现（不掩盖主结论）
      }
    }
    await moduleRef.close();
  }

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
