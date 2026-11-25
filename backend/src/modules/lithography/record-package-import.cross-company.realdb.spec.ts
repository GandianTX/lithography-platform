// src/modules/lithography/record-package-import.cross-company.realdb.spec.ts

/**
 * 记录包检查事实的**实库归属与并发**验证（任务 09 独立验收 P1）。
 *
 * 纪律：
 * - 夹具全部由本规格登记（随机 package_id）；**收尾按真实 ID ＋ 归属事实精确回收**：
 *   删除前对全部登记对象做预检（身份、关键字段、外部引用），预检不通过即一条都不删；
 *   全部删除在**同一事务**内完成，后续任一步失败即整体回滚；
 *   收尾走全局守卫（库白名单 ＋ 显式物理清理许可 ＋ 预期/实际库核验），不降低任何门禁；
 * - 不修改任何既有行；不连真实云。
 *
 * 覆盖（隔离库的真实 MySQL，两条独立连接）：
 * - **归属边界**：`record_package_import.package_id` 是全局主键 ⇒ 同一编号
 *   只能有一行、只属于一个公司；其他公司用同一编号检查 ⇒ 受控拒绝、零写入；
 * - **并发插入同一编号**：双方初查均不存在 ⇒ 唯一键冲突；失败方必须用**当前读**
 *   回读赢家后按同一口径处理（跨公司 ⇒ 拒绝；同公司不同摘要 ⇒ 经锁完整重检）；
 * - **条目写入失败回滚**：换包重检中途失败 ⇒ 批次与条目整体回滚；
 * - **外公司哨兵**：本轮之外的既有行逐字段不变。
 *
 * 默认跳过；启用时显式声明隔离库并给出物理清理许可：
 *   RECORD_PACKAGE_CROSS_COMPANY_INTEGRATION=1 E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/modules/lithography/record-package-import.cross-company.realdb.spec.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { RecordPackageImportEntity } from '@src/modules/lithography/entities/record-package-import.entity';
import { RecordPackageItemEntity } from '@src/modules/lithography/entities/record-package-item.entity';
import { SyncReceiptEntity } from '@src/modules/lithography/entities/sync-receipt.entity';
import {
  RecordPackageImportService,
  type RecordPackageEvaluation,
} from '@src/modules/lithography/record-package-import.service';

import { assertDataSourceOnAllowedE2eDatabase } from '../../../test/utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
} from '../../../test/utils/e2e-scoped-cleanup';

/** 装配真实 DataSource 需要更长时间（默认 10s 不够） */
jest.setTimeout(120_000);

const ENABLED = process.env.RECORD_PACKAGE_CROSS_COMPANY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';

/** 本公司与同行隔离公司（隔离库既有夹具；本规格只读这两条公司的既有行） */
const OWN_ORGANIZATION_ID = 1;
const PEER_ORGANIZATION_ID = 910002;
/** 导入人账号（隔离库既有夹具） */
const ACTOR_ACCOUNT_ID = 900001;

type EvaluationInput = {
  packageId: string;
  targetOrganizationId: number;
  manifestChecksum: string;
  recordUuids: string[];
  passed?: boolean;
};

function buildEvaluation(input: EvaluationInput): RecordPackageEvaluation {
  const passed = input.passed ?? true;
  return {
    manifest: {
      package_id: input.packageId,
      organization_id: input.targetOrganizationId,
      items: [],
    },
    manifestRaw: JSON.stringify({
      schema_version: 1,
      package_id: input.packageId,
      organization_id: input.targetOrganizationId,
    }),
    manifestChecksum: input.manifestChecksum,
    targetOrganizationId: input.targetOrganizationId,
    outcomes: input.recordUuids.map((recordUuid) => ({
      recordUuid,
      resourceType: 'repair_request',
      versionNo: 1,
      passed,
      rejection: passed ? null : 'STRUCTURE_INVALID',
      message: passed ? null : '条目结构非法',
    })),
  } as unknown as RecordPackageEvaluation;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describeIntegration('记录包检查事实的实库归属与并发（任务 09 独立验收 P1）', () => {
  let dataSource: DataSource;
  let service: RecordPackageImportService;

  /** 本轮登记的真实对象（真实 ID ＋ 归属事实）；收尾按它精确回收 */
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
      entities: [join(__dirname, '../../**/*.entity.ts')],
    });
    await dataSource.initialize();
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);

    service = new RecordPackageImportService(
      dataSource.getRepository(RecordPackageImportEntity),
      dataSource.getRepository(RecordPackageItemEntity),
      dataSource.getRepository(SyncReceiptEntity),
      { findOrganizationIdentityByCode: () => Promise.resolve(null) } as never,
    );
  });

  afterAll(async () => {
    try {
      // 收尾：预检 ＋ 同事务精确删除（失败即整体回滚并抛出，不假报零残留）。
      await runGuardedSpecCleanup({
        dataSource,
        owned,
        helper: '记录包实库归属与并发规格 afterAll 精确回收',
        expectedDatabase: process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e',
      });
    } finally {
      await dataSource.destroy();
    }
  });

  /**
   * 登记本轮真实创建的批次与逐条事实（真实 ID ＋ 创建时确定的关键字段）。
   *
   * 归属事实取自**本轮造数输入**（目标公司、导入人、清单摘要、条目范围），
   * 不是清理阶段回读的当前值；删除前由全局清理器逐项核对。
   */
  async function registerOwnedRows(input: {
    packageId: string;
    organizationId: number;
    importedByAccountId: number;
    manifestChecksum: string;
  }): Promise<void> {
    recordOwnedResource(owned, 'recordPackageImport', input.packageId, {
      organizationId: input.organizationId,
      importedByAccountId: input.importedByAccountId,
      manifestChecksum: input.manifestChecksum,
    });
    const items = await readItems(input.packageId);
    for (const item of items) {
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
  }

  function newPackageId(): string {
    return randomUUID();
  }

  async function readBatch(packageId: string): Promise<Record<string, unknown> | null> {
    const rows = await dataSource.query(
      'SELECT * FROM `record_package_import` WHERE `package_id` = ?',
      [packageId],
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  async function readItems(packageId: string): Promise<Record<string, unknown>[]> {
    return await dataSource.query(
      'SELECT * FROM `record_package_item` WHERE `package_id` = ? ORDER BY `id` ASC',
      [packageId],
    );
  }

  it('其他公司用同一编号检查：受控拒绝，零写入，归属公司数据逐字段不变', async () => {
    const packageId = newPackageId();
    const ownUuids = [randomUUID(), randomUUID(), randomUUID()];

    // 本公司先落检查事实（批次 + 3 条逐条结论）
    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: ownUuids,
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });

    const batchBefore = await readBatch(packageId);
    const itemsBefore = await readItems(packageId);
    expect(batchBefore?.organization_id).toBe(OWN_ORGANIZATION_ID);
    expect(itemsBefore).toHaveLength(3);
    // 登记本轮真实创建的批次与逐条事实（收尾按它精确回收）
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'a'.repeat(64),
    });

    // 同行隔离公司用**同一编号**、不同清单来检查 ⇒ 必须受控拒绝
    let rejected: unknown = null;
    try {
      await dataSource.transaction(async (manager) => {
        await service.persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: PEER_ORGANIZATION_ID,
            manifestChecksum: 'b'.repeat(64),
            recordUuids: [randomUUID()],
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(manager),
        );
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).not.toBeNull();
    expect(rejected).toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    // 零写入：批次逐字段不变、逐条结论不变
    const batchAfter = await readBatch(packageId);
    const itemsAfter = await readItems(packageId);
    expect(batchAfter).toEqual(batchBefore);
    expect(itemsAfter).toEqual(itemsBefore);
    expect(batchAfter?.organization_id).toBe(OWN_ORGANIZATION_ID);
    expect(batchAfter?.manifest_checksum).toBe('a'.repeat(64));
  });

  it('并发插入同一编号（跨公司）：冲突后当前读回读赢家，失败方受控拒绝且无部分行', async () => {
    const packageId = newPackageId();

    const runnerWinner = dataSource.createQueryRunner();
    const runnerLoser = dataSource.createQueryRunner();
    await runnerWinner.connect();
    await runnerLoser.connect();
    await runnerWinner.startTransaction();
    await runnerLoser.startTransaction();

    try {
      // 赢家：插入后**不提交**（制造"对方看不见但唯一键已被占用"）
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: [randomUUID()],
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(runnerWinner.manager),
      );

      // 失败方：另一条连接上的独立事务（初查是快照读 ⇒ 看不到未提交行）
      const loserTask = service
        .persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: PEER_ORGANIZATION_ID,
            manifestChecksum: 'c'.repeat(64),
            recordUuids: [randomUUID(), randomUUID()],
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(runnerLoser.manager),
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      // barrier：让失败方跑到"插入被唯一键阻塞"这一步
      await sleep(500);
      let loserSettled = false;
      void loserTask.then(() => {
        loserSettled = true;
      });
      expect(loserSettled).toBe(false);

      // 赢家提交 ⇒ 失败方的插入命中唯一键冲突
      await runnerWinner.commitTransaction();
      const outcome = await loserTask;

      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toMatchObject({
        code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT,
      });

      // 失败方事务回滚：库里只有赢家那一行、归属是赢家公司、条目只有赢家的一条
      const batch = await readBatch(packageId);
      expect(batch?.organization_id).toBe(OWN_ORGANIZATION_ID);
      expect(batch?.manifest_checksum).toBe('a'.repeat(64));
      const items = await readItems(packageId);
      expect(items).toHaveLength(1);
      expect(items[0]?.package_id).toBe(packageId);
      // 登记赢家那一行（失败方的事务已回滚，没有本轮事实需要登记）
      await registerOwnedRows({
        packageId,
        organizationId: OWN_ORGANIZATION_ID,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        manifestChecksum: 'a'.repeat(64),
      });
    } finally {
      if (runnerWinner.isTransactionActive) {
        await runnerWinner.rollbackTransaction();
      }
      if (runnerLoser.isTransactionActive) {
        await runnerLoser.rollbackTransaction();
      }
      await runnerWinner.release();
      await runnerLoser.release();
    }
  });

  it('并发插入同一编号（同公司不同摘要）：经锁完整重检，不假称是同一个包', async () => {
    const packageId = newPackageId();

    const runnerWinner = dataSource.createQueryRunner();
    const runnerLoser = dataSource.createQueryRunner();
    await runnerWinner.connect();
    await runnerLoser.connect();
    await runnerWinner.startTransaction();
    await runnerLoser.startTransaction();

    try {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: [randomUUID()],
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(runnerWinner.manager),
      );

      const loserTask = service
        .persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: OWN_ORGANIZATION_ID,
            manifestChecksum: 'd'.repeat(64),
            recordUuids: [randomUUID(), randomUUID()],
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(runnerLoser.manager),
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      await sleep(500);
      await runnerWinner.commitTransaction();
      const outcome = await loserTask;

      expect(outcome.ok).toBe(true);
      // 失败方的重检结果要**提交后**才对其他连接可见 ⇒ 先提交再核对
      await runnerLoser.commitTransaction();
      const batch = await readBatch(packageId);
      expect(batch?.manifest_checksum).toBe('d'.repeat(64));
      expect(batch?.organization_id).toBe(OWN_ORGANIZATION_ID);
      const items = await readItems(packageId);
      expect(items).toHaveLength(2);
      await registerOwnedRows({
        packageId,
        organizationId: OWN_ORGANIZATION_ID,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        manifestChecksum: 'd'.repeat(64),
      });
    } finally {
      if (runnerWinner.isTransactionActive) {
        await runnerWinner.rollbackTransaction();
      }
      if (runnerLoser.isTransactionActive) {
        await runnerLoser.rollbackTransaction();
      }
      await runnerWinner.release();
      await runnerLoser.release();
    }
  });

  it('条目写入失败：批次与条目整体回滚，旧事实完整保留', async () => {
    const packageId = newPackageId();
    const ownUuids = [randomUUID(), randomUUID()];

    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: ownUuids,
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });

    const batchBefore = await readBatch(packageId);
    const itemsBefore = await readItems(packageId);
    expect(itemsBefore).toHaveLength(2);
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'a'.repeat(64),
    });

    // 故障注入：条目里的 record_uuid 超过 char(36) ⇒ 条目写入必然失败
    // （严格模式下 MySQL 报 ER_DATA_TOO_LONG）⇒ 事务整体回滚。
    let failure: unknown = null;
    try {
      await dataSource.transaction(async (manager) => {
        await service.persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: OWN_ORGANIZATION_ID,
            manifestChecksum: 'e'.repeat(64),
            recordUuids: ['00000000-0000-4000-8000-000000000000-EXTRA'],
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(manager),
        );
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).not.toBeNull();

    // 回滚后：批次仍是旧摘要、条目仍是旧的两条（旧事实完整保留）
    const batchAfter = await readBatch(packageId);
    const itemsAfter = await readItems(packageId);
    expect(batchAfter?.manifest_checksum).toBe('a'.repeat(64));
    expect(batchAfter?.status).toBe(batchBefore?.status);
    expect(itemsAfter).toHaveLength(2);
    expect(itemsAfter.map((item) => item.record_uuid)).toEqual(
      itemsBefore.map((item) => item.record_uuid),
    );
  });

  it('外公司哨兵：既有同行公司的记录逐字段不变', async () => {
    const sentinelBatches = await dataSource.query(
      'SELECT * FROM `record_package_import` WHERE `organization_id` = ? ORDER BY `package_id` ASC',
      [PEER_ORGANIZATION_ID],
    );
    const sentinelPackageIds = (sentinelBatches as Record<string, unknown>[]).map(
      (row) => row.package_id as string,
    );
    const sentinelItems =
      sentinelPackageIds.length === 0
        ? []
        : await dataSource.query(
            'SELECT * FROM `record_package_item` WHERE `package_id` IN (?) ORDER BY `id` ASC',
            [sentinelPackageIds],
          );

    // 本轮登记的编号都不属于同行公司 ⇒ 哨兵集合在本轮内不应变化
    for (const packageId of owned.recordPackageImportIds) {
      expect(sentinelPackageIds).not.toContain(packageId);
    }

    const afterBatches = await dataSource.query(
      'SELECT * FROM `record_package_import` WHERE `organization_id` = ? ORDER BY `package_id` ASC',
      [PEER_ORGANIZATION_ID],
    );
    const afterItems =
      sentinelPackageIds.length === 0
        ? []
        : await dataSource.query(
            'SELECT * FROM `record_package_item` WHERE `package_id` IN (?) ORDER BY `id` ASC',
            [sentinelPackageIds],
          );
    expect(afterBatches).toEqual(sentinelBatches);
    expect(afterItems).toEqual(sentinelItems);
  });

  // ── 占用与版本边界（复验 P1）：两条真实连接 + 屏障构造时序 ────────────────────
  it('占用版本边界（实库）：A 先读到 V1 → B 换包重检提交 V2 → A 占用必须受控拒绝，V2 逐项不变', async () => {
    const packageId = newPackageId();
    const v1Uuids = [randomUUID()];

    // 本公司先落 V1 的检查事实
    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: v1Uuids,
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'a'.repeat(64),
    });

    // 连接 A：读到 V1（快照读），随后暂停在占用之前
    const runnerA = dataSource.createQueryRunner();
    await runnerA.connect();
    await runnerA.startTransaction();
    try {
      const factsV1 = await service.readImportFacts(
        packageId,
        createTypeOrmPersistenceTransactionContext(runnerA.manager),
      );
      expect(factsV1?.import.manifestChecksum).toBe('a'.repeat(64));

      // 连接 B（同库另一条连接）：换包重检提交 V2（替换批次与逐条事实）
      const v2Uuids = [randomUUID(), randomUUID()];
      await dataSource.transaction(async (manager) => {
        await service.persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: OWN_ORGANIZATION_ID,
            manifestChecksum: 'd'.repeat(64),
            recordUuids: v2Uuids,
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(manager),
        );
      });

      // A 继续占用：当前读看到的已是 V2 ⇒ 必须受控拒绝，绝不把 V1 的执行记在 V2 上
      await expect(
        service.claimImportRun({
          packageId,
          importedByAccountId: ACTOR_ACCOUNT_ID,
          organizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          transactionContext: createTypeOrmPersistenceTransactionContext(runnerA.manager),
        }),
      ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED });
    } finally {
      if (runnerA.isTransactionActive) {
        await runnerA.rollbackTransaction();
      }
      await runnerA.release();
    }

    // V2 逐项不变：摘要、条目数、条目内容与状态都没被 A 的旧确认改动
    const batchAfter = await readBatch(packageId);
    const itemsAfter = await readItems(packageId);
    expect(batchAfter?.manifest_checksum).toBe('d'.repeat(64));
    expect(batchAfter?.status).toBe('PENDING');
    expect(itemsAfter).toHaveLength(2);
    // 登记当前版本的条目（V1 的条目已被替换删除）
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'd'.repeat(64),
    });
  });

  it('占用版本边界（实库·反向）：A 先占用 V1 → B 换包重检 V2 必须受控拒绝，V1 逐项不变', async () => {
    const packageId = newPackageId();
    const v1Uuids = [randomUUID(), randomUUID()];

    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: v1Uuids,
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'a'.repeat(64),
    });

    // A 占用 V1（提交后批次为 RUNNING）
    await dataSource.transaction(async (manager) => {
      const claimed = await service.claimImportRun({
        packageId,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        organizationId: OWN_ORGANIZATION_ID,
        manifestChecksum: 'a'.repeat(64),
        transactionContext: createTypeOrmPersistenceTransactionContext(manager),
      });
      expect(claimed.import.status).toBe('RUNNING');
      expect(claimed.import.manifestChecksum).toBe('a'.repeat(64));
      expect(claimed.items).toHaveLength(2);
    });

    // B 换包重检 V2：批次在导入中 ⇒ 受控拒绝，V1 逐项不变
    let failure: unknown = null;
    try {
      await dataSource.transaction(async (manager) => {
        await service.persistCheckOutcome(
          buildEvaluation({
            packageId,
            targetOrganizationId: OWN_ORGANIZATION_ID,
            manifestChecksum: 'd'.repeat(64),
            recordUuids: [randomUUID()],
          }),
          ACTOR_ACCOUNT_ID,
          createTypeOrmPersistenceTransactionContext(manager),
        );
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });

    const batchAfter = await readBatch(packageId);
    const itemsAfter = await readItems(packageId);
    expect(batchAfter?.manifest_checksum).toBe('a'.repeat(64));
    expect(batchAfter?.status).toBe('RUNNING');
    expect(itemsAfter).toHaveLength(2);
    expect(itemsAfter.map((item) => item.record_uuid)).toEqual(v1Uuids);
  });

  // ── 同账号并发（复验 P1）：两条独立连接，账号相同也不给第二个执行者 ────────────
  it('同账号并发（两连接）：A 占用未提交时 B 等锁，A 提交后 B 受控拒绝；占用前中断则回滚释放且可重试', async () => {
    // ① 造一个已确认的批次（PENDING）
    const packageId = newPackageId();
    const uuids = [randomUUID(), randomUUID()];
    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'a'.repeat(64),
          recordUuids: uuids,
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwnedRows({
      packageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'a'.repeat(64),
    });
    const claimInput = {
      packageId,
      importedByAccountId: ACTOR_ACCOUNT_ID, // 与 A 完全相同的账号
      organizationId: OWN_ORGANIZATION_ID,
      manifestChecksum: 'a'.repeat(64),
    };

    const runnerA = dataSource.createQueryRunner();
    const runnerB = dataSource.createQueryRunner();
    await runnerA.connect();
    await runnerB.connect();
    await runnerA.startTransaction();
    await runnerB.startTransaction();
    try {
      // A 占用（模拟已进入导入执行期，事务尚未提交）
      const claimedA = await service.claimImportRun({
        ...claimInput,
        transactionContext: createTypeOrmPersistenceTransactionContext(runnerA.manager),
      });
      expect(claimedA.import.status).toBe('RUNNING');

      // B 同账号同包同摘要发起：会先被行锁阻塞，A 提交后当前读看到 RUNNING ⇒ 受控拒绝
      const bTask = service
        .claimImportRun({
          ...claimInput,
          transactionContext: createTypeOrmPersistenceTransactionContext(runnerB.manager),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await sleep(300);
      await runnerA.commitTransaction();
      const outcomeB = await bTask;
      expect(outcomeB.ok).toBe(false);
      if (!outcomeB.ok) {
        expect(outcomeB.error).toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });
      }
    } finally {
      if (runnerA.isTransactionActive) {
        await runnerA.rollbackTransaction();
      }
      if (runnerB.isTransactionActive) {
        await runnerB.rollbackTransaction();
      }
      await runnerA.release();
      await runnerB.release();
    }

    // A 已提交：批次保持 RUNNING，B 事后重试仍被拒绝（**无自动接管**）
    await expect(service.claimImportRun({ ...claimInput })).rejects.toMatchObject({
      code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
    });
    const batchAfter = await readBatch(packageId);
    expect(batchAfter?.status).toBe('RUNNING');
    expect(batchAfter?.manifest_checksum).toBe('a'.repeat(64));
    expect(await readItems(packageId)).toHaveLength(2);

    // ② 占用前中断：另一批次的占用事务回滚 ⇒ 行锁释放，批次回到 PENDING，可重新占用
    const rollbackPackageId = newPackageId();
    await dataSource.transaction(async (manager) => {
      await service.persistCheckOutcome(
        buildEvaluation({
          packageId: rollbackPackageId,
          targetOrganizationId: OWN_ORGANIZATION_ID,
          manifestChecksum: 'c'.repeat(64),
          recordUuids: [randomUUID()],
        }),
        ACTOR_ACCOUNT_ID,
        createTypeOrmPersistenceTransactionContext(manager),
      );
    });
    await registerOwnedRows({
      packageId: rollbackPackageId,
      organizationId: OWN_ORGANIZATION_ID,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      manifestChecksum: 'c'.repeat(64),
    });
    const runnerInterrupted = dataSource.createQueryRunner();
    await runnerInterrupted.connect();
    await runnerInterrupted.startTransaction();
    try {
      await service.claimImportRun({
        packageId: rollbackPackageId,
        importedByAccountId: ACTOR_ACCOUNT_ID,
        organizationId: OWN_ORGANIZATION_ID,
        manifestChecksum: 'c'.repeat(64),
        transactionContext: createTypeOrmPersistenceTransactionContext(runnerInterrupted.manager),
      });
      // 进程中断：未提交即断开 ⇒ 回滚释放锁，不留下 RUNNING 残留
      await runnerInterrupted.rollbackTransaction();
    } finally {
      if (runnerInterrupted.isTransactionActive) {
        await runnerInterrupted.rollbackTransaction();
      }
      await runnerInterrupted.release();
    }
    expect((await readBatch(rollbackPackageId))?.status).toBe('PENDING');
    const retried = await service.claimImportRun({
      packageId: rollbackPackageId,
      importedByAccountId: ACTOR_ACCOUNT_ID,
      organizationId: OWN_ORGANIZATION_ID,
      manifestChecksum: 'c'.repeat(64),
    });
    expect(retried.import.status).toBe('RUNNING');
  });
});
