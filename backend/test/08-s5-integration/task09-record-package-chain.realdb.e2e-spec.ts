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
 *   TASK09_RECORD_PACKAGE_CHAIN=1 E2E_ALLOWED_DB_NAMES=<一次性库> E2E_REAL_DB_NAME=<一次性库> \
 *     E2E_ALLOW_PHYSICAL_CLEANUP=1 TASK09_RECORD_PACKAGE_ENV_FILE=<专用 env> \
 *     TASK09_RECORD_PACKAGE_DISPOSABLE_DB=1 \
 *     TASK09_RECORD_PACKAGE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *     TASK09_RECORD_PACKAGE_FILE_ROOT=<专用文件根父目录> \
 *     npx jest --testPathIgnorePatterns "/node_modules/" "/dist/" \
 *     --runTestsByPath test/08-s5-integration/task09-record-package-chain.realdb.e2e-spec.ts --runInBand
 *
 * DDL 前置：显式启用、专用 env 文件、一次性库名、可丢弃声明、服务器 UUID、库白名单与物理清理许可
 * 全部通过后才会创建本轮唯一探针对象；名称由 `TASK09_RECORD_PACKAGE_PROBE_RUN_ID`（可选）或随机数派生，
 * 绝不先 DROP 固定名称的同名对象。本轮对象按创建登记精确收尾，DDL 隐式提交不声称跨资源原子。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';
import { RECORD_PACKAGE_ERROR } from '@core/common/errors';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import {
  createTypeOrmPersistenceTransactionContext,
  getTypeOrmEntityManager,
} from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';
import { SyncConflictEntity } from '@src/modules/lithography/entities/sync-conflict.entity';
import { RecordPackageImportEntity } from '@src/modules/lithography/entities/record-package-import.entity';
import { RecordPackageItemEntity } from '@src/modules/lithography/entities/record-package-item.entity';
import { SyncReceiptEntity } from '@src/modules/lithography/entities/sync-receipt.entity';
import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import { CheckRecordPackageUsecase } from '@src/usecases/local-runtime/check-record-package.usecase';
import { ImportRecordPackageUsecase } from '@src/usecases/local-runtime/import-record-package.usecase';

import type { TransactionRunner } from '@usecases/common/ports/transaction-runner.contract';

import {
  createOwnedTrigger,
  createTriggerOwnershipTracker,
  disposeOwnedTriggerRecord,
} from '../utils/e2e-trigger-ownership';
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
import {
  assertChainProbePreflight,
  assertChainProbeTarget,
  buildAlteredProbeTableSql,
  buildExternalProbeTriggerBody,
  buildReceiptProbeTriggerBody,
  createOwnedReceiptProbeTable,
  createReceiptProbeTableTracker,
  disposeOwnedReceiptProbeTable,
  INJECT_PROBE_TABLE_DISPOSAL_FAILURE_ENV,
  INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE_ENV,
  readReceiptProbeRows,
  type ChainProbeRunScope,
  type OwnedReceiptProbeTableFact,
} from '../utils/task09-record-package-probe-safety';

jest.setTimeout(120_000);

const ENABLED = process.env.TASK09_RECORD_PACKAGE_CHAIN === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
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

type FullItemIdentity = {
  resourceType: string;
  recordUuid: string;
  versionNo: number;
};

/** 逐条结果不承诺显示顺序：所有断言按完整业务身份取项，不按下标。 */
function identityOf(item: FullItemIdentity): string {
  return `${item.resourceType}\u0000${item.recordUuid}\u0000${item.versionNo}`;
}

function expectedItem(item: ChainItem): FullItemIdentity {
  return {
    resourceType: item.resourceType ?? RESOURCE_TYPE,
    recordUuid: item.recordUuid,
    versionNo: item.versionNo ?? 1,
  };
}

function assertFullIdentitySet(actual: FullItemIdentity[], expected: FullItemIdentity[]): void {
  expect(actual).toHaveLength(expected.length);
  const actualKeys = actual.map(identityOf);
  expect(new Set(actualKeys).size).toBe(expected.length);
  for (const item of expected) {
    expect(actualKeys).toContain(identityOf(item));
  }
}

function itemFor<T extends FullItemIdentity>(actual: T[], expected: FullItemIdentity): T {
  const matches = actual.filter((item) => identityOf(item) === identityOf(expected));
  expect(matches).toHaveLength(1);
  return matches[0];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function connectionIdText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

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
  /**
   * 本轮创建候选：只记录回执服务调用所在数据库连接的真实插入事件证据。
   * 最终登记前还会从独立连接回读探针，确认事务已提交；复用/未知一律不认领。
   */
  const candidateCreatedReceipts = new Map<string, number>();
  /** 并发竞态测试用屏障：在正式 writer 身份核验（早于回执查询）前暂停。 */
  let pauseBeforeWriterIdentity: (() => Promise<void>) | null = null;
  /** writer/来源事实替身：只模拟权威版本的只读事实，不写业务表。 */
  const sourceFacts = new Map<
    string,
    { withdrawn: boolean; currentVersion: number | null; identityPersisted: boolean }
  >();
  let sourceIdentityDenialReason: string | null = null;
  /** 可控冻结闸门：占用前冻结由真实 assertCompanyWritable 入口返回。 */
  let writeHoldFailure: Error | null = null;
  /** 可控 writer 故障：构造"首项已提交、次项失败/冻结"的真实交错。 */
  let writerFailure: { at: number; error: Error } | null = null;
  let writerPause: { at: number; ready: () => void; wait: () => Promise<void> } | null = null;
  let writerCallCount = 0;
  let probeScope: ChainProbeRunScope | null = null;
  let probeTableFact: OwnedReceiptProbeTableFact | null = null;
  const probeTableTracker = createReceiptProbeTableTracker();
  const probeTriggerTracker = createTriggerOwnershipTracker();
  const faultTriggerTracker = createTriggerOwnershipTracker();
  let faultTriggerCount = 0;

  beforeAll(async () => {
    const scope = assertChainProbePreflight();
    probeScope = scope;
    const config = loadExplicitEnvConfig(scope.envFile, scope.database);
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
    await assertChainProbeTarget(dataSource, scope);

    // 测试专用插入探针：本轮唯一名称 + 创建前同名预检 + 创建后立即登记。
    // 生产回执服务的契约不变；探针随事务一起提交/回滚，DDL 隐式提交不声称跨资源原子。
    probeTableFact = await createOwnedReceiptProbeTable({
      dataSource,
      scope,
      tracker: probeTableTracker,
    });
    await createOwnedTrigger({
      dataSource,
      name: scope.probeTrigger,
      tableName: 'sync_receipt',
      body: buildReceiptProbeTriggerBody(probeTableFact.tableName),
      timing: 'AFTER',
      event: 'INSERT',
      tracker: probeTriggerTracker,
    });

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
    // 真实回执服务的薄记录包装：只记录本次调用所在连接上的实际 INSERT 事件。
    // 唯一键败方复用并发赢家时本连接没有 INSERT 事件，绝不把赢家 ID 当本轮创建。
    const trackedReceiptService = {
      recordImportedVersion: async (
        input: {
          organizationId: number;
          resourceType: string;
          recordUuid: string;
          versionNo: number;
          manifestChecksum: string;
          sourceInstallationId: string;
        },
        transactionContext?: PersistenceTransactionContext,
      ) => {
        const manager = getTypeOrmEntityManager(
          transactionContext as PersistenceTransactionContext,
        );
        const connectionRows: unknown = await manager.query(
          'SELECT CONNECTION_ID() AS connection_id',
        );
        const connectionRow = Array.isArray(connectionRows)
          ? (connectionRows[0] as { connection_id?: unknown } | undefined)
          : undefined;
        const connectionId = connectionIdText(connectionRow?.connection_id);
        const receiptId = await receiptService.recordImportedVersion(
          input,
          transactionContext as PersistenceTransactionContext,
        );
        if (probeTableFact === null) {
          throw new Error('记录包链探针表尚未在本轮创建，拒绝登记回执创建证据');
        }
        const probeRows = await readReceiptProbeRows(
          manager,
          probeTableFact.tableName,
          receiptId,
          connectionId,
        );
        if (probeRows.length > 0) {
          candidateCreatedReceipts.set(receiptId, Number(connectionId));
        }
        return receiptId;
      },
    } as unknown as BusinessSyncReceiptService;
    const writer = {
      supportedResourceTypes: [RESOURCE_TYPE],
      verifySourceIdentity: async () => {
        if (pauseBeforeWriterIdentity !== null) {
          await pauseBeforeWriterIdentity();
        }
        return sourceIdentityDenialReason === null
          ? { allowed: true, sourceAccountId: ACTOR_ACCOUNT_ID }
          : { allowed: false, reason: sourceIdentityDenialReason };
      },
      write: async () => {
        writerCallCount += 1;
        if (writerPause !== null && writerCallCount === writerPause.at) {
          writerPause.ready();
          await writerPause.wait();
        }
        if (writerFailure !== null && writerCallCount === writerFailure.at) {
          throw writerFailure.error;
        }
        return { status: 'CREATED', localRecordId: 1, reason: null };
      },
    };
    importUsecase = new ImportRecordPackageUsecase(
      scopeResolver,
      service,
      organizationQueryService,
      trackedReceiptService,
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
      {
        assertCompanyWritable: () =>
          writeHoldFailure === null ? Promise.resolve(undefined) : Promise.reject(writeHoldFailure),
      } as never,
      { get: () => writer } as never,
      transactionRunner,
    );
  });

  beforeEach(() => {
    writeHoldFailure = null;
    writerFailure = null;
    writerPause = null;
    writerCallCount = 0;
    candidateCreatedReceipts.clear();
    pauseBeforeWriterIdentity = null;
  });

  afterAll(async () => {
    const errors: Array<{ stage: string; error: unknown }> = [];
    const connected = dataSource?.isInitialized === true;
    const rootLabel = fileRoot?.root ?? '(未创建)';

    // 仅测试注入：模拟外部替换/同列异型，驱动真实 afterAll 的依赖保留分支。
    if (connected && process.env[INJECT_PROBE_TRIGGER_DISPOSAL_FAILURE_ENV] === '1') {
      const record = probeTriggerTracker.remaining()[0];
      const probeTable = probeTableTracker.remaining()[0];
      if (record !== undefined && probeTable !== undefined) {
        try {
          await dataSource.query(`DROP TRIGGER IF EXISTS \`${record.name}\``);
          await dataSource.query(
            `CREATE TRIGGER \`${record.name}\` AFTER INSERT ON \`${record.tableName}\` ` +
              `FOR EACH ROW ${buildExternalProbeTriggerBody(probeTable.tableName)}`,
          );
        } catch (error) {
          errors.push({ stage: '注入触发器替换失败', error });
        }
      }
    }
    if (connected && process.env[INJECT_PROBE_TABLE_DISPOSAL_FAILURE_ENV] === '1') {
      const record = probeTableTracker.remaining()[0];
      if (record !== undefined) {
        try {
          await dataSource.query(buildAlteredProbeTableSql(record.tableName));
        } catch (error) {
          errors.push({ stage: '注入表定义替换失败', error });
        }
      }
    }

    // 依赖顺序：插入 trigger 未确认安全删除 ⇒ 不删其引用的 probe table；
    // 任一 DDL 对象未决 ⇒ 数据库业务行与文件现场全部保留并报告。
    let probeTriggerDisposalOk = true;
    for (const record of [...probeTriggerTracker.remaining()]) {
      try {
        await disposeOwnedTriggerRecord(dataSource, record, probeTriggerTracker);
      } catch (error) {
        probeTriggerDisposalOk = false;
        errors.push({ stage: `插入探针触发器收尾 ${record.name}`, error });
      }
    }
    if (probeTriggerDisposalOk && probeTriggerTracker.remaining().length > 0) {
      probeTriggerDisposalOk = false;
      errors.push({
        stage: '插入探针触发器依赖诊断',
        error: new Error('仍有未收尾的插入触发器，拒绝删除其依赖的探针表'),
      });
    }

    let probeTableDisposalOk = true;
    if (probeTriggerDisposalOk) {
      for (const record of [...probeTableTracker.remaining()]) {
        const fact = record.fact ?? {
          tableName: record.tableName,
          runId: record.runId,
          database: record.database,
          serverUuid: record.serverUuid,
          columns: [...record.expectedColumns],
          definition: record.expectedDefinition,
        };
        try {
          await disposeOwnedReceiptProbeTable({ dataSource, fact, tracker: probeTableTracker });
        } catch (error) {
          probeTableDisposalOk = false;
          errors.push({ stage: `插入探针表收尾 ${record.tableName}`, error });
        }
      }
      if (probeTableDisposalOk && probeTableTracker.remaining().length > 0) {
        probeTableDisposalOk = false;
        errors.push({
          stage: '插入探针表依赖诊断',
          error: new Error('仍有未收尾的探针表，拒绝继续业务行/文件清理'),
        });
      }
    }

    let faultTriggerDisposalOk = true;
    for (const record of [...faultTriggerTracker.remaining()]) {
      try {
        await disposeOwnedTriggerRecord(dataSource, record, faultTriggerTracker);
      } catch (error) {
        faultTriggerDisposalOk = false;
        errors.push({ stage: `故障注入触发器收尾 ${record.name}`, error });
      }
    }
    if (faultTriggerDisposalOk && faultTriggerTracker.remaining().length > 0) {
      faultTriggerDisposalOk = false;
      errors.push({
        stage: '故障注入触发器依赖诊断',
        error: new Error('仍有未收尾的批次删除故障触发器，拒绝继续业务行/文件清理'),
      });
    }

    const dependentSceneSafe =
      connected && probeTriggerDisposalOk && probeTableDisposalOk && faultTriggerDisposalOk;
    if (!dependentSceneSafe) {
      errors.push({
        stage: '现场保留诊断',
        error: new Error(
          '探针/故障触发器或表未完成安全收尾，保留数据库业务行与唯一文件根 ' + rootLabel,
        ),
      });
    } else {
      try {
        await runGuardedSpecCleanup({
          dataSource,
          owned,
          helper: '记录包链反例 afterAll 精确回收',
          expectedDatabase: probeScope?.database ?? 'lithography_task09_test_e2e',
        });
        try {
          cleanupOwnedFileRoot(fileRoot, createdFilePaths);
        } catch (error) {
          errors.push({ stage: '文件清理', error });
        }
      } catch (error) {
        errors.push({ stage: '数据库清理', error });
        errors.push({
          stage: '文件保留诊断',
          error: new Error(`数据库清理未明确成功，保留唯一文件根=${rootLabel}`),
        });
      }
    }
    try {
      if (connected) await dataSource.destroy();
    } catch (error) {
      errors.push({ stage: '连接关闭', error });
    }
    if (errors.length > 0) {
      throw new Error(
        `本轮收尾失败（唯一文件根=${rootLabel}）：` +
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

  const writeReceipt = async (
    item: ChainItem,
    checksum: string,
    registerOwner = true,
  ): Promise<string> => {
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
    if (registerOwner) {
      recordOwnedResource(owned, 'syncReceipt', receiptId, {
        organizationId: ORGANIZATION_ID,
        recordUuid: item.recordUuid,
        resourceType: item.resourceType ?? RESOURCE_TYPE,
        versionNo: item.versionNo ?? 1,
        sourceSystem: 'LOCAL',
      });
    }
    return receiptId;
  };

  const setLocalFact = (
    item: ChainItem,
    fact: { withdrawn: boolean; currentVersion: number | null; identityPersisted: boolean },
  ): void => {
    sourceFacts.set(item.recordUuid, fact);
  };

  /**
   * 把导入期新写回执和条目结果同步进台账；调用点紧跟正式导入，先于任何断言。
   * 只登记摘要与本次包一致、身份在预期集合内的回执；其它同键回执不认领。
   */
  const registerImportSideEffects = async (
    packageId: string,
    expectedItems: ChainItem[],
    manifestChecksum: string,
    knownForeignReceiptIds: readonly string[] = [],
  ): Promise<void> => {
    const expected = expectedItems.map(expectedItem);
    const rows = await dataSource.query(
      'SELECT id, record_uuid, resource_type, version_no, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [packageId],
    );
    for (const row of rows) {
      const identity: FullItemIdentity = {
        resourceType: String(row.resource_type),
        recordUuid: String(row.record_uuid),
        versionNo: Number(row.version_no),
      };
      const matched = expected.find((item) => identityOf(item) === identityOf(identity));
      if (matched === undefined) {
        throw new Error(`导入副作用登记遇到未预期条目：${identityOf(identity)}`);
      }
      const receiptId =
        row.receipt_id === null || row.receipt_id === undefined ? null : String(row.receipt_id);
      if (receiptId !== null) {
        const receipts = await dataSource.query(
          'SELECT receipt_id, organization_id, resource_type, record_uuid, version_no, manifest_checksum FROM `sync_receipt` WHERE `receipt_id` = ?',
          [receiptId],
        );
        const receipt = receipts[0] as Record<string, unknown> | undefined;
        const candidateConnectionId = candidateCreatedReceipts.get(receiptId);
        const committedProbe =
          candidateConnectionId === undefined || probeTableFact === null
            ? []
            : await readReceiptProbeRows(
                dataSource,
                probeTableFact.tableName,
                receiptId,
                String(candidateConnectionId),
              );
        if (
          committedProbe.length > 0 &&
          receipt !== undefined &&
          String(receipt.manifest_checksum) === manifestChecksum &&
          Number(receipt.organization_id) === ORGANIZATION_ID &&
          String(receipt.resource_type) === matched.resourceType &&
          String(receipt.record_uuid) === matched.recordUuid &&
          Number(receipt.version_no) === matched.versionNo
        ) {
          recordOwnedResource(owned, 'syncReceipt', receiptId, {
            organizationId: ORGANIZATION_ID,
            resourceType: matched.resourceType,
            recordUuid: matched.recordUuid,
            versionNo: matched.versionNo,
            sourceSystem: 'LOCAL',
          });
        } else if (
          !owned.facts.syncReceipt.has(receiptId) &&
          !knownForeignReceiptIds.includes(receiptId)
        ) {
          throw new Error(
            `导入副作用登记拒绝认领未知回执：${receiptId}，身份=${identityOf(matched)}`,
          );
        }
      }
      updateOwnedExpectation(owned, 'recordPackageItem', Number(row.id), { receiptId });
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
    const expected = [
      { resourceType: RESOURCE_TYPE, recordUuid, versionNo: 1 },
      { resourceType: 'MAINTENANCE_REPORT', recordUuid, versionNo: 1 },
      { resourceType: RESOURCE_TYPE, recordUuid, versionNo: 2 },
    ];
    assertFullIdentitySet(checked.items, expected);
    for (const identity of expected) {
      expect(itemFor(checked.items, identity).checkResult).toBe('PASSED');
    }
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
    const revokedItem = itemFor(result.items, expectedItem(item));
    expect(revokedItem.result).toBe('FAILED');
    expect(revokedItem.errorMessage).toBe('当前权限已撤销');
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
    const checkedItem = itemFor(checked.items, expectedItem(existing));
    expect(checkedItem.checkResult).toBe('PASSED');
    expect(checkedItem.errorMessage).toContain('同步回执');

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [existing], pkg.checksum);
    expect(itemFor(result.items, expectedItem(existing)).result).toBe('SKIPPED');
    expect(result.import.status).toBe('SUCCEEDED');
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
    assertFullIdentitySet(checked.items, [expectedItem(duplicate), expectedItem(fresh)]);
    expect(itemFor(checked.items, expectedItem(duplicate)).checkResult).toBe('PASSED');
    expect(itemFor(checked.items, expectedItem(duplicate)).errorMessage).toContain('同步回执');
    expect(itemFor(checked.items, expectedItem(fresh)).checkResult).toBe('PASSED');

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [duplicate, fresh], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(duplicate), expectedItem(fresh)]);
    expect(itemFor(result.items, expectedItem(duplicate)).result).toBe('SKIPPED');
    expect(itemFor(result.items, expectedItem(fresh)).result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('SUCCEEDED');
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
    await registerImportSideEffects(pkg.packageId, [fresh], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(fresh)]);
    expect(itemFor(result.items, expectedItem(fresh)).result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('SUCCEEDED');
    const createdRows = await dataSource.query(
      'SELECT receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    expect(owned.facts.syncReceipt.has(String(createdRows[0]?.receipt_id))).toBe(true);
  });

  it('F2 回执晚到：检查通过后回执才写入，导入按同包权威事实跳过', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('receipt-after-check', [item]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');
    assertFullIdentitySet(checked.items, [expectedItem(item)]);
    expect(itemFor(checked.items, expectedItem(item)).result).toBeNull();

    await writeReceipt(item, pkg.checksum);
    setLocalFact(item, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [item], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(item)]);
    expect(itemFor(result.items, expectedItem(item)).result).toBe('SKIPPED');
    expect(result.import.status).toBe('SUCCEEDED');
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
    assertFullIdentitySet(checked.items, [expectedItem(blocked), expectedItem(fresh)]);
    expect(itemFor(checked.items, expectedItem(blocked)).checkResult).toBe('REJECTED');
    expect(itemFor(checked.items, expectedItem(fresh)).checkResult).toBe('PASSED');

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [blocked, fresh], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(blocked), expectedItem(fresh)]);
    expect(itemFor(result.items, expectedItem(blocked)).result).toBeNull();
    expect(itemFor(result.items, expectedItem(fresh)).result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('PARTIAL');
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
    await registerImportSideEffects(pkg.packageId, [duplicate, fresh], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(duplicate), expectedItem(fresh)]);
    expect(itemFor(result.items, expectedItem(duplicate)).result).toBeNull();
    expect(itemFor(result.items, expectedItem(duplicate)).checkResult).toBe('REJECTED');
    expect(itemFor(result.items, expectedItem(duplicate)).errorMessage).toContain('SHA-256');
    expect(itemFor(result.items, expectedItem(fresh)).result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('PARTIAL');
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
    await registerImportSideEffects(pkg.packageId, [sameVersion, fresh], pkg.checksum);
    assertFullIdentitySet(result.items, [expectedItem(sameVersion), expectedItem(fresh)]);
    expect(itemFor(result.items, expectedItem(sameVersion)).result).toBeNull();
    expect(itemFor(result.items, expectedItem(sameVersion)).checkResult).toBe('REJECTED');
    expect(itemFor(result.items, expectedItem(sameVersion)).errorMessage).toContain('缺少');
    expect(itemFor(result.items, expectedItem(fresh)).result).toBe('SUCCEEDED');
    expect(result.import.status).toBe('PARTIAL');
    const receipts = await dataSource.query(
      'SELECT COUNT(*) AS n FROM `sync_receipt` WHERE `record_uuid` = ? AND `version_no` = ?',
      [sameVersion.recordUuid, 1],
    );
    expect(Number(receipts[0]?.n ?? 0)).toBe(0);
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
    assertFullIdentitySet(checked.items, [expectedItem(broken)]);
    expect(itemFor(checked.items, expectedItem(broken)).checkResult).toBe('REJECTED');
    expect(itemFor(checked.items, expectedItem(broken)).errorMessage).toContain('字节数不符');
  });

  it('占用前冻结：零占用零终态写入，解冻后同包可重试', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('frozen-before-claim', [item]);
    expect(
      (await checkUsecase.execute({ session, packagePath: pkg.packagePath })).import.checkStatus,
    ).toBe('PASSED');
    await registerBatch(pkg.packageId, pkg.checksum);

    writeHoldFailure = new DomainError(SYNC_ERROR.WRITE_HELD, '恢复期冻结');
    let caught: unknown = null;
    try {
      await importUsecase.execute({
        session,
        packageId: pkg.packageId,
        packagePath: pkg.packagePath,
        manifestChecksum: pkg.checksum,
      });
    } catch (error) {
      caught = error;
    } finally {
      writeHoldFailure = null;
    }
    expect(caught).toMatchObject({ code: SYNC_ERROR.WRITE_HELD });
    const beforeRetry = await dataSource.query(
      'SELECT status, check_status FROM `record_package_import` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    expect(beforeRetry[0]).toMatchObject({ status: 'PENDING', check_status: 'PASSED' });

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [item], pkg.checksum);
    expect(result.import.status).toBe('SUCCEEDED');
  });

  it('首项提交后 writer 冻结：保留首项事实，未执行项不伪报，批次 PARTIAL', async () => {
    const first: ChainItem = { recordUuid: randomUUID() };
    const second: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('partial-then-frozen', [first, second]);
    await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);

    writerFailure = {
      at: 2,
      error: new DomainError(SYNC_ERROR.WRITE_HELD, '恢复期冻结'),
    };
    let caught: unknown = null;
    try {
      await importUsecase.execute({
        session,
        packageId: pkg.packageId,
        packagePath: pkg.packagePath,
        manifestChecksum: pkg.checksum,
      });
    } catch (error) {
      caught = error;
    } finally {
      // 中断路径同样立即登记，登记只认领摘要与完整身份匹配的本轮回执。
      await registerImportSideEffects(pkg.packageId, [first, second], pkg.checksum);
      writerFailure = null;
    }

    expect(caught).toMatchObject({ code: SYNC_ERROR.WRITE_HELD });
    const batch = await dataSource.query(
      'SELECT status, item_succeeded, item_failed FROM `record_package_import` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    expect(batch[0]).toMatchObject({ status: 'PARTIAL', item_succeeded: 1, item_failed: 0 });
    const rows = await dataSource.query(
      'SELECT record_uuid, resource_type, version_no, result, receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    const actual: Array<FullItemIdentity & { result: string | null; receiptId: string | null }> =
      rows.map((row: Record<string, unknown>) => ({
        resourceType: String(row.resource_type),
        recordUuid: String(row.record_uuid),
        versionNo: Number(row.version_no),
        result: nullableString(row.result),
        receiptId: nullableString(row.receipt_id),
      }));
    assertFullIdentitySet(actual, [expectedItem(first), expectedItem(second)]);
    expect(itemFor(actual, expectedItem(first))).toMatchObject({
      result: 'SUCCEEDED',
      receiptId: expect.any(String),
    });
    expect(itemFor(actual, expectedItem(second))).toMatchObject({ result: null, receiptId: null });
  });

  it('同一尝试时序：A 占用后 B 并发拒绝，A 冻结收敛后 B 才能成为新尝试', async () => {
    const first: ChainItem = { recordUuid: randomUUID() };
    const second: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('current-attempt-freeze-retry', [first, second]);
    await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);

    let markWriterReady = (): void => {};
    let resumeWriter = (): void => {};
    const writerReady = new Promise<void>((resolve) => {
      markWriterReady = resolve;
    });
    const writerRelease = new Promise<void>((resolve) => {
      resumeWriter = resolve;
    });
    writerPause = { at: 2, ready: markWriterReady, wait: () => writerRelease };
    writerFailure = {
      at: 2,
      error: new DomainError(SYNC_ERROR.WRITE_HELD, '恢复期冻结'),
    };

    const command = {
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    };
    let runA: Promise<Awaited<ReturnType<ImportRecordPackageUsecase['execute']>>>;
    try {
      runA = importUsecase.execute(command);
      await writerReady;
      await expect(importUsecase.execute(command)).rejects.toMatchObject({
        code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
      });
    } finally {
      resumeWriter();
    }
    await expect(runA).rejects.toMatchObject({ code: SYNC_ERROR.WRITE_HELD });

    writerPause = null;
    writerFailure = null;
    const retried = await importUsecase.execute(command);
    await registerImportSideEffects(pkg.packageId, [first, second], pkg.checksum);
    expect(retried.import.status).toBe('SUCCEEDED');
    assertFullIdentitySet(retried.items, [expectedItem(first), expectedItem(second)]);
    expect(itemFor(retried.items, expectedItem(first)).result).toBe('SUCCEEDED');
    expect(itemFor(retried.items, expectedItem(second)).result).toBe('SUCCEEDED');
  });

  it('非冻结写入异常：逐条如实 FAILED，进入常规终态而非冻结收敛', async () => {
    const first: ChainItem = { recordUuid: randomUUID() };
    const second: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('partial-then-controlled-failure', [first, second]);
    await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);

    writerFailure = { at: 2, error: new Error('受控写入失败') };
    let result: Awaited<ReturnType<ImportRecordPackageUsecase['execute']>>;
    try {
      result = await importUsecase.execute({
        session,
        packageId: pkg.packageId,
        packagePath: pkg.packagePath,
        manifestChecksum: pkg.checksum,
      });
    } finally {
      await registerImportSideEffects(pkg.packageId, [first, second], pkg.checksum);
      writerFailure = null;
    }

    expect(result.import.status).toBe('PARTIAL');
    const rows = await dataSource.query(
      'SELECT record_uuid, resource_type, version_no, result, error_message FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    const actual: Array<FullItemIdentity & { result: string | null; errorMessage: string | null }> =
      rows.map((row: Record<string, unknown>) => ({
        resourceType: String(row.resource_type),
        recordUuid: String(row.record_uuid),
        versionNo: Number(row.version_no),
        result: nullableString(row.result),
        errorMessage: nullableString(row.error_message),
      }));
    assertFullIdentitySet(actual, [expectedItem(first), expectedItem(second)]);
    expect(itemFor(actual, expectedItem(first)).result).toBe('SUCCEEDED');
    expect(itemFor(actual, expectedItem(second))).toMatchObject({
      result: 'FAILED',
      errorMessage: expect.stringContaining('受控写入失败'),
    });
  });

  it('归属反例｜同摘要非本轮回执：正式导入只引用不认领，清理导入批次后仍完整存在', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('foreign-same-checksum', [item]);
    const checked = await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    expect(checked.import.checkStatus).toBe('PASSED');

    // 独立夹具：在正式导入**之前**创建同公司、同完整键、同包摘要、同来源安装的回执。
    // 它不是本轮导入创建的，只会被正式链引用（SKIPPED），不得被登记为本轮所有。
    const foreignReceiptId = await writeReceipt(item, pkg.checksum, false);
    setLocalFact(item, { withdrawn: false, currentVersion: 1, identityPersisted: true });
    const before = (
      await dataSource.query('SELECT * FROM `sync_receipt` WHERE `receipt_id` = ?', [
        foreignReceiptId,
      ])
    )[0] as Record<string, unknown> | undefined;
    expect(before).toBeDefined();

    const result = await importUsecase.execute({
      session,
      packageId: pkg.packageId,
      packagePath: pkg.packagePath,
      manifestChecksum: pkg.checksum,
    });
    await registerImportSideEffects(pkg.packageId, [item], pkg.checksum, [foreignReceiptId]);

    expect(candidateCreatedReceipts.has(foreignReceiptId)).toBe(false);
    expect(owned.facts.syncReceipt.has(foreignReceiptId)).toBe(false);
    assertFullIdentitySet(result.items, [expectedItem(item)]);
    expect(itemFor(result.items, expectedItem(item)).result).toBe('SKIPPED');

    const rows = await dataSource.query(
      'SELECT receipt_id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    expect(rows[0]?.receipt_id).toBe(foreignReceiptId);

    // 用例级台账：只包含本轮正式创建的批次/条目；夹具回执明确不在本用例台账内。
    const caseLedger = createOwnedResourceLedger();
    recordOwnedResource(caseLedger, 'recordPackageImport', pkg.packageId, {
      organizationId: ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: pkg.checksum,
    });
    const caseRows = await dataSource.query(
      'SELECT id FROM `record_package_item` WHERE `package_id` = ? AND `record_uuid` = ?',
      [pkg.packageId, item.recordUuid],
    );
    expect(caseRows).toHaveLength(1);
    recordOwnedResource(caseLedger, 'recordPackageItem', Number(caseRows[0]?.id), {
      packageId: pkg.packageId,
      recordUuid: item.recordUuid,
      resourceType: item.resourceType ?? RESOURCE_TYPE,
      versionNo: item.versionNo ?? 1,
      receiptId: foreignReceiptId,
    });

    const snapshotCase = async (): Promise<string> =>
      JSON.stringify({
        batch: await dataSource.query(
          'SELECT * FROM `record_package_import` WHERE `package_id` = ? ORDER BY `package_id`',
          [pkg.packageId],
        ),
        items: await dataSource.query(
          'SELECT * FROM `record_package_item` WHERE `package_id` = ? ORDER BY `id`',
          [pkg.packageId],
        ),
        receipt: await dataSource.query('SELECT * FROM `sync_receipt` WHERE `receipt_id` = ?', [
          foreignReceiptId,
        ]),
      });
    const cleanupCase = (): Promise<void> =>
      runGuardedSpecCleanup({
        dataSource,
        owned: caseLedger,
        helper: '同摘要非本轮回执用例级精确清理',
        expectedDatabase: probeScope?.database ?? 'lithography_task09_test_e2e',
      });

    // 首先注入一个未登记的同包条目：守卫必须在第一条 DELETE 前拒绝，且全量不变。
    const extraUuid = randomUUID();
    const insertedExtra = await dataSource.query(
      `INSERT INTO record_package_item
        (package_id, record_uuid, resource_type, version_no, check_result, result, receipt_id, error_message)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      [pkg.packageId, extraUuid, RESOURCE_TYPE, 1],
    );
    const extraId = Number(insertedExtra.insertId);
    const beforeRejection = await snapshotCase();
    await expect(cleanupCase()).rejects.toThrow(/record_package_item|未登记|拒绝/);
    expect(await snapshotCase()).toBe(beforeRejection);

    // 负向夹具已证明拒绝；此时才按真实 ID/事实登记同一事务清理范围。
    recordOwnedResource(caseLedger, 'recordPackageItem', extraId, {
      packageId: pkg.packageId,
      recordUuid: extraUuid,
      resourceType: RESOURCE_TYPE,
      versionNo: 1,
      receiptId: null,
    });

    // 再注入批次删除失败：条目已删也不能留下半清理，整笔事务必须回滚。
    // 触发器改为本轮唯一名称，并由所有权工具创建/核验后精确收尾。
    if (probeScope === null) throw new Error('本轮探针运行身份缺失，拒绝创建故障注入触发器');
    faultTriggerCount += 1;
    const faultTriggerName = `${probeScope.faultTrigger}_${faultTriggerCount}`;
    await createOwnedTrigger({
      dataSource,
      name: faultTriggerName,
      tableName: 'record_package_import',
      body: "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'task09 cleanup rollback probe'; END",
      tracker: faultTriggerTracker,
    });
    const caseErrors: unknown[] = [];
    try {
      const beforeRollback = await snapshotCase();
      await expect(cleanupCase()).rejects.toThrow(/cleanup rollback probe/);
      expect(await snapshotCase()).toBe(beforeRollback);
    } catch (error) {
      caseErrors.push(error);
    }
    for (const record of [...faultTriggerTracker.remaining()]) {
      try {
        await disposeOwnedTriggerRecord(dataSource, record, faultTriggerTracker);
      } catch (error) {
        caseErrors.push(error);
      }
    }
    if (caseErrors.length > 0) {
      throw new AggregateError(caseErrors, '同摘要回执用例的断言或故障触发器收尾失败');
    }

    await cleanupCase();
    const after = (
      await dataSource.query('SELECT * FROM `sync_receipt` WHERE `receipt_id` = ?', [
        foreignReceiptId,
      ])
    )[0] as Record<string, unknown> | undefined;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const remainingItems = await dataSource.query(
      'SELECT id FROM `record_package_item` WHERE `package_id` = ?',
      [pkg.packageId],
    );
    expect(remainingItems).toHaveLength(0);

    // 夹具本身属于本测试，断言完成后才登记，仅供 afterAll 精确回收；不冒充导入创建。
    recordOwnedResource(owned, 'syncReceipt', foreignReceiptId, {
      organizationId: ORGANIZATION_ID,
      recordUuid: item.recordUuid,
      resourceType: item.resourceType ?? RESOURCE_TYPE,
      versionNo: item.versionNo ?? 1,
      sourceSystem: 'LOCAL',
    });
  });

  it('归属反例｜并发赢家回执：本轮查空后别人才插入，复用 ID 不得认领为本轮创建', async () => {
    const item: ChainItem = { recordUuid: randomUUID() };
    const pkg = await createPackage('concurrent-winner-receipt', [item]);
    await checkUsecase.execute({ session, packagePath: pkg.packagePath });
    await registerBatch(pkg.packageId, pkg.checksum);
    // 不设置本机同版本权威事实：那会按 P1 直接 CONFLICT，无法到达回执复用路径。
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    let markReady = (): void => {};
    let proceed = (): void => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    pauseBeforeWriterIdentity = async () => {
      markReady();
      await release;
    };

    let result: Awaited<ReturnType<ImportRecordPackageUsecase['execute']>>;
    const competitor: { receiptId: string; snapshot: string } = { receiptId: '', snapshot: '' };
    try {
      const importPromise = importUsecase.execute({
        session,
        packageId: pkg.packageId,
        packagePath: pkg.packagePath,
        manifestChecksum: pkg.checksum,
      });
      await ready;

      competitor.receiptId = randomUUID();
      await runner.query(
        `INSERT INTO sync_receipt
          (receipt_id, record_uuid, organization_id, resource_type, version_no,
           source_system, source_installation_id, remote_resource_id, received_at,
           receipt_status, manifest_checksum, confirmed_at)
         VALUES (?, ?, ?, ?, ?, 'LOCAL', ?, NULL, NOW(3), 'SUCCEEDED', ?, NULL)`,
        [
          competitor.receiptId,
          item.recordUuid,
          ORGANIZATION_ID,
          item.resourceType ?? RESOURCE_TYPE,
          item.versionNo ?? 1,
          installationId,
          pkg.checksum,
        ],
      );
      const competitorBefore = (
        await runner.query('SELECT * FROM sync_receipt WHERE receipt_id = ?', [
          competitor.receiptId,
        ])
      )[0] as Record<string, unknown> | undefined;
      expect(competitorBefore).toBeDefined();
      competitor.snapshot = JSON.stringify(competitorBefore);

      proceed();
      result = await importPromise;
    } finally {
      proceed();
      await runner.release();
    }

    const confirmedReceiptId = competitor.receiptId;
    await registerImportSideEffects(pkg.packageId, [item], pkg.checksum, [confirmedReceiptId]);
    const competitorAfter = (
      await dataSource.query('SELECT * FROM sync_receipt WHERE receipt_id = ?', [
        confirmedReceiptId,
      ])
    )[0] as Record<string, unknown>;

    expect(candidateCreatedReceipts.has(confirmedReceiptId)).toBe(false);
    expect(owned.facts.syncReceipt.has(confirmedReceiptId)).toBe(false);
    assertFullIdentitySet(result.items, [expectedItem(item)]);
    // 正式 writer 已写入后才发现并发赢家：如实成功并引用赢家回执，但不认领其所有权。
    expect(itemFor(result.items, expectedItem(item))).toMatchObject({
      result: 'SUCCEEDED',
      receiptId: confirmedReceiptId,
    });
    expect(competitor.snapshot).not.toBe('');
    expect(JSON.stringify(competitorAfter)).toBe(competitor.snapshot);

    // 夹具属于本测试，断言后登记仅供 afterAll 回收；不冒充本轮导入创建。
    recordOwnedResource(owned, 'syncReceipt', confirmedReceiptId, {
      organizationId: ORGANIZATION_ID,
      recordUuid: item.recordUuid,
      resourceType: item.resourceType ?? RESOURCE_TYPE,
      versionNo: item.versionNo ?? 1,
      sourceSystem: 'LOCAL',
    });
  });
});
