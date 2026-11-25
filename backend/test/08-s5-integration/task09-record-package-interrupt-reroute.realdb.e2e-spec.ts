// test/08-s5-integration/task09-record-package-interrupt-reroute.realdb.e2e-spec.ts
/**
 * 任务 09 · 02/03 项反例：**部分成功后停止 → 新 package_id 重导**。
 *
 * 本规格已按复验意见改为调用**正式 `ImportRecordPackageUsecase.execute`** 裁决，
 * 不再手工写 `SKIPPED`。当前实现的如实基线：A 回执存整包摘要 `a*64`，B 包新编号
 * 新摘要 `b*64`，同一四维键命中 ⇒ 正式入口判 `CONFLICT`，**不是**自动跳过。
 * 该基线是诊断事实，不代表已批准的产品语义。
 *
 * 范围声明（替身逐项列出，不称完整真实重导）：
 * - 真实：隔离库事务、`RecordPackageImportService` 的批次/条目/回执读写、
 *   `BusinessSyncReceiptService.recordImportedVersion`、正式导入用例的裁决与终态更新；
 * - 替身：`evaluatePackage`（包文件检查，以本构造的合法清单直接返回）、
 *   `writer`（业务写入，CONFLICT 条目不会用到）、`originalStagingService`（原件暂存）、
 *   `scopeResolver` / `sourceRecordQueryService` / `localWriteHoldService`（只读准入）；
 * - "进程停止"由服务层在 A 批次写第 1 条后不再推进模拟，**未 SIGKILL/断连**。
 * - 附件字节用每轮唯一文件根的真实文件哈希哨兵；真实业务 writer 与真实附件绑定未构造。
 *
 * 纪律：对象全部为本轮 `randomUUID()` 新建并按真实 ID 登记；收尾走库白名单 +
 * 显式物理清理许可 + 全量预检 + 同事务精确删除；文件精确 unlink/rmdir。
 *
 * 启用：
 *   TASK09_RECORD_PACKAGE_INTERRUPT_REROUTE=1 E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     E2E_REAL_DB_NAME=<隔离库> E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest --testPathIgnorePatterns "/node_modules/" "/dist/" \
 *     --runTestsByPath test/08-s5-integration/task09-record-package-interrupt-reroute.realdb.e2e-spec.ts --runInBand
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';
import { SyncConflictEntity } from '@src/modules/lithography/entities/sync-conflict.entity';
import { RecordPackageImportEntity } from '@src/modules/lithography/entities/record-package-import.entity';
import { RecordPackageItemEntity } from '@src/modules/lithography/entities/record-package-item.entity';
import { SyncReceiptEntity } from '@src/modules/lithography/entities/sync-receipt.entity';
import {
  RecordPackageImportService,
  type RecordPackageEvaluation,
} from '@src/modules/lithography/record-package-import.service';
import { ImportRecordPackageUsecase } from '@src/usecases/local-runtime/import-record-package.usecase';

import type { TransactionRunner } from '@usecases/common/ports/transaction-runner.contract';

import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  cleanupOwnedFileRoot,
  createOwnedFileRoot,
  type OwnedFileRoot,
} from '../utils/task09-real-db-cleanup';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
} from '../utils/e2e-scoped-cleanup';

jest.setTimeout(120_000);

const ENABLED = process.env.TASK09_RECORD_PACKAGE_INTERRUPT_REROUTE === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';

const OWN_ORGANIZATION_ID = 1;
const PEER_ORGANIZATION_ID = 910002;
const ACTOR_ACCOUNT_ID = 900001;
const RESOURCE_TYPE = 'REPAIR_REQUEST';

type EvaluationInput = {
  packageId: string;
  targetOrganizationId: number;
  manifestChecksum: string;
  installationId: string;
  recordUuids: string[];
};

/** 合法记录包清单 + 评估快照（evaluatePackage 替身直接返回它）。 */
function buildEvaluation(input: EvaluationInput): RecordPackageEvaluation {
  const manifest = {
    schema_version: 1,
    package_id: input.packageId,
    organization_id: input.targetOrganizationId,
    organization_code: 'CLIENT_DEFAULT',
    installation_id: input.installationId,
    generated_at: '2026-11-25T00:00:00.000Z',
    items: input.recordUuids.map((recordUuid) => ({
      record_uuid: recordUuid,
      resource_type: RESOURCE_TYPE,
      version_no: 1,
      content_snapshot: { schema_version: 1, payload: { title: '中断重导反例' } },
      files: [],
      source_account_id: ACTOR_ACCOUNT_ID,
      owner_organization_id: input.targetOrganizationId,
    })),
  };
  return {
    manifest,
    manifestRaw: JSON.stringify(manifest),
    manifestChecksum: input.manifestChecksum,
    targetOrganizationId: input.targetOrganizationId,
    outcomes: input.recordUuids.map((recordUuid) => ({
      recordUuid,
      resourceType: RESOURCE_TYPE,
      versionNo: 1,
      passed: true,
      rejection: null,
      message: null,
    })),
  };
}

const session: UsecaseSession = {
  accountId: ACTOR_ACCOUNT_ID,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
  adminLevel: null,
  customerOrganizationId: null,
};

describeIntegration('记录包中断后新编号重导反例（正式入口，隔离库）', () => {
  let dataSource: DataSource;
  let service: RecordPackageImportService;
  let receiptService: BusinessSyncReceiptService;
  let importUsecase: ImportRecordPackageUsecase;
  let installationId: string;
  let fileRoot: OwnedFileRoot;
  const createdFilePaths: string[] = [];
  const owned = createOwnedResourceLedger();

  beforeAll(async () => {
    const declared = process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);
    dataSource = new DataSource({
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
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
    });
    await dataSource.initialize();
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);

    service = new RecordPackageImportService(
      dataSource.getRepository(RecordPackageImportEntity),
      dataSource.getRepository(RecordPackageItemEntity),
      dataSource.getRepository(SyncReceiptEntity),
      { findOrganizationIdentityByCode: () => Promise.resolve(null) } as never,
    );
    receiptService = new BusinessSyncReceiptService(
      dataSource.getRepository(SyncReceiptEntity),
      dataSource.getRepository(SyncConflictEntity),
    );

    const installation = await dataSource.query(
      'SELECT installation_id FROM local_installation LIMIT 1',
    );
    installationId = String(installation[0]?.installation_id ?? '');
    if (installationId === '') {
      throw new Error('隔离库缺少本机安装身份，无法构造导入回执');
    }
    fileRoot = createOwnedFileRoot(
      join(__dirname, '../../.local/task09'),
      'task09-interrupt-reroute-',
    );

    const transactionRunner = {
      run: <T>(fn: (context: unknown) => Promise<T>): Promise<T> =>
        dataSource.transaction(async (manager) =>
          fn(createTypeOrmPersistenceTransactionContext(manager)),
        ),
    } as TransactionRunner;
    const writer = {
      supportedResourceTypes: [RESOURCE_TYPE],
      verifySourceIdentity: () =>
        Promise.resolve({ allowed: true, sourceAccountId: ACTOR_ACCOUNT_ID }),
      write: () => Promise.resolve({ status: 'CREATED', localRecordId: 1, reason: null }),
    };
    importUsecase = new ImportRecordPackageUsecase(
      {
        resolve: () => Promise.resolve({ organizationId: OWN_ORGANIZATION_ID, role: 'ENGINEER' }),
      } as never,
      service,
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'CLIENT_DEFAULT' }),
      } as never,
      receiptService,
      { stage: () => Promise.resolve([]), release: () => Promise.resolve(0) } as never,
      { listFacts: () => Promise.resolve({ facts: new Map(), scanComplete: true }) } as never,
      { assertCompanyWritable: () => Promise.resolve(undefined) } as never,
      { get: () => writer } as never,
      transactionRunner,
    );
  });

  afterAll(async () => {
    const errors: Array<{ stage: string; error: unknown }> = [];
    let dbCleanupSucceeded = false;
    try {
      await runGuardedSpecCleanup({
        dataSource,
        owned,
        helper: '中断重导反例 afterAll 精确回收',
        expectedDatabase: process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e',
      });
      dbCleanupSucceeded = true;
    } catch (error) {
      errors.push({ stage: '数据库清理', error });
    }
    if (dbCleanupSucceeded) {
      try {
        cleanupOwnedFileRoot(fileRoot, createdFilePaths);
      } catch (error) {
        errors.push({ stage: '文件清理', error });
      }
    } else {
      errors.push({
        stage: '文件保留诊断',
        error: new Error(`数据库清理未明确成功，保留唯一文件根=${fileRoot.root}`),
      });
    }
    try {
      await dataSource.destroy();
    } catch (error) {
      errors.push({ stage: '连接关闭', error });
    }
    if (errors.length > 0) {
      throw new Error(
        `本轮收尾失败（唯一文件根=${fileRoot.root}）：` +
          errors
            .map(
              ({ stage, error }) =>
                `[${stage}] ${error instanceof Error ? error.message : String(error)}`,
            )
            .join(' | '),
        { cause: errors },
      );
    }
  });

  const readBatch = async (packageId: string): Promise<Record<string, unknown> | null> => {
    const rows = await dataSource.query(
      'SELECT * FROM `record_package_import` WHERE `package_id` = ?',
      [packageId],
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  };

  const readItems = async (packageId: string): Promise<Record<string, unknown>[]> =>
    await dataSource.query(
      'SELECT * FROM `record_package_item` WHERE `package_id` = ? ORDER BY `id` ASC',
      [packageId],
    );

  const registerOwned = async (input: {
    packageId: string;
    manifestChecksum: string;
  }): Promise<void> => {
    recordOwnedResource(owned, 'recordPackageImport', input.packageId, {
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: input.manifestChecksum,
    });
    for (const item of await readItems(input.packageId)) {
      recordOwnedResource(owned, 'recordPackageItem', Number(item.id), {
        packageId: input.packageId,
        recordUuid: String(item.record_uuid),
        resourceType: String(item.resource_type),
        versionNo: Number(item.version_no),
        receiptId:
          item.receipt_id === null || item.receipt_id === undefined
            ? null
            : String(item.receipt_id as string),
      });
    }
  };

  it('基线：A 部分成功停止后，新编号 B 经正式入口对同键条目判 CONFLICT（不误报跳过）', async () => {
    const originalPath = join(fileRoot.root, 'original.bin');
    const originalBytes = Buffer.from('%PDF-1.7\ninterrupt-reroute-original');
    writeFileSync(originalPath, originalBytes);
    createdFilePaths.push(originalPath);
    const originalSha256 = createHash('sha256').update(originalBytes).digest('hex');

    const packageA = randomUUID();
    const checksumA = 'a'.repeat(64);
    const uuidFirst = randomUUID();
    const uuidSecond = randomUUID();
    const outsideSentinel = randomUUID();

    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId: packageA,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: checksumA,
          installationId,
          recordUuids: [uuidFirst, uuidSecond],
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwned({ packageId: packageA, manifestChecksum: checksumA });

    await dataSource.transaction(async (manager) => {
      const claimed = await service.claimImportRun({
        packageId: packageA,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        organizationId: OWN_ORGANIZATION_ID,
        manifestChecksum: checksumA,
        transactionContext: createTypeOrmPersistenceTransactionContext(manager),
      });
      expect(claimed.import.status).toBe('RUNNING');
    });

    // 部分成功：第 1 条已有非空摘要回执 + SUCCEEDED；第 2 条不推进（服务层模拟停止）。
    const itemAFirst = (await readItems(packageA)).find((item) => item.record_uuid === uuidFirst);
    expect(itemAFirst).toBeDefined();
    const receiptFirst = await dataSource.transaction(async (manager) =>
      receiptService.recordImportedVersion(
        {
          organizationId: OWN_ORGANIZATION_ID,
          resourceType: RESOURCE_TYPE,
          recordUuid: uuidFirst,
          versionNo: 1,
          manifestChecksum: checksumA,
          sourceInstallationId: installationId,
        },
        createTypeOrmPersistenceTransactionContext(manager),
      ),
    );
    recordOwnedResource(owned, 'syncReceipt', receiptFirst, {
      organizationId: OWN_ORGANIZATION_ID,
      recordUuid: uuidFirst,
      resourceType: RESOURCE_TYPE,
      versionNo: 1,
      sourceSystem: 'LOCAL',
    });
    await service.writeItemResult(String(itemAFirst?.id), {
      result: 'SUCCEEDED',
      errorMessage: null,
      receiptId: receiptFirst,
    });
    updateOwnedExpectation(owned, 'recordPackageItem', Number(itemAFirst?.id), {
      receiptId: receiptFirst,
    });
    expect((await readBatch(packageA))?.status).toBe('RUNNING');

    // 新编号 B：同一业务稳定编号，新摘要；**走正式导入用例**。
    const packageB = randomUUID();
    const checksumB = 'b'.repeat(64);
    const evaluationB = buildEvaluation({
      packageId: packageB,
      targetOrganizationId: OWN_ORGANIZATION_ID,
      manifestChecksum: checksumB,
      installationId,
      recordUuids: [uuidFirst, uuidSecond],
    });
    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        evaluationB,
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwned({ packageId: packageB, manifestChecksum: checksumB });

    jest.spyOn(service, 'evaluatePackage').mockResolvedValue(evaluationB);
    const result = await importUsecase.execute({
      session,
      packageId: packageB,
      packagePath: join(fileRoot.root, 'not-read-evaluate-is-stubbed'),
      manifestChecksum: checksumB,
    });

    const itemsB = result.items;
    expect(itemsB.length).toBe(2);
    expect(itemsB.find((item) => item.recordUuid === uuidFirst)?.result).toBe('CONFLICT');
    expect(itemsB.find((item) => item.recordUuid === uuidSecond)?.result).toBe('SUCCEEDED');
    expect((await readBatch(packageB))?.status).toBe('PARTIAL');
    // B 的第 2 条回执由正式用例经真实 BusinessSyncReceiptService 写入。
    const receiptSecond = itemsB.find((item) => item.recordUuid === uuidSecond)?.receiptId;
    expect(receiptSecond).toBeTruthy();
    recordOwnedResource(owned, 'syncReceipt', String(receiptSecond), {
      organizationId: OWN_ORGANIZATION_ID,
      recordUuid: uuidSecond,
      resourceType: RESOURCE_TYPE,
      versionNo: 1,
      sourceSystem: 'LOCAL',
    });
    updateOwnedExpectation(
      owned,
      'recordPackageItem',
      Number((await readItems(packageB)).find((item) => item.record_uuid === uuidSecond)?.id),
      { receiptId: String(receiptSecond) },
    );

    // 旧批次未被自动接管：同账号/跨公司占用都被拒，仍为 RUNNING。
    await expect(
      service.claimImportRun({
        packageId: packageA,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        organizationId: OWN_ORGANIZATION_ID,
        manifestChecksum: checksumA,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });
    await expect(
      service.claimImportRun({
        packageId: packageA,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        organizationId: PEER_ORGANIZATION_ID,
        manifestChecksum: checksumA,
      }),
    ).rejects.toBeDefined();
    expect((await readBatch(packageA))?.status).toBe('RUNNING');

    // 四维键仍唯一；哨兵编号无回执；附件字节未被重导改动。
    const receiptCounts = await dataSource.query(
      'SELECT `record_uuid`, COUNT(*) AS n FROM `sync_receipt` WHERE `record_uuid` IN (?, ?, ?) GROUP BY `record_uuid`',
      [uuidFirst, uuidSecond, outsideSentinel],
    );
    const counts = new Map(
      (receiptCounts as Array<{ record_uuid: string; n: number }>).map((row) => [
        String(row.record_uuid),
        Number(row.n),
      ]),
    );
    expect(counts.get(uuidFirst)).toBe(1);
    expect(counts.get(uuidSecond)).toBe(1);
    expect(counts.get(outsideSentinel)).toBeUndefined();
    expect(createHash('sha256').update(readFileSync(originalPath)).digest('hex')).toBe(
      originalSha256,
    );
  });
});
