// src/infrastructure/database/repair-request-revision-previous-version.realdb.spec.ts
//
// 第 43 条迁移（repair_request_revision.previous_version）的受控实库验收规格。
//
// 默认不启用、不连接、不写库：全部 describe 为 skip，不创建 DataSource。
// 只有同时满足以下条件才会执行：
//   E2E_REAL_DB_SPECS=1
//   E2E_ALLOW_MIGRATION_43_UPGRADE=1
//   E2E_ALLOW_PHYSICAL_CLEANUP=1
//   E2E_REAL_DB_NAME=<目标库>
//   E2E_ALLOWED_DB_NAMES=<同一个库>
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径 env 文件>
//
// 前置：目标库已停在 42 态（第 42 条已记录，第 43 条未记录）。
// 本规格不建库、不 DROP 库、不清表、不 down 迁移，全程保持外键开启。
//
// 场景：
//   1. 在 42 态专用库中创建合法的组织、账号（含用户资料）、机型、工单与历史修订；
//      成功后把真实 ID、归属事实与引用关系登记进受保护台账；
//   2. 通过正式升级入口执行第 43 条，历史修订 previous_version 必须为 NULL，
//      其余旧字段与升级前逐字段一致；
//   3. 首版 0→1、后续 1→2 合法；
//   4. previous_version = revision_no 或 > revision_no 命中
//      chk_repair_request_revision_previous_version 被拒绝；
//   5. 收尾只按台账登记的真实 ID 与事实精确回收，主错误与收尾错误分别保留。

import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  assertAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
} from '../../../test/utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
} from '../../../test/utils/e2e-scoped-cleanup';
import { normalizeBigIntId } from '../../../test/utils/lossless-bigint-id';
import { runDatabaseDeploy } from './database-deploy';
import {
  createMigrationDataSource,
  loadExplicitEnvConfig,
  readMigrationHistory,
  type MigrationDbConfig,
  type MigrationLogger,
} from './incremental-migration';

export interface M43Target {
  readonly configFile: string;
  readonly database: string;
  readonly serverUuid: string;
}

/**
 * 在建立任何连接之前解析目标：显式开关、显式配置、单一白名单、固定 UUID 缺一不可。
 * 不读取 .env.e2e / .env.development，也不回退默认库。
 */
export const resolveM43Target = (env: NodeJS.ProcessEnv): M43Target => {
  if (env.E2E_REAL_DB_SPECS !== '1') {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_REAL_DB_SPECS=1');
  }
  if (env.E2E_ALLOW_MIGRATION_43_UPGRADE !== '1') {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_ALLOW_MIGRATION_43_UPGRADE=1');
  }
  if (env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
  }
  const database = (env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
  if (database.length === 0) {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_REAL_DB_NAME');
  }
  const allowed = (env.E2E_ALLOWED_DB_NAMES ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length === 0) {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_ALLOWED_DB_NAMES');
  }
  if (allowed.length !== 1) {
    throw new Error('第 43 条实库规格拒绝执行：E2E_ALLOWED_DB_NAMES 必须是单一目标库');
  }
  if (allowed[0] !== database) {
    throw new Error(
      `第 43 条实库规格拒绝执行：单目标白名单 ${allowed[0]} 与 E2E_REAL_DB_NAME=${database} 不一致`,
    );
  }
  const configFile = (env.E2E_REAL_DB_CONFIG_FILE ?? '').trim();
  if (configFile.length === 0) {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_REAL_DB_CONFIG_FILE');
  }
  const serverUuid = (env.E2E_EXPECTED_SERVER_UUID ?? '').trim();
  if (serverUuid.length === 0) {
    throw new Error('第 43 条实库规格拒绝执行：缺少 E2E_EXPECTED_SERVER_UUID');
  }
  return { configFile, database, serverUuid };
};

/** 在规格自身实际连接上核验 DATABASE() 与 @@server_uuid。 */
export const assertM43ActualTarget = (
  target: M43Target,
  actual: { readonly database: string; readonly serverUuid: string },
): void => {
  if (actual.database.trim().toLowerCase() !== target.database) {
    throw new Error(
      `第 43 条实库规格拒绝执行：实际 DATABASE()=${actual.database}，与目标库 ${target.database} 不一致`,
    );
  }
  if (actual.serverUuid.trim() !== target.serverUuid) {
    throw new Error(
      `第 43 条实库规格拒绝执行：实际 server_uuid=${actual.serverUuid}，` +
        `与 E2E_EXPECTED_SERVER_UUID=${target.serverUuid} 不一致`,
    );
  }
};

const REQUESTED = process.env.E2E_REAL_DB_SPECS === '1';
const TARGET: M43Target | null = REQUESTED ? resolveM43Target(process.env) : null;

const requireTarget = (): M43Target => {
  if (!TARGET) {
    throw new Error('第 43 条实库规格未启用：拒绝访问目标配置与连接');
  }
  return TARGET;
};

const MIGRATION_42_TIMESTAMP = 1775502000000;
const MIGRATION_43_TIMESTAMP = 1775502100000;
const MIGRATION_43_NAME = 'AddRepairRequestRevisionPreviousVersionForV131775502100000';
const REVISION_TABLE = 'repair_request_revision';
const PREVIOUS_VERSION_CHECK = 'chk_repair_request_revision_previous_version';
const OLD_COLUMNS = [
  'id',
  'request_id',
  'revision_no',
  'before_snapshot',
  'after_snapshot',
  'schema_version',
  'actor_account_id',
  'reason',
  'created_at',
].join(', ');

const describeRealDb = TARGET ? describe : describe.skip;

const SNAPSHOT = JSON.stringify({ schema_version: 1 });

type Row = Record<string, unknown>;

const silentLogger: MigrationLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const plainRows = (rows: readonly Row[]): Row[] => JSON.parse(JSON.stringify(rows)) as Row[];

/**
 * INSERT 的 insertId 按无损字符串归一化后再校验为安全整数。
 * 本规格的夹具库由管理员预建，ID 规模远低于 2^53-1；仍显式拒绝越界而不是静默截断。
 */
const insertIdOf = (result: unknown, field: string): number => {
  const raw = (result as { insertId?: unknown }).insertId;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
    throw new Error(`INSERT 未返回有效 insertId（${field}）：${String(raw)}`);
  }
  const text = normalizeBigIntId(raw, `${field}.insertId`);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${field} 的 insertId 不是正整数：${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} 的 insertId 超出安全整数范围：${text}`);
  }
  return value;
};

interface SeededIds {
  readonly organizationId: number;
  readonly organizationCode: string;
  readonly organizationName: string;
  readonly accountId: number;
  readonly loginName: string;
  readonly loginEmail: string;
  readonly nickname: string;
  readonly equipmentModelId: number;
  readonly modelCode: string;
  readonly modelName: string;
  readonly historicalRequestId: number;
  readonly historicalRequestNo: string;
  readonly legalRequestId: number;
  readonly legalRequestNo: string;
  readonly equalRequestId: number;
  readonly equalRequestNo: string;
  readonly greaterRequestId: number;
  readonly greaterRequestNo: string;
  readonly historicalRevisionId: number;
  readonly errorCode: string;
  readonly faultDescription: string;
}

const state: {
  config: MigrationDbConfig | null;
  dataSource: DataSource | null;
  ledger: ReturnType<typeof createOwnedResourceLedger>;
  primaryError: unknown;
  hasPrimaryError: boolean;
  accountId: number | null;
  legalRequestId: number | null;
  equalRequestId: number | null;
  greaterRequestId: number | null;
  historicalRevisionId: number | null;
  historicalBefore: Row[];
} = {
  config: null,
  dataSource: null,
  ledger: createOwnedResourceLedger(),
  primaryError: null,
  hasPrimaryError: false,
  accountId: null,
  legalRequestId: null,
  equalRequestId: null,
  greaterRequestId: null,
  historicalRevisionId: null,
  historicalBefore: [],
};

const hasLedgerEntries = (): boolean =>
  state.ledger.organizationIds.length > 0 ||
  state.ledger.accountIds.length > 0 ||
  state.ledger.equipmentModelIds.length > 0 ||
  state.ledger.repairRequestIds.length > 0 ||
  state.ledger.repairRequestRevisionIds.length > 0;

/**
 * 创建 42 态允许的合法夹具：
 * - organization 与 equipment_model 均为工单 FK 的合法父行；
 * - base_user_account + base_user_info 为工单客户与修订人；
 * - repair_request 使用 customer/service organization 归属，intake_id 保持 NULL，
 *   满足 chk_repair_request_new_intake_companies；
 * - 历史修订行不含 previous_version（42 态尚无该列）。
 * 全部写入在同一事务内完成，提交后统一登记台账；失败则整体回滚且不登记。
 */
const seedFixtures = async (dataSource: DataSource): Promise<SeededIds> =>
  dataSource.transaction(async (manager): Promise<SeededIds> => {
    const tag = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const organizationCode = `M43ORG-${tag}`;
    const organizationName = `M43 组织 ${tag}`;
    const orgResult = await manager.query(
      `INSERT INTO organization (organization_code, name, kind, status)
       VALUES (?, ?, 'CLIENT', 'ACTIVE')`,
      [organizationCode, organizationName],
    );
    const organizationId = insertIdOf(orgResult, 'organization');

    const loginName = `m43_${tag}`;
    const loginEmail = `${loginName}@example.com`;
    const nickname = `${loginName}_nickname`;
    const accountResult = await manager.query(
      `INSERT INTO base_user_account (login_name, login_email, login_password, status, identity_hint)
       VALUES (?, ?, ?, 'ACTIVE', 'CUSTOMER')`,
      [loginName, loginEmail, 'M43Spec!Passw0rd'],
    );
    const accountId = insertIdOf(accountResult, 'base_user_account');
    await manager.query(
      `INSERT INTO base_user_info (account_id, nickname, email, access_group, user_state)
       VALUES (?, ?, ?, '["CUSTOMER"]', 'ACTIVE')`,
      [accountId, nickname, loginEmail],
    );

    const modelCode = `M43MDL-${tag}`;
    const modelName = `M43 机型 ${tag}`;
    const modelResult = await manager.query(
      `INSERT INTO equipment_model (model_code, model_name, enabled, sort_order)
       VALUES (?, ?, 1, 0)`,
      [modelCode, modelName],
    );
    const equipmentModelId = insertIdOf(modelResult, 'equipment_model');

    const errorCode = 'M43-ERR';
    const faultDescription = '第 43 条 previous_version 实库夹具';
    const insertRequest = async (suffix: string): Promise<number> => {
      const requestNo = `M43-${tag}-${suffix}`;
      const result = await manager.query(
        `INSERT INTO repair_request
           (request_no, customer_account_id, equipment_model_id, error_code, fault_description,
            content_md, customer_organization_id, service_organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requestNo,
          accountId,
          equipmentModelId,
          errorCode,
          faultDescription,
          '# M43 实库夹具',
          organizationId,
          organizationId,
        ],
      );
      return insertIdOf(result, 'repair_request');
    };

    const historicalRequestId = await insertRequest('H');
    const legalRequestId = await insertRequest('L');
    const equalRequestId = await insertRequest('E');
    const greaterRequestId = await insertRequest('G');

    const historicalRevisionResult = await manager.query(
      `INSERT INTO ${REVISION_TABLE}
         (request_id, revision_no, before_snapshot, after_snapshot, schema_version,
          actor_account_id, reason)
       VALUES (?, 1, ?, ?, 1, ?, ?)`,
      [historicalRequestId, SNAPSHOT, SNAPSHOT, accountId, `M43 historical ${randomUUID()}`],
    );
    const historicalRevisionId = insertIdOf(historicalRevisionResult, REVISION_TABLE);

    return {
      organizationId,
      organizationCode,
      organizationName,
      accountId,
      loginName,
      loginEmail,
      nickname,
      equipmentModelId,
      modelCode,
      modelName,
      historicalRequestId,
      historicalRequestNo: `M43-${tag}-H`,
      legalRequestId,
      legalRequestNo: `M43-${tag}-L`,
      equalRequestId,
      equalRequestNo: `M43-${tag}-E`,
      greaterRequestId,
      greaterRequestNo: `M43-${tag}-G`,
      historicalRevisionId,
      errorCode,
      faultDescription,
    };
  });

const registerSeededFixtures = (seeded: SeededIds): void => {
  recordOwnedResource(state.ledger, 'organization', seeded.organizationId, {
    organizationCode: seeded.organizationCode,
    name: seeded.organizationName,
    kind: 'CLIENT',
    status: 'ACTIVE',
  });
  recordOwnedResource(state.ledger, 'account', seeded.accountId, {
    loginName: seeded.loginName,
    loginEmail: seeded.loginEmail,
    status: 'ACTIVE',
    identityHint: 'CUSTOMER',
    accessGroup: ['CUSTOMER'],
    nickname: seeded.nickname,
    userInfoEmail: seeded.loginEmail,
    userState: 'ACTIVE',
  });
  recordOwnedResource(state.ledger, 'equipmentModel', seeded.equipmentModelId, {
    modelCode: seeded.modelCode,
    modelName: seeded.modelName,
    enabled: true,
    sortOrder: 0,
  });

  const registerRequest = (requestId: number, requestNo: string): void => {
    recordOwnedResource(state.ledger, 'repairRequest', requestId, {
      requestNo,
      customerAccountId: seeded.accountId,
      equipmentModelId: seeded.equipmentModelId,
      errorCode: seeded.errorCode,
      faultDescription: seeded.faultDescription,
    });
  };
  registerRequest(seeded.historicalRequestId, seeded.historicalRequestNo);
  registerRequest(seeded.legalRequestId, seeded.legalRequestNo);
  registerRequest(seeded.equalRequestId, seeded.equalRequestNo);
  registerRequest(seeded.greaterRequestId, seeded.greaterRequestNo);

  recordOwnedResource(state.ledger, 'repairRequestRevision', seeded.historicalRevisionId, {
    requestId: seeded.historicalRequestId,
    revisionNo: 1,
    actorAccountId: seeded.accountId,
    schemaVersion: 1,
  });
};

const insertRevision = async (
  dataSource: DataSource,
  input: {
    readonly requestId: number;
    readonly revisionNo: number;
    readonly previousVersion?: number;
  },
): Promise<number> => {
  const actorAccountId = state.accountId;
  if (actorAccountId === null) {
    throw new Error('台账缺少修订人账号 ID，拒绝写入修订行');
  }
  const columns = [
    'request_id',
    'revision_no',
    'before_snapshot',
    'after_snapshot',
    'schema_version',
    'actor_account_id',
    'reason',
  ];
  const values: unknown[] = [
    input.requestId,
    input.revisionNo,
    SNAPSHOT,
    SNAPSHOT,
    1,
    actorAccountId,
    `M43 previous_version ${randomUUID()}`,
  ];
  if (input.previousVersion !== undefined) {
    columns.push('previous_version');
    values.push(input.previousVersion);
  }
  const result = await dataSource.query(
    `INSERT INTO ${REVISION_TABLE} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
  return insertIdOf(result, REVISION_TABLE);
};

const registerRevision = (revisionId: number, requestId: number, revisionNo: number): void => {
  const actorAccountId = state.accountId;
  if (actorAccountId === null) {
    throw new Error('台账缺少修订人账号 ID，拒绝登记修订行');
  }
  recordOwnedResource(state.ledger, 'repairRequestRevision', revisionId, {
    requestId,
    revisionNo,
    actorAccountId,
    schemaVersion: 1,
  });
};

const selectHistoricalOldColumns = async (dataSource: DataSource): Promise<Row[]> => {
  if (state.historicalRevisionId === null) {
    throw new Error('历史修订 ID 未登记，拒绝查询');
  }
  const rows = (await dataSource.query(
    `SELECT ${OLD_COLUMNS} FROM ${REVISION_TABLE} WHERE id = ?`,
    [state.historicalRevisionId],
  )) as unknown as Row[];
  return plainRows(rows);
};

const requireId = (value: number | null, label: string): number => {
  if (value === null) {
    throw new Error(`${label}未登记，拒绝执行写入`);
  }
  return value;
};

const deployOptions = (): {
  readonly mode: 'upgrade';
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase: string;
} => {
  const target = requireTarget();
  return {
    mode: 'upgrade',
    envFile: target.configFile,
    database: target.database,
    confirmDatabase: target.database,
  };
};

describeRealDb('repair_request_revision.previous_version 实库验收', () => {
  beforeAll(async () => {
    const target = requireTarget();
    state.config = loadExplicitEnvConfig(target.configFile, target.database);
    assertAllowedE2eDatabase(state.config.database);
    const dataSource = createMigrationDataSource(state.config);
    await dataSource.initialize();
    state.dataSource = dataSource;

    await assertManagerOnExpectedE2eDatabase(dataSource.manager, target.database);
    const identityRows = (await dataSource.query(
      'SELECT @@server_uuid AS server_uuid, DATABASE() AS db',
    )) as unknown as Array<{ readonly server_uuid: string; readonly db: string }>;
    assertM43ActualTarget(target, {
      database: String(identityRows[0]?.db ?? ''),
      serverUuid: String(identityRows[0]?.server_uuid ?? ''),
    });
    const { history } = await readMigrationHistory(dataSource, target.database);
    const timestamps = new Set(history.map((entry) => entry.timestamp));
    if (!timestamps.has(MIGRATION_42_TIMESTAMP)) {
      throw new Error('目标库未到 42 态：缺少第 42 条迁移记录');
    }
    if (timestamps.has(MIGRATION_43_TIMESTAMP)) {
      throw new Error('目标库已到 43 态：本规格要求从未执行第 43 条的前置状态开始');
    }

    const seeded = await seedFixtures(dataSource);
    registerSeededFixtures(seeded);
    state.accountId = seeded.accountId;
    state.legalRequestId = seeded.legalRequestId;
    state.equalRequestId = seeded.equalRequestId;
    state.greaterRequestId = seeded.greaterRequestId;
    state.historicalRevisionId = seeded.historicalRevisionId;
    state.historicalBefore = await selectHistoricalOldColumns(dataSource);
  }, 60000);

  afterAll(async () => {
    const diagnostics: Error[] = [];

    if (state.dataSource && hasLedgerEntries()) {
      try {
        await runGuardedSpecCleanup({
          dataSource: state.dataSource,
          helper: 'repair_request_revision.previous_version/收尾',
          owned: state.ledger,
          expectedDatabase: requireTarget().database,
        });
      } catch (error) {
        diagnostics.push(new Error('台账精确清理失败', { cause: error }));
      }
    }

    if (state.dataSource) {
      try {
        await state.dataSource.destroy();
      } catch (error) {
        diagnostics.push(new Error('DataSource 关闭失败', { cause: error }));
      }
    }

    if (diagnostics.length > 0) {
      if (state.hasPrimaryError) {
        throw new AggregateError([state.primaryError, ...diagnostics], '主错误与收尾错误');
      }
      throw new AggregateError(diagnostics, '实库规格收尾失败');
    }
  }, 60000);

  it('正式入口升级后历史行 NULL 且旧字段不变；0→1、1→2 合法；等于/大于被 CHECK 拒绝', async () => {
    const dataSource = state.dataSource;
    if (!dataSource) {
      throw new Error('实库 DataSource 未初始化');
    }

    try {
      const report = await runDatabaseDeploy(deployOptions(), silentLogger);
      expect(report.mode).toBe('upgrade');
      expect(report.executed).toEqual([MIGRATION_43_NAME]);

      const history = await readMigrationHistory(dataSource, requireTarget().database);
      expect(history.history).toHaveLength(43);
      expect(history.history[42]?.timestamp).toBe(MIGRATION_43_TIMESTAMP);
      expect(history.history[42]?.name).toBe(MIGRATION_43_NAME);

      // 历史行：previous_version 必须为 NULL，其余旧字段与升级前逐字段一致。
      const historicalAfter = await selectHistoricalOldColumns(dataSource);
      expect(historicalAfter).toEqual(state.historicalBefore);
      const previousRows = (await dataSource.query(
        `SELECT previous_version FROM ${REVISION_TABLE} WHERE id = ?`,
        [state.historicalRevisionId],
      )) as unknown as Array<{ readonly previous_version: number | null }>;
      expect(previousRows).toHaveLength(1);
      expect(previousRows[0].previous_version).toBeNull();

      const legalRequestId = requireId(state.legalRequestId, '合法工单 ID');
      const equalRequestId = requireId(state.equalRequestId, '等于场景工单 ID');
      const greaterRequestId = requireId(state.greaterRequestId, '大于场景工单 ID');

      // 首版 0→1、后续 1→2 合法。
      const firstRevisionId = await insertRevision(dataSource, {
        requestId: legalRequestId,
        revisionNo: 1,
        previousVersion: 0,
      });
      registerRevision(firstRevisionId, legalRequestId, 1);

      const secondRevisionId = await insertRevision(dataSource, {
        requestId: legalRequestId,
        revisionNo: 2,
        previousVersion: 1,
      });
      registerRevision(secondRevisionId, legalRequestId, 2);

      // previous_version = revision_no 与 > revision_no 均命中指定 CHECK。
      await expect(
        insertRevision(dataSource, {
          requestId: equalRequestId,
          revisionNo: 2,
          previousVersion: 2,
        }),
      ).rejects.toThrow(PREVIOUS_VERSION_CHECK);

      await expect(
        insertRevision(dataSource, {
          requestId: greaterRequestId,
          revisionNo: 2,
          previousVersion: 3,
        }),
      ).rejects.toThrow(PREVIOUS_VERSION_CHECK);

      // 被拒绝的写入不得留下行。
      const rejectedResidue = (await dataSource.query(
        `SELECT COUNT(*) AS total FROM ${REVISION_TABLE}
          WHERE request_id IN (?, ?)`,
        [equalRequestId, greaterRequestId],
      )) as unknown as Array<{ readonly total: number | string }>;
      expect(Number(rejectedResidue[0]?.total ?? -1)).toBe(0);
    } catch (error) {
      state.primaryError = error;
      state.hasPrimaryError = true;
      throw error;
    }
  }, 60000);
});

describe('第 43 条实库规格启动门禁（离线）', () => {
  const base: NodeJS.ProcessEnv = {
    E2E_REAL_DB_SPECS: '1',
    E2E_ALLOW_MIGRATION_43_UPGRADE: '1',
    E2E_ALLOW_PHYSICAL_CLEANUP: '1',
    E2E_REAL_DB_NAME: 'lithography_v13_revision_upgrade43_final',
    E2E_ALLOWED_DB_NAMES: 'lithography_v13_revision_upgrade43_final',
    E2E_REAL_DB_CONFIG_FILE: '/secure/upgrade43.env',
    E2E_EXPECTED_SERVER_UUID: '909f9587-9fce-11f1-a353-00e0709ef3a9',
  };

  it('完整显式配置可解析', () => {
    expect(resolveM43Target(base)).toEqual({
      configFile: '/secure/upgrade43.env',
      database: 'lithography_v13_revision_upgrade43_final',
      serverUuid: '909f9587-9fce-11f1-a353-00e0709ef3a9',
    });
  });

  it.each([
    'E2E_REAL_DB_SPECS',
    'E2E_ALLOW_MIGRATION_43_UPGRADE',
    'E2E_ALLOW_PHYSICAL_CLEANUP',
    'E2E_REAL_DB_NAME',
    'E2E_ALLOWED_DB_NAMES',
    'E2E_REAL_DB_CONFIG_FILE',
    'E2E_EXPECTED_SERVER_UUID',
  ])('缺少 %s 时拒绝执行', (key) => {
    expect(() => resolveM43Target({ ...base, [key]: '' })).toThrow(/拒绝执行/);
  });

  it('多目标白名单拒绝执行', () => {
    expect(() =>
      resolveM43Target({
        ...base,
        E2E_ALLOWED_DB_NAMES: `${base.E2E_REAL_DB_NAME},lithography_other`,
      }),
    ).toThrow(/必须是单一目标库/);
  });

  it('白名单与目标不一致时拒绝执行', () => {
    expect(() => resolveM43Target({ ...base, E2E_ALLOWED_DB_NAMES: 'lithography_other' })).toThrow(
      /不一致/,
    );
  });

  it('实际 DATABASE() 不一致时拒绝执行', () => {
    const target = resolveM43Target(base);
    expect(() =>
      assertM43ActualTarget(target, {
        database: 'lithography_other',
        serverUuid: target.serverUuid,
      }),
    ).toThrow(/实际 DATABASE\(\)=lithography_other/);
  });

  it('实际 server_uuid 不一致时拒绝执行', () => {
    const target = resolveM43Target(base);
    expect(() =>
      assertM43ActualTarget(target, {
        database: target.database,
        serverUuid: '00000000-0000-0000-0000-000000000000',
      }),
    ).toThrow(/实际 server_uuid/);
  });
});
