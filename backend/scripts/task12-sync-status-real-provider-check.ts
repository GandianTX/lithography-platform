// scripts/task12-sync-status-real-provider-check.ts
/**
 * 任务 09 第 12 项 · **任务 07 同步状态真实 provider** 的隔离实库取证。
 *
 * 目的（计划第 12 项第 3 点）：
 * 「07 列表／详情的同步状态真实 provider、`recordUuid`、草稿／正式版本、权限与冲突入口」
 * —— 并要求「各链要区分真实源操作、插表夹具与 mock」。
 *
 * 本次核对发现的缺口（见 S34 证据文档 §3）：
 * `LOCAL_SYNC_STATUS_READER` → `MaintenanceReportSyncStatusReaderAdapter` →
 * `SYNC_STATUS_QUERY` → `QuerySyncStatusesUsecase` → `SyncStatusQueryService` /
 * `SyncSourceRecordQueryService` 这条**真实链在代码上闭合，但从未被真实库驱动过**
 * （`backend/scripts/**` 对 `QuerySyncStatusesUsecase` / `SYNC_STATUS_QUERY` 零引用）。
 * 本脚本补上这一跳。
 *
 * 边界声明（三类严格区分）：
 * - **真实源操作**：同步状态读取链（resolver → usecase → 查询服务 → 真实 DB）**全部走生产代码**；
 * - **插表夹具**：为让读取链有事实可读，本脚本**直接 INSERT** 资料行、同步任务行，
 *   并**临时**改写 `local_installation.organization_id` 与两个账号的 `admin_level`
 *   （原值先记录、收尾原样恢复）；
 * - **mock**：本脚本**不使用任何 mock**（不注入 jest 替身，不打桩存储）。
 *
 * 收尾纪律：只按**精确主键/标识**删除本轮创建的行；安装归属与管理员等级按**原值**恢复；
 * 任何异常路径都经 `finally` 收尾。
 *
 * 用法（backend 目录）：
 *   TASK12_SYNC_PROVIDER_ALLOW=1 \
 *   TASK12_SYNC_PROVIDER_ENV=env/.env.e2e \
 *   TASK12_SYNC_PROVIDER_DATABASE=lithography_task09_test_e2e \
 *   npx ts-node -r tsconfig-paths/register scripts/task12-sync-status-real-provider-check.ts
 */

// 脚本属**受控 wiring**：运行时配置只在这里读取一次。
import { Test } from '@nestjs/testing';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { join } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { composeBusinessSyncEntityLocalId } from '@core/local-runtime/policy/business-sync-source.policy';
import { deriveRecordUuid } from '@core/local-runtime/policy/record-package-export.policy';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LOCAL_SYNC_STATUS_READER } from '@src/usecases/common/ports/local-sync-status-reader.contract';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import {
  SYNC_STATUS_QUERY,
  type SyncStatusQueryItem,
  type SyncStatusQueryPort,
} from '@src/usecases/local-runtime/sync-status.contract';

import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  text,
} from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

/** 进度输出（定位挂起点；不参与断言） */
const step = (message: string): void => {
  process.stdout.write(`· ${message}\n`);
};

/** 本机负责的数据区（CLIENT_DEFAULT） */
const TARGET_ORGANIZATION_ID = 1;
/** 同行隔离组织（二级管理员的可信公司） */
const PEER_ORGANIZATION_ID = 910002;
void PEER_ORGANIZATION_ID;
/** 一级管理员账号（本机可见全局） */
const LEVEL_ONE_ACCOUNT_ID = 900001;
/** 二级管理员账号（可信公司＝同行隔离组织） */
const LEVEL_TWO_ACCOUNT_ID = 900301;
/** 工程师账号（本公司） */
const ENGINEER_ACCOUNT_ID = 900101;

/** 合成稳定编号（持久化身份） */
const PERSISTED_UUID = '97b20000-0000-4000-8000-000000000001';
const DRAFT_UUID = '97b20000-0000-4000-8000-000000000002';

type Session = {
  accountId: number;
  roles: string[];
  activeRole: string;
  adminLevel: number | null;
  customerOrganizationId: null;
};

function toUsecaseSession(session: Session): UsecaseSession {
  return session as unknown as UsecaseSession;
}

const LEVEL_ONE_SESSION = toUsecaseSession({
  accountId: LEVEL_ONE_ACCOUNT_ID,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
  adminLevel: 1,
  customerOrganizationId: null,
});

const LEVEL_TWO_SESSION = toUsecaseSession({
  accountId: LEVEL_TWO_ACCOUNT_ID,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
  adminLevel: 2,
  customerOrganizationId: null,
});

const ENGINEER_SESSION = toUsecaseSession({
  accountId: ENGINEER_ACCOUNT_ID,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
  adminLevel: null,
  customerOrganizationId: null,
});

type Ctx = {
  dataSource: DataSource;
  /** 09 内部窄边界端口（真实实现） */
  queryPort: SyncStatusQueryPort;
  /** 07 侧消费的适配器（真实实现，经中性令牌） */
  reader: {
    fetchStatuses: (
      session: UsecaseSession,
      queries: ReadonlyArray<{
        organizationId: number;
        resourceType: string;
        recordUuid: string;
        sourceVersion: number | null;
      }>,
    ) => Promise<{
      connected: boolean;
      entries: ReadonlyArray<{
        organizationId: number;
        resourceType: string;
        recordUuid: string;
        sourceVersion: number | null;
        status: string;
        message: string | null;
        conflictId: string | null;
        canResolveConflict: boolean;
      }>;
    }>;
  };
  installationId: string;
};

/** 原值登记（收尾原样恢复） */
type Originals = {
  installationOrganizationId: number | null;
  installationOrganizationCodeSnapshot: string | null;
  levelOneAdminLevel: number | null;
  levelTwoAdminLevel: number | null;
};

async function bootstrap(envFile: string, database: string): Promise<Ctx> {
  loadEnvFile(envFile);
  const config = loadExplicitEnvConfig(envFile, database);
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
  const installationId = await readInstallationId(dataSource);
  if (installationId === null) {
    throw new Error('未找到本机安装标识，拒绝运行');
  }
  return {
    dataSource,
    queryPort: moduleRef.get<SyncStatusQueryPort>(SYNC_STATUS_QUERY, { strict: false }),
    reader: moduleRef.get(LOCAL_SYNC_STATUS_READER, { strict: false }),
    installationId,
  };
}

/** 通过 09 内部端口查询（真实链） */
async function queryViaPort(
  ctx: Ctx,
  session: UsecaseSession,
  requests: ReadonlyArray<{
    organizationId: number;
    resourceType: string;
    recordUuid: string;
    sourceVersion: number | null;
  }>,
): Promise<readonly SyncStatusQueryItem[]> {
  return await ctx.queryPort.queryStatuses({ session, requests });
}

/** 通过 07 侧适配器查询（真实链：任务 07 消费的就是这个端口） */
async function queryViaReader(
  ctx: Ctx,
  session: UsecaseSession,
  queries: ReadonlyArray<{
    organizationId: number;
    resourceType: string;
    recordUuid: string;
    sourceVersion: number | null;
  }>,
): Promise<{
  connected: boolean;
  entries: ReadonlyArray<{
    organizationId: number;
    resourceType: string;
    recordUuid: string;
    sourceVersion: number | null;
    status: string;
    message: string | null;
    conflictId: string | null;
    canResolveConflict: boolean;
  }>;
}> {
  return await ctx.reader.fetchStatuses(session, queries);
}

/** 读取一行原始值（用于记录原值并原样恢复） */
async function readScalar(
  dataSource: DataSource,
  sql: string,
  parameters: ReadonlyArray<unknown>,
): Promise<string | null> {
  const rows: unknown = await dataSource.query(sql, [...parameters]);
  const list = rows as ReadonlyArray<Record<string, unknown>>;
  const first = list[0];
  if (first === undefined) {
    return null;
  }
  const value = first[Object.keys(first)[0] ?? ''];
  return value === null || value === undefined ? null : text(value);
}

/** 当前上下文（供顶层异常兜底关闭连接） */
const runtime: { ctx: Ctx | null } = { ctx: null };

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const envFile = process.env.TASK12_SYNC_PROVIDER_ENV ?? 'env/.env.e2e';
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const database = process.env.TASK12_SYNC_PROVIDER_DATABASE ?? '';
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  if (process.env.TASK12_SYNC_PROVIDER_ALLOW !== '1') {
    throw new Error('默认拒绝：请显式设置 TASK12_SYNC_PROVIDER_ALLOW=1');
  }
  if (database.length === 0 || !/(test|drill|ci)/.test(database.toLowerCase())) {
    throw new Error(`拒绝非隔离目标：${database}`);
  }

  const ctx = await bootstrap(envFile, database);
  runtime.ctx = ctx;
  const originals: Originals = {
    installationOrganizationId: null,
    installationOrganizationCodeSnapshot: null,
    levelOneAdminLevel: null,
    levelTwoAdminLevel: null,
  };
  const createdDocumentIds: number[] = [];
  const createdTaskIds: number[] = [];
  const createdAuthorizationIds: number[] = [];

  try {
    // ── 夹具前置：记录原值 ──────────────────────────────────────────────
    originals.installationOrganizationId = await readScalar(
      ctx.dataSource,
      'SELECT `organization_id` FROM `local_installation` LIMIT 1',
      [],
    ).then((value) => (value === null ? null : Number(value)));
    originals.installationOrganizationCodeSnapshot = await readScalar(
      ctx.dataSource,
      'SELECT `organization_code_snapshot` FROM `local_installation` LIMIT 1',
      [],
    );
    originals.levelOneAdminLevel = await readScalar(
      ctx.dataSource,
      'SELECT `admin_level` FROM `base_user_account` WHERE `id` = ?',
      [LEVEL_ONE_ACCOUNT_ID],
    ).then((value) => (value === null ? null : Number(value)));
    originals.levelTwoAdminLevel = await readScalar(
      ctx.dataSource,
      'SELECT `admin_level` FROM `base_user_account` WHERE `id` = ?',
      [LEVEL_TWO_ACCOUNT_ID],
    ).then((value) => (value === null ? null : Number(value)));

    step('读取原值完成');
    // ── 夹具：本机归属映射 + 管理员等级 ──────────────────────────────────
    // 说明：真实部署里这些事实由安装初始化与管理员开通流程写入；
    // 隔离库没有 ⇒ 读取链会因"本机未映射云端组织"直接返回空数组，测不到真实读侧。
    await ctx.dataSource.query(
      'UPDATE `local_installation` SET `organization_id` = ?, `organization_code_snapshot` = ?',
      [TARGET_ORGANIZATION_ID, 'CLIENT_DEFAULT'],
    );
    await ctx.dataSource.query('UPDATE `base_user_account` SET `admin_level` = 1 WHERE `id` = ?', [
      LEVEL_ONE_ACCOUNT_ID,
    ]);
    await ctx.dataSource.query('UPDATE `base_user_account` SET `admin_level` = 2 WHERE `id` = ?', [
      LEVEL_TWO_ACCOUNT_ID,
    ]);

    // ── 夹具：资料行（一条持久化身份、一条历史派生、一条草稿）────────────
    const insertDocument = async (
      recordUuid: string | null,
      revisionNo: number,
      title: string,
    ): Promise<number> => {
      const result: unknown = await ctx.dataSource.query(
        `INSERT INTO \`reference_document\`
           (\`title\`, \`document_type\`, \`created_by_account_id\`, \`ingest_method\`, \`schema_version\`,
            \`deprecated\`, \`deleted_at\`, \`publication_status\`, \`ownership_status\`,
            \`current_revision_no\`, \`source_kind\`, \`record_uuid\`, \`owner_organization_id\`,
            \`content_text\`, \`updated_by_account_id\`)
         VALUES (?, 'MANUAL', ?, 'ADMIN_DIRECT', 1, 0, NULL, 'ONLINE', 'CONFIRMED', ?, 'MATERIAL', ?, ?, 'T12 合成资料', NULL)`,
        [title, LEVEL_ONE_ACCOUNT_ID, revisionNo, recordUuid, TARGET_ORGANIZATION_ID],
      );
      const insertId = Number((result as { insertId?: unknown })?.insertId ?? 0);
      if (!Number.isInteger(insertId) || insertId <= 0) {
        throw new Error(`插入资料夹具失败：${title}`);
      }
      createdDocumentIds.push(insertId);
      return insertId;
    };

    const persistedDocumentId = await insertDocument(PERSISTED_UUID, 3, 'T12 持久化身份资料');
    const legacyDocumentId = await insertDocument(null, 2, 'T12 历史派生身份资料');
    await insertDocument(DRAFT_UUID, 0, 'T12 草稿资料');

    // ── 夹具：本机账号授权（业务同步用途）────────────────────────────────
    // 依据：公司级"正式运行模式"与记录级授权都读 local_account_authorization，
    // 且业务同步用途只认 signed_claims.purpose 含 BUSINESS_SYNC 的凭据。
    const authorizationResult: unknown = await ctx.dataSource.query(
      `INSERT INTO \`local_account_authorization\`
         (\`installation_id\`, \`account_id\`, \`organization_id\`, \`authorization_status\`,
          \`revoked_at\`, \`signed_claims\`, \`permission_version\`, \`last_verified_at\`)
       VALUES (?, ?, ?, 'ACTIVE', NULL, JSON_OBJECT('purpose', 'BUSINESS_SYNC'), 1, NOW(3))`,
      [ctx.installationId, LEVEL_ONE_ACCOUNT_ID, TARGET_ORGANIZATION_ID],
    );
    const authorizationId = Number((authorizationResult as { insertId?: unknown })?.insertId ?? 0);
    if (Number.isInteger(authorizationId) && authorizationId > 0) {
      createdAuthorizationIds.push(authorizationId);
    }
    check(
      '夹具：插入业务同步用途的本机账号授权成功',
      Number.isInteger(authorizationId) && authorizationId > 0,
      `authorizationId=${authorizationId}`,
    );

    // ── 夹具：同步任务行 ────────────────────────────────────────────────
    const insertTask = async (
      recordUuid: string,
      taskKind: string | null,
      sourceVersion: number,
      idempotencyKey: string,
      entityVersion: string,
    ): Promise<number> => {
      const result: unknown = await ctx.dataSource.query(
        `INSERT INTO \`local_upload_task\`
           (\`installation_id\`, \`entity_type\`, \`entity_local_id\`, \`entity_version\`,
            \`idempotency_key\`, \`status\`, \`record_uuid\`, \`source_version\`, \`task_kind\`,
            \`organization_id\`, \`account_id\`)
         VALUES (?, 'REPORT_VERSION', ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
        [
          ctx.installationId,
          composeBusinessSyncEntityLocalId('REFERENCE_DOCUMENT', persistedDocumentId),
          entityVersion,
          idempotencyKey,
          recordUuid,
          sourceVersion,
          taskKind,
          TARGET_ORGANIZATION_ID,
          LEVEL_ONE_ACCOUNT_ID,
        ],
      );
      const insertId = Number((result as { insertId?: unknown })?.insertId ?? 0);
      if (!Number.isInteger(insertId) || insertId <= 0) {
        throw new Error(`插入同步任务夹具失败：${idempotencyKey}`);
      }
      createdTaskIds.push(insertId);
      return insertId;
    };

    step('资料夹具完成');
    const businessSyncTaskId = await insertTask(
      PERSISTED_UUID,
      'BUSINESS_SYNC',
      3,
      't12-sync-provider-business-sync',
      '3',
    );
    const legacyTaskId = await insertTask(
      PERSISTED_UUID,
      null,
      3,
      't12-sync-provider-legacy-kind',
      'legacy-kind',
    );

    step('任务夹具完成');
    // P1 真实 provider 装配（07 侧拿到的不是"不可用"兜底）
    const readerBatch = await queryViaReader(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    check(
      'P1：07 侧同步状态 provider 为真实实现（connected=true，非 NOT_CONNECTED 兜底）',
      readerBatch.connected === true,
      `connected=${readerBatch.connected} entries=${readerBatch.entries.length}`,
    );

    step('P1 完成');
    // P2 持久化 record_uuid 定向命中
    const portItems = await queryViaPort(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    const persistedItem = portItems.find((item) => item.recordUuid === PERSISTED_UUID);
    check(
      'P2：持久化 record_uuid 走定向定位命中（identityPersisted=true、服务端版本=3）',
      persistedItem !== undefined &&
        persistedItem.identityPersisted === true &&
        persistedItem.sourceVersion === 3 &&
        persistedItem.organizationId === TARGET_ORGANIZATION_ID,
      `item=${JSON.stringify(persistedItem ?? null)}`,
    );

    step('P2 完成');
    // P3 历史行回退：派生 UUID 命中但身份未持久化
    const legacyDerivedUuid = deriveRecordUuid('REFERENCE_DOCUMENT', legacyDocumentId);
    const legacyItems = await queryViaPort(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: legacyDerivedUuid,
        sourceVersion: 2,
      },
    ]);
    const legacyItem = legacyItems.find((item) => item.recordUuid === legacyDerivedUuid);
    check(
      'P3：历史行（record_uuid 为 NULL）经派生 UUID 回退命中，且身份未持久化',
      legacyItem !== undefined && legacyItem.identityPersisted === false,
      `derived=${legacyDerivedUuid} item=${JSON.stringify(legacyItem ?? null)}`,
    );

    step('P3 完成');
    // P4 草稿版本不可核验 ⇒ 07 侧不产出条目
    const draftBatch = await queryViaReader(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: DRAFT_UUID,
        sourceVersion: 0,
      },
    ]);
    const draftEntry = draftBatch.entries.find((entry) => entry.recordUuid === DRAFT_UUID);
    check(
      'P4：草稿版本（当前版本=0）不可核验 ⇒ provider 不产出条目（调用方降级 UNKNOWN）',
      draftEntry === undefined,
      `entries=${JSON.stringify(draftBatch.entries)}`,
    );

    step('P4 完成');
    // P5 任务种类隔离
    const statusWithBusinessTask = persistedItem?.status;
    await ctx.dataSource.query('DELETE FROM `local_upload_task` WHERE `id` = ?', [
      businessSyncTaskId,
    ]);
    createdTaskIds.length = 0;
    createdTaskIds.push(legacyTaskId);
    const itemsWithoutBusinessTask = await queryViaPort(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    const itemWithoutBusinessTask = itemsWithoutBusinessTask.find(
      (item) => item.recordUuid === PERSISTED_UUID,
    );
    check(
      'P5a：BUSINESS_SYNC 任务被计入（有任务 ≠ 无任务）',
      statusWithBusinessTask !== undefined &&
        itemWithoutBusinessTask !== undefined &&
        statusWithBusinessTask !== itemWithoutBusinessTask.status,
      `withTask=${text(statusWithBusinessTask)} withoutTask=${text(itemWithoutBusinessTask?.status)}`,
    );
    check(
      'P5b：task_kind 为空的历史任务只表达"用途不明"，不冒充业务同步任务（也不谎报无任务）',
      itemWithoutBusinessTask !== undefined &&
        itemWithoutBusinessTask.status === 'UNKNOWN' &&
        itemWithoutBusinessTask.reasonCode === 'TASK_KIND_UNKNOWN',
      `withoutTask=${text(itemWithoutBusinessTask?.status)} reason=${text(itemWithoutBusinessTask?.reasonCode)}`,
    );

    step('P5 完成');
    // P6 一级管理员可见本公司记录
    const levelOneItems = await queryViaPort(ctx, LEVEL_ONE_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    check(
      'P6：一级管理员可见本公司记录',
      levelOneItems.some((item) => item.recordUuid === PERSISTED_UUID),
      `count=${levelOneItems.length}`,
    );

    step('P6 完成');
    // P7 二级管理员（可信公司＝同行隔离组织）跨公司读取被拒
    const levelTwoItems = await queryViaPort(ctx, LEVEL_TWO_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    check(
      'P7：二级管理员跨公司读取被拒（不返回任何条目，不泄露记录存在性）',
      levelTwoItems.length === 0,
      `count=${levelTwoItems.length}`,
    );

    step('P7 完成');
    // P8 工程师本公司可见
    const engineerItems = await queryViaPort(ctx, ENGINEER_SESSION, [
      {
        organizationId: TARGET_ORGANIZATION_ID,
        resourceType: 'REFERENCE_DOCUMENT',
        recordUuid: PERSISTED_UUID,
        sourceVersion: 3,
      },
    ]);
    check(
      'P8：工程师可见本公司记录',
      engineerItems.some((item) => item.recordUuid === PERSISTED_UUID),
      `count=${engineerItems.length}`,
    );
  } finally {
    // 收尾：按精确主键删除本轮夹具，并把被改写的原值原样恢复
    // 每一步独立兜底：前一步失败不得阻断后续清理（否则会留下残留夹具）
    try {
      if (createdTaskIds.length > 0) {
        await ctx.dataSource.query('DELETE FROM `local_upload_task` WHERE `id` IN (?)', [
          [...createdTaskIds],
        ]);
      }
    } catch (error) {
      process.stdout.write(`⚠️ 任务夹具清理失败：${text(error)}\n`);
    }
    try {
      if (createdAuthorizationIds.length > 0) {
        await ctx.dataSource.query('DELETE FROM `local_account_authorization` WHERE `id` IN (?)', [
          [...createdAuthorizationIds],
        ]);
      }
    } catch (error) {
      process.stdout.write(`⚠️ 授权夹具清理失败：${text(error)}\n`);
    }
    try {
      if (createdDocumentIds.length > 0) {
        await ctx.dataSource.query('DELETE FROM `reference_document` WHERE `id` IN (?)', [
          [...createdDocumentIds],
        ]);
      }
    } catch (error) {
      process.stdout.write(`⚠️ 资料夹具清理失败：${text(error)}\n`);
    }
    await ctx.dataSource.query(
      'UPDATE `local_installation` SET `organization_id` = ?, `organization_code_snapshot` = ?',
      [originals.installationOrganizationId, originals.installationOrganizationCodeSnapshot],
    );
    await ctx.dataSource.query('UPDATE `base_user_account` SET `admin_level` = ? WHERE `id` = ?', [
      originals.levelOneAdminLevel,
      LEVEL_ONE_ACCOUNT_ID,
    ]);
    await ctx.dataSource.query('UPDATE `base_user_account` SET `admin_level` = ? WHERE `id` = ?', [
      originals.levelTwoAdminLevel,
      LEVEL_TWO_ACCOUNT_ID,
    ]);
    const leftoverTasks = await readScalar(
      ctx.dataSource,
      'SELECT COUNT(*) AS c FROM `local_upload_task` WHERE `idempotency_key` LIKE ?',
      ['t12-sync-provider-%'],
    );
    const leftoverDocs = await readScalar(
      ctx.dataSource,
      'SELECT COUNT(*) AS c FROM `reference_document` WHERE `title` LIKE ?',
      ['T12 %'],
    );
    const restoredInstallation = await readScalar(
      ctx.dataSource,
      'SELECT `organization_id` FROM `local_installation` LIMIT 1',
      [],
    );
    const installationRestored =
      restoredInstallation === null
        ? originals.installationOrganizationId === null
        : Number(restoredInstallation) === originals.installationOrganizationId;
    check(
      '收尾：本轮夹具零残留，且安装归属／管理员等级原样恢复',
      leftoverTasks === '0' && leftoverDocs === '0' && installationRestored,
      `tasks=${text(leftoverTasks)} docs=${text(leftoverDocs)} installation=${text(restoredInstallation)} ` +
        `origin=${text(originals.installationOrganizationId)}`,
    );
    await ctx.dataSource.destroy();
  }

  process.stdout.write('\n');
  for (const item of assertions) {
    process.stdout.write(`${item.passed ? 'PASS' : 'FAIL'} · ${item.name} · ${item.detail}\n`);
  }
  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`\n总断言 ${assertions.length}，失败 ${failed.length}\n`);
  process.stdout.write(
    failed.length === 0
      ? '✅ 任务 07 同步状态真实 provider 实库验证通过\n'
      : '❌ 任务 07 同步状态真实 provider 实库验证未通过\n',
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : text(error);
  process.stdout.write(`❌ 脚本失败：${message}\n`);
  process.exitCode = 1;
  // 兜底：异常路径也必须关闭连接，否则进程会因开放句柄挂起
  await runtime.ctx?.dataSource.destroy().catch(() => undefined);
});
