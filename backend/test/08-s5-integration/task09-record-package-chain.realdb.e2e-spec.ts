// test/08-s5-integration/task09-record-package-chain.realdb.e2e-spec.ts
/**
 * 任务 09 · F1/F3 链反例：**真实检查入口 → 真实导入入口**，不替换 evaluatePackage、
 * 不手工写目标结果、不直接插目标状态。
 *
 * 范围声明：
 * - 真实：隔离库事务、真实 `RecordPackageImportService.evaluatePackage`（含文件 SHA-256
 *   校验与回执存在性）、`persistCheckOutcome`、`CheckRecordPackageUsecase.execute`、
 *   `ImportRecordPackageUsecase.execute`、`BusinessSyncReceiptService` 回执写入；
 * - 替身：`writer`（业务记录写入，明确不可用真实业务 writer）、`scopeResolver` 与
 *   `organizationQueryService` 的只读身份解析；
 * - "旧执行已停止"在反例中以**先写回执、不再推进旧批次**表示，未 SIGKILL/断连。
 *
 * 覆盖：包内清单重复、全重复、混合（1 重复 + 1 新）、回执晚到、硬阻断混合包、
 * 确认期同长度篡改/删除原件、当前权限撤销、全新包与非法文件的正式检查与导入结果。
 *
 * 启用：
 *   TASK09_RECORD_PACKAGE_CHAIN=1 E2E_ALLOWED_DB_NAMES=<库> E2E_REAL_DB_NAME=<库> \
 *     E2E_ALLOW_PHYSICAL_CLEANUP=1 npx jest --testPathIgnorePatterns "/node_modules/" "/dist/" \
 *     --runTestsByPath test/08-s5-integration/task09-record-package-chain.realdb.e2e-spec.ts --runInBand
 *
 * 一次性专用环境可额外设置 `TASK09_RECORD_PACKAGE_ENV_FILE`（指向专用 env 文件）与
 * `TASK09_RECORD_PACKAGE_FILE_ROOT`（专用文件根的父目录）；默认仍为仓库 e2e 配置与
 * `.local/task09`，所有库名白名单、清理许可与文件归属守卫保持不变。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { RECORD_PACKAGE_ERROR } from '@core/common/errors';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';
import { SyncConflictEntity } from '@src/modules/lithography/entities/sync-conflict.entity';
import { RecordPackageImportEntity } from '@src/modules/lithography/entities/record-package-import.entity';
import { RecordPackageItemEntity } from '@src/modules/lithography/entities/record-package-item.entity';
import { SyncReceiptEntity } from '@src/modules/lithography/entities/sync-receipt.entity';
import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import { CheckRecordPackageUsecase } from '@src/usecases/local-runtime/check-record-package.usecase';
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

const ENABLED = process.env.TASK09_RECORD_PACKAGE_CHAIN === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
/** 默认仍指向仓库 e2e 环境；一次性专用库可用该变量显式改指向临时环境文件。 */
const ENV_FILE = process.env.TASK09_RECORD_PACKAGE_ENV_FILE ?? 'env/.env.e2e';
/** 默认文件根不变；一次性专用文件根可用该变量显式指定。 */
const FILE_ROOT_BASE =
  process.env.TASK09_RECORD_PACKAGE_FILE_ROOT ?? join(__dirname, '../../.local/task09');
const ORGANIZATION_ID = 1;
const ACTOR_ACCOUNT_ID = 900001;
const RESOURCE_TYPE = 'REPAIR_REQUEST';

const session: UsecaseSession = {
  accountId: ACTOR_ACCOUNT_ID,
  roles: [IdentityTypeEnum.ENGINEER],
  activeRole: IdentityTypeEnum.ENGINEER,
  adminLevel: null,
  customerOrganizationId: null,
};

type ChainItem = {
  recordUuid: string;
  resourceType?: string;
  versionNo?: number;
  bytes?: Buffer;
};

describeIntegration('记录包正式检查→导入链反例（隔离库，不替换 evaluatePackage）', () => {
  let dataSource: DataSource;
  let service: RecordPackageImportService;
  let receiptService: BusinessSyncReceiptService;
  let checkUsecase: CheckRecordPackageUsecase;
  let importUsecase: ImportRecordPackageUsecase;
  let installationId: string;
  let fileRoot: OwnedFileRoot;
  const createdFilePaths: string[] = [];
  const owned = createOwnedResourceLedger();
  /** writer/来源事实替身：只模拟权威版本的只读事实，不写业务表。 */
  const sourceFacts = new Map<
    string,
    { withdrawn: boolean; currentVersion: number | null; identityPersisted: boolean }
  >();
  let sourceIdentityDenialReason: string | null = null;

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
      throw new Error('隔离库缺少本机安装身份');
    }
    fileRoot = createOwnedFileRoot(FILE_ROOT_BASE, 'task09-chain-');

    const transactionRunner = {
      run: <T>(fn: (context: unknown) => Promise<T>): Promise<T> =>
        dataSource.transaction(async (manager) =>
          fn(createTypeOrmPersistenceTransactionContext(manager)),
        ),
    } as TransactionRunner;
    const scopeResolver = {
      resolve: () => Promise.resolve({ organizationId: ORGANIZATION_ID, role: 'ENGINEER' }),
    } as never;
    const organizationQueryService = {
      findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'CLIENT_DEFAULT' }),
    } as never;
    checkUsecase = new CheckRecordPackageUsecase(
      scopeResolver,
      service,
      organizationQueryService,
      transactionRunner,
    );
    const writer = {
      supportedResourceTypes: [RESOURCE_TYPE],
      verifySourceIdentity: () =>
        Promise.resolve(
          sourceIdentityDenialReason === null
            ? { allowed: true, sourceAccountId: ACTOR_ACCOUNT_ID }
            : { allowed: false, reason: sourceIdentityDenialReason },
        ),
      write: () => Promise.resolve({ status: 'CREATED', localRecordId: 1, reason: null }),
    };
    importUsecase = new ImportRecordPackageUsecase(
      scopeResolver,
      service,
      organizationQueryService,
      receiptService,
      { stage: () => Promise.resolve([]), release: () => Promise.resolve(0) } as never,
      {
        listFacts: (input: { recordUuids: string[] }) =>
          Promise.resolve({
            facts: new Map(
              input.recordUuids.flatMap((recordUuid) => {
                const fact = sourceFacts.get(recordUuid);
                return fact === undefined
                  ? []
                  : [
                      [
                        recordUuid,
                        {
                          resourceType: RESOURCE_TYPE,
                          recordUuid,
                          recordId: 1,
                          ownerOrganizationId: ORGANIZATION_ID,
                          currentVersion: fact.currentVersion,
                          versionTrusted: true,
                          materialApplicable: true,
                          relatedAccountIds: [ACTOR_ACCOUNT_ID],
                          authorizationSubjectAccountId: ACTOR_ACCOUNT_ID,
                          withdrawn: fact.withdrawn,
                          identityPersisted: fact.identityPersisted,
                          contentState: { withdrawn: false, frozen: false, closed: false },
                        },
                      ] as const,
                    ];
              }),
            ),
            scanComplete: true,
          }),
      } as never,
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
        helper: '记录包链反例 afterAll 精确回收',
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

  /** 真实包目录：manifest.json + 原件字节文件（SHA-256 与字节数一致）。 */
  const createPackage = async (
    name: string,
    items: ChainItem[],
  ): Promise<{ packagePath: string; packageId: string; checksum: string }> => {
    const packagePath = join(fileRoot.root, name);
    mkdirSync(packagePath);
    createdFilePaths.push(packagePath);
    const packageId = randomUUID();
    const manifestItems = items.map((item) => {
      const bytes = item.bytes ?? Buffer.from(`payload-${item.recordUuid}`, 'utf8');
      const relativePath = `${item.recordUuid}.bin`;
      writeFileSync(join(packagePath, relativePath), bytes);
      createdFilePaths.push(join(packagePath, relativePath));
      return {
        record_uuid: item.recordUuid,
        resource_type: item.resourceType ?? RESOURCE_TYPE,
        version_no: item.versionNo ?? 1,
        content_snapshot: { schema_version: 1, payload: { title: item.recordUuid } },
        files: [
          {
            relative_path: relativePath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            byte_size: bytes.length,
          },
        ],
        source_account_id: ACTOR_ACCOUNT_ID,
        owner_organization_id: ORGANIZATION_ID,
      };
    });
    const manifest = {
      schema_version: 1,
      package_id: packageId,
      organization_id: ORGANIZATION_ID,
      organization_code: 'CLIENT_DEFAULT',
      installation_id: installationId,
      generated_at: '2026-11-25T00:00:00.000Z',
      items: manifestItems,
    };
    const manifestPath = join(packagePath, 'manifest.json');
    const raw = JSON.stringify(manifest);
    writeFileSync(manifestPath, raw, 'utf8');
    createdFilePaths.push(manifestPath);
    const evaluation = await service.evaluatePackage({
      packagePath,
      organizationId: ORGANIZATION_ID,
      organizationCode: 'CLIENT_DEFAULT',
      importedByAccountId: ACTOR_ACCOUNT_ID,
    });
    return { packagePath, packageId, checksum: evaluation.manifestChecksum };
  };

  const registerBatch = async (packageId: string, checksum: string): Promise<void> => {
    recordOwnedResource(owned, 'recordPackageImport', packageId, {
      organizationId: ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: checksum,
    });
    const rows = await dataSource.query(
      'SELECT * FROM `record_package_item` WHERE `package_id` = ?',
      [packageId],
    );
    for (const row of rows) {
      recordOwnedResource(owned, 'recordPackageItem', Number(row.id), {
        packageId,
        recordUuid: String(row.record_uuid),
        resourceType: String(row.resource_type),
        versionNo: Number(row.version_no),
        receiptId:
          row.receipt_id === null || row.receipt_id === undefined
            ? null
            : String(row.receipt_id as string),
      });
    }
  };

  const writeReceipt = async (item: ChainItem, checksum: string): Promise<string> => {
    const receiptId = await dataSource.transaction(async (manager) =>
      receiptService.recordImportedVersion(
        {
          organizationId: ORGANIZATION_ID,
          resourceType: item.resourceType ?? RESOURCE_TYPE,
          recordUuid: item.recordUuid,
          versionNo: item.versionNo ?? 1,
          manifestChecksum: checksum,
          sourceInstallationId: installationId,
        },
        createTypeOrmPersistenceTransactionContext(manager),
      ),
    );
    recordOwnedResource(owned, 'syncReceipt', receiptId, {
      organizationId: ORGANIZATION_ID,
      recordUuid: item.recordUuid,
      resourceType: item.resourceType ?? RESOURCE_TYPE,
      versionNo: item.versionNo ?? 1,
      sourceSystem: 'LOCAL',
    });
    return receiptId;
  };

  const setLocalFact = (
    item: ChainItem,
    fact: { withdrawn: boolean; currentVersion: number | null; identityPersisted: boolean },
  ): void => {
    sourceFacts.set(item.recordUuid, fact);
  };

  /** 把导入期新写回执登记到清理台账，并同步条目的回执预期。 */
  const registerImportReceiptsForFreshItems = async (
    packageId: string,
    freshItems: ChainItem[],
  ): Promise<void> => {
    const rows = await dataSource.query(
      'SELECT id, record_uuid, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [packageId],
    );
    for (const row of rows) {
      if (
        freshItems.some((item) => item.recordUuid === row.record_uuid) &&
        row.receipt_id !== null &&
        row.receipt_id !== undefined
      ) {
        recordOwnedResource(owned, 'syncReceipt', String(row.receipt_id), {
          organizationId: ORGANIZATION_ID,
          recordUuid: String(row.record_uuid),
          resourceType: RESOURCE_TYPE,
          versionNo: 1,
          sourceSystem: 'LOCAL',
        });
      }
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
        receiptId:
          row.receipt_id === null || row.receipt_id === undefined ? null : String(row.receipt_id),
      });
    }
  };

  it('P3｜包内同键重复：正式检查整包 INVALID_MANIFEST，零检查/回执/业务副作用', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('duplicate-manifest', [item]);
    const manifestPath = join(pkg.packagePath, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      items: Record<string, unknown>[];
    };
    raw.items = [raw.items[0], { ...raw.items[0] }];
    writeFileSync(manifestPath, JSON.stringify(raw), 'utf8');

    const countsBefore = await dataSource.query(
      'SELECT (SELECT COUNT(*) FROM `record_package_import` WHERE `package_id` = ?) AS batches, (SELECT COUNT(*) FROM `record_package_item` WHERE `package_id` = ?) AS items, (SELECT COUNT(*) FROM `sync_receipt` WHERE `record_uuid` = ?) AS receipts',
      [pkg.packageId, pkg.packageId, item.recordUuid],
    );

    await expect(
      checkUsecase.execute({ session, packagePath: pkg.packagePath }),
    ).rejects.toMatchObject({
      code: RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      message: expect.stringContaining('重复条目'),
    });

    const countsAfter = await dataSource.query(
      'SELECT (SELECT COUNT(*) FROM `record_package_import` WHERE `package_id` = ?) AS batches, (SELECT COUNT(*) FROM `record_package_item` WHERE `package_id` = ?) AS items, (SELECT COUNT(*) FROM `sync_receipt` WHERE `record_uuid` = ?) AS receipts',
      [pkg.packageId, pkg.packageId, item.recordUuid],
    );
    expect(countsAfter).toEqual(countsBefore);
    expect(Number(countsAfter[0]?.batches ?? 0)).toBe(0);
    expect(Number(countsAfter[0]?.items ?? 0)).toBe(0);
    expect(Number(countsAfter[0]?.receipts ?? 0)).toBe(0);
  });

  it('P3｜同 UUID 不同资源/版本按完整键受控检查', async () => {
    const recordUuid = randomUUID();
    const pkg = await createPackage('same-uuid-different-keys', [
      { recordUuid, resourceType: RESOURCE_TYPE, versionNo: 1 },
      { recordUuid, resourceType: 'MAINTENANCE_REPORT', versionNo: 1 },
      { recordUuid, resourceType: RESOURCE_TYPE, versionNo: 2 },
    ]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    expect(checked.items.map((item) => item.checkResult)).toEqual(['PASSED', 'PASSED', 'PASSED']);
    expect(checked.items.map((item) => `${item.resourceType}:${item.versionNo}`)).toEqual([
      `${RESOURCE_TYPE}:1`,
      'MAINTENANCE_REPORT:1',
      `${RESOURCE_TYPE}:2`,
    ]);
  });

  it('P3｜当前权限撤销：逐条 FAILED 且不写业务回执', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('permission-revoked', [item]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');

    sourceIdentityDenialReason = '当前权限已撤销';
    let result: Awaited<ReturnType<ImportRecordPackageUsecase['execute']>>;
    try {
      result = await importUsecase.execute({
        session,
        packageId: pkg.packageId,
        packagePath: pkg.packagePath,
        manifestChecksum: pkg.checksum,
      });
    } finally {
      sourceIdentityDenialReason = null;
    }
    expect(result.items[0]?.result).toBe('FAILED');
    expect(result.items[0]?.errorMessage).toBe('当前权限已撤销');
    expect(result.import.status).toBe('FAILED');
    const receipts = await dataSource.query(
      'SELECT COUNT(*) AS n FROM `sync_receipt` WHERE `record_uuid` = ? AND `version_no` = ?',
      [item.recordUuid, 1],
    );
    expect(Number(receipts[0]?.n ?? 0)).toBe(0);
  });

  it('F1 全重复包：正式检查通过但逐条标重复，确认导入按同包事实跳过', async () => {
    const existing: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('all-duplicate', [existing]);
    await writeReceipt(existing, pkg.checksum);
    setLocalFact(existing, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const checked = await checkUsecase.execute({
      session,
      packagePath: pkg.packagePath,
    });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    expect(checked.items[0]?.checkResult).toBe('PASSED');
    expect(checked.items[0]?.errorMessage).toContain('同步回执');

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items[0]?.result).toBe('SKIPPED');
    expect(result.import.status).toBe('SUCCEEDED');
    const rows = await dataSource.query(
      'SELECT id, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    for (const row of rows) {
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
        receiptId: row.receipt_id === null ? null : String(row.receipt_id),
      });
    }
  });

  it('F1 混合包（1 重复 + 1 新）：合格范围可执行，重复跳过且新条目写入', async () => {
    const duplicate: ChainItem = { recordUuid: randomUUID() };
    const fresh: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('mixed-duplicate-and-new', [duplicate, fresh]);
    await writeReceipt(duplicate, pkg.checksum);
    setLocalFact(duplicate, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    expect(checked.items.map((item) => item.checkResult)).toEqual(['PASSED', 'PASSED']);
    expect(checked.items[0]?.errorMessage).toContain('同步回执');

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items.map((item) => item.result)).toEqual(['SKIPPED', 'SUCCEEDED']);
    expect(result.import.status).toBe('SUCCEEDED');
    const rows = await dataSource.query(
      'SELECT id, record_uuid, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    for (const row of rows) {
      if (row.record_uuid === fresh.recordUuid && row.receipt_id !== null) {
        recordOwnedResource(owned, 'syncReceipt', String(row.receipt_id), {
          organizationId: ORGANIZATION_ID,
          recordUuid: fresh.recordUuid,
          resourceType: RESOURCE_TYPE,
          versionNo: 1,
          sourceSystem: 'LOCAL',
        });
      }
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
        receiptId: row.receipt_id === null ? null : String(row.receipt_id),
      });
    }
  });

  it('全新包：正式检查 PASSED 后正式导入成功（writer 替身，明确范围）', async () => {
    const fresh: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('all-new', [fresh]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items[0]?.result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('SUCCEEDED');
    const rows = await dataSource.query(
      'SELECT * FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    recordOwnedResource(owned, 'syncReceipt', String(rows[0]?.receipt_id), {
      organizationId: ORGANIZATION_ID,
      recordUuid: fresh.recordUuid,
      resourceType: RESOURCE_TYPE,
      versionNo: 1,
      sourceSystem: 'LOCAL',
    });
    for (const row of rows) {
      if (row.receipt_id !== null && row.receipt_id !== undefined) {
        // 逐条结果由正式导入写入，台账预期同步到新回执 ID。
        updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
          receiptId: String(row.receipt_id as string),
        });
      }
    }
  });

  it('F2 回执晚到：检查通过后回执才写入，导入按同包权威事实跳过', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('receipt-after-check', [item]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    expect(checked.items[0]?.result).toBeNull();

    await writeReceipt(item, pkg.checksum);
    setLocalFact(item, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items[0]?.result).toBe('SKIPPED');
    expect(result.import.status).toBe('SUCCEEDED');
    const rows = await dataSource.query(
      'SELECT id, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    for (const row of rows) {
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
        receiptId: row.receipt_id === null ? null : String(row.receipt_id),
      });
    }
  });

  it('F1 混合硬阻断包：非法条目未执行，合格新条目成功，批次 PARTIAL', async () => {
    const blocked: ChainItem = { recordUuid: randomUUID() };
    const fresh: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('mixed-blocked-and-new', [blocked, fresh]);
    writeFileSync(
      join(pkg.packagePath, `${blocked.recordUuid}.bin`),
      Buffer.from('tampered-payload'),
    );
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    expect(checked.items.map((item) => item.checkResult)).toEqual(['REJECTED', 'PASSED']);

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items.map((item) => item.result)).toEqual([null, 'SUCCEEDED']);
    expect(result.import.status).toBe('PARTIAL');
    const rows = await dataSource.query(
      'SELECT id, record_uuid, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    for (const row of rows) {
      if (row.record_uuid === fresh.recordUuid && row.receipt_id !== null) {
        recordOwnedResource(owned, 'syncReceipt', String(row.receipt_id), {
          organizationId: ORGANIZATION_ID,
          recordUuid: fresh.recordUuid,
          resourceType: RESOURCE_TYPE,
          versionNo: 1,
          sourceSystem: 'LOCAL',
        });
      }
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), {
        receiptId: row.receipt_id === null ? null : String(row.receipt_id),
      });
    }
  });

  it('P2-02｜确认期同长度篡改原件：已有回执条目标检查未通过，其他条目成功', async () => {
    const duplicate: ChainItem = { recordUuid: randomUUID() };
    const fresh: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('fresh-check-tampered', [duplicate, fresh]);
    await writeReceipt(duplicate, pkg.checksum);
    setLocalFact(duplicate, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');

    const originalLength = Buffer.byteLength(`payload-${duplicate.recordUuid}`, 'utf8');
    writeFileSync(
      join(pkg.packagePath, `${duplicate.recordUuid}.bin`),
      Buffer.alloc(originalLength, 0x61),
    );
    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items.map((item) => item.result)).toEqual([null, 'SUCCEEDED']);
    expect(result.items[0]?.checkResult).toBe('REJECTED');
    expect(result.items[0]?.errorMessage).toContain('SHA-256');
    expect(result.import.status).toBe('PARTIAL');
    await registerImportReceiptsForFreshItems(pkg.packageId, [fresh]);
  });

  it('P2-02｜确认期删除原件：无回执同版本条目不补回执，其他条目成功', async () => {
    const sameVersion: ChainItem = { recordUuid: randomUUID() };
    const fresh: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('fresh-check-missing', [sameVersion, fresh]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    setLocalFact(sameVersion, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    unlinkSync(join(pkg.packagePath, `${sameVersion.recordUuid}.bin`));

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    expect(result.items.map((item) => item.result)).toEqual([null, 'SUCCEEDED']);
    expect(result.items[0]?.checkResult).toBe('REJECTED');
    expect(result.items[0]?.errorMessage).toContain('缺少');
    expect(result.import.status).toBe('PARTIAL');
    const receipts = await dataSource.query(
      'SELECT COUNT(*) AS n FROM `sync_receipt` WHERE `record_uuid` = ? AND `version_no` = ?',
      [sameVersion.recordUuid, 1],
    );
    expect(Number(receipts[0]?.n ?? 0)).toBe(0);
    await registerImportReceiptsForFreshItems(pkg.packageId, [fresh]);
  });

  it('非法原件（字节数不符）：正式检查硬阻断 REJECTED，不进入导入', async () => {
    // 清单不动（摘要与批次绑定不变），只篡改已登记原件字节 ⇒ 检查阶段必须硬阻断。
    const broken: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('broken-file', [broken]);
    writeFileSync(
      join(pkg.packagePath, `${broken.recordUuid}.bin`),
      Buffer.from('tampered-payload'),
    );
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('REJECTED');
    expect(checked.items[0]?.errorMessage).toContain('字节数不符');
  });
});
