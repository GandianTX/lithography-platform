// src/usecases/local-runtime/sync-receipt-concurrency.integration.spec.ts

/**
 * 回执写入的**真实并发**验收（任务 09 S3 补丁 P5-2「同步与导入并发」）。
 *
 * 需求口径：**并发重复只一修订**——同一把键
 * （公司 ＋ 资源类型 ＋ 记录 UUID ＋ 版本）被两方同时写入时，
 * 只应存在**一行**回执，且两方都拿到**同一个**回执 ID（败方幂等复用胜方），
 * **不得**把原始唯一键错误抛给上层（否则一条记录会被误判成"同步/导入失败"）。
 *
 * 真实并发方式：两个**独立连接**（各自 `EntityManager`）并发 INSERT，
 * 由 MySQL 唯一键 `uk_sync_receipt_scope_v13` 真实产生竞争与败方；
 * 不用固定 sleep 猜测执行顺序。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   SYNC_RECEIPT_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     npx jest src/usecases/local-runtime/sync-receipt-concurrency.integration.spec.ts --runInBand
 *
 * 夹具策略：本轮生成的唯一键（随机 UUID）登记后**按该键精确删除**，
 * 不触碰任何其他行；不修改共享数据。
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';

import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';

import { assertDataSourceOnAllowedE2eDatabase } from '../../../test/utils/e2e-db-guard';

const ENABLED = process.env.SYNC_RECEIPT_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';

type ReceiptKey = {
  organizationId: number;
  resourceType: string;
  recordUuid: string;
  versionNo: number;
};

describeIntegration('回执写入的真实并发（同一把键只一行、双方幂等复用）', () => {
  let moduleRef: Awaited<ReturnType<typeof Test.createTestingModule>> extends {
    compile(): Promise<infer M>;
  }
    ? M
    : never;
  let dataSource: DataSource;
  let receiptService: BusinessSyncReceiptService;
  const fixtureKeys: ReceiptKey[] = [];
  const independentRunners: QueryRunner[] = [];

  beforeAll(async () => {
    const declared = process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
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
          entities: [join(__dirname, '../../modules/**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        LithographyModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);
    receiptService = moduleRef.get(BusinessSyncReceiptService);
  });

  afterAll(async () => {
    // 只按本轮登记的唯一键精确删除，不触碰其他行
    for (const key of fixtureKeys) {
      await dataSource.query(
        'DELETE FROM `sync_receipt` WHERE `organization_id` = ? AND `resource_type` = ? AND `record_uuid` = ? AND `version_no` = ?',
        [key.organizationId, key.resourceType, key.recordUuid, key.versionNo],
      );
    }
    for (const runner of independentRunners) {
      await runner.release();
    }
    await dataSource.destroy();
  });

  /** 两个**独立连接**的 EntityManager（真并发；TypeORM 的 DataSource 只有单例 manager） */
  async function createIndependentManager(source: DataSource): Promise<EntityManager> {
    const runner = source.createQueryRunner();
    await runner.connect();
    independentRunners.push(runner);
    return runner.manager;
  }

  /** 按唯一键统计回执行数（不 import ORM Entity：架构守卫禁止 usecase 层引用实体） */
  async function countReceiptRows(source: DataSource, key: ReceiptKey): Promise<number> {
    const rows = (await source.query(
      'SELECT `receipt_id` FROM `sync_receipt` WHERE `organization_id` = ? AND `resource_type` = ? AND `record_uuid` = ? AND `version_no` = ?',
      [key.organizationId, key.resourceType, key.recordUuid, key.versionNo],
    )) as unknown as { receipt_id: string }[];
    return rows.length;
  }

  function makeKey(): ReceiptKey {
    const key: ReceiptKey = {
      organizationId: 1,
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: randomUUID(),
      versionNo: 9,
    };
    fixtureKeys.push(key);
    return key;
  }

  it('两个并发导入回执写同一把键：只一行，双方拿到同一回执 ID', async () => {
    const key = makeKey();
    const managerA = await createIndependentManager(dataSource);
    const managerB = await createIndependentManager(dataSource);

    const [first, second] = await Promise.all([
      receiptService.recordImportedVersion(
        {
          ...key,
          manifestChecksum: 'a'.repeat(64),
          sourceInstallationId: 'source-installation-1',
        },
        createTypeOrmPersistenceTransactionContext(managerA),
      ),
      receiptService.recordImportedVersion(
        {
          ...key,
          manifestChecksum: 'a'.repeat(64),
          sourceInstallationId: 'source-installation-1',
        },
        createTypeOrmPersistenceTransactionContext(managerB),
      ),
    ]);

    expect(first).toBe(second);
    const rows = await countReceiptRows(dataSource, key);
    expect(rows).toBe(1);
  });

  it('同步路径与导入路径并发写同一把键：只一行，双方幂等复用', async () => {
    const key = makeKey();
    const managerA = await createIndependentManager(dataSource);
    const managerB = await createIndependentManager(dataSource);

    const [syncId, importId] = await Promise.all([
      receiptService.recordSuccess(
        {
          organizationId: key.organizationId,
          resourceType: key.resourceType,
          recordUuid: key.recordUuid,
          versionNo: key.versionNo,
          installationId: 'source-installation-2',
          remoteResourceId: 'remote-1',
          receivedAt: new Date('2026-11-23T00:00:00.000Z'),
          manifestChecksum: 'b'.repeat(64),
        },
        createTypeOrmPersistenceTransactionContext(managerA),
      ),
      receiptService.recordImportedVersion(
        {
          ...key,
          manifestChecksum: 'b'.repeat(64),
          sourceInstallationId: 'source-installation-2',
        },
        createTypeOrmPersistenceTransactionContext(managerB),
      ),
    ]);

    expect(syncId).toBe(importId);
    const rows = await countReceiptRows(dataSource, key);
    expect(rows).toBe(1);
  });
});
