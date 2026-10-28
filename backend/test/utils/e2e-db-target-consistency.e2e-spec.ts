// test/utils/e2e-db-target-consistency.e2e-spec.ts
//
// N04 / G04：真实两库、单会话切库的永久反例。
//
// 目的：证明“预期目标库”与“实际删除连接所在库”必须一致，且两个库都在白名单内也不能互相替代。
// - 使用独立实例上的两个临时 E2E 库：配置预期 = DB_NAME（lithography_e2e），另建探针库；
// - DataSource 仍是真实连接（连接池 1），在**同一会话**执行 USE 探针库，模拟切库；
// - 官方清理入口必须在任何 DELETE 之前拒绝；探针库中的合成目标行必须原样保留。
//
// M01—M03：探针库生命周期统一走 probe-database-lifecycle：
// - 启动先校验执行者许可，不自行授权；
// - 不带 IF NOT EXISTS 的 CREATE，只有明确成功才登记所有权；碰撞不 DROP；
// - afterAll 分步收尾，最早错误不覆盖，资源关闭/环境恢复独立尝试。
//
// 该用例不依赖 Proxy 伪造结果；Proxy 仅用于补充验证“事务内同一 manager 会话”校验。

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
} from './e2e-scoped-cleanup';
import {
  captureAndValidateProbeConsent,
  createOwnedProbeDatabase,
  dropOwnedProbeDatabase,
  formatProbeCreationCredential,
  ProbeDatabaseCollisionError,
  probeInstanceIdentity,
  restoreProbeConsent,
  runProbeLifecycleTeardown,
  type ProbeConsentSnapshot,
  type ProbeDatabaseOwnership,
  type ProbeRunScope,
} from './probe-database-lifecycle';

jest.setTimeout(120000);

const PROBE_DATABASE = 'lithography_e2e_probe';
const PROBE_ACCOUNT_ID = 990001;
const PROBE_LOGIN_NAME = 'g04_probe_account';
const PROBE_LOGIN_EMAIL = 'g04.probe@example.com';
const PROBE_NICKNAME = 'g04_probe_nickname';
const SHIFTED_DS_NAME = 'g04-shifted-single-connection';

let app: INestApplication | null = null;
let dataSource: DataSource;
let shiftedDataSource: DataSource | null = null;
let startupConsent: ProbeConsentSnapshot | null = null;
let probeOwnership: ProbeDatabaseOwnership | null = null;
let probeScope: ProbeRunScope | undefined;
let phase = 'starting';
let deleteCountBefore = -1;
let deleteCountAfter = -1;

const readDeleteCount = async (): Promise<number> => {
  const rows = await dataSource.query<Array<Record<string, unknown>>>(
    "SHOW GLOBAL STATUS LIKE 'Com_delete'",
  );
  return Number(rows[0]?.Value ?? -1);
};

const mainDatabaseName = (): string => {
  const configured = dataSource.options.database;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('G04 主 DataSource 缺少明确的 options.database，无法断言预期目标库');
  }
  return configured.trim();
};

const cloneSchemaToProbe = async (): Promise<void> => {
  const tables = await dataSource.query<Array<{ name: string }>>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  );
  for (const { name } of tables) {
    await dataSource.query(
      `CREATE TABLE \`${PROBE_DATABASE}\`.\`${name}\` LIKE \`${mainDatabaseName()}\`.\`${name}\``,
    );
  }
};

const createShiftedDataSource = (): DataSource => {
  const options = dataSource.options;
  const extra = (options as { extra?: Record<string, unknown> }).extra;
  return new DataSource({
    ...options,
    name: SHIFTED_DS_NAME,
    database: options.database,
    extra: { ...(extra ?? {}), connectionLimit: 1 },
  } as unknown as DataSourceOptions);
};

const seedProbeTarget = async (): Promise<void> => {
  if (!shiftedDataSource) {
    throw new Error('G04 探针 DataSource 未初始化');
  }
  await shiftedDataSource.query(`USE \`${PROBE_DATABASE}\``);
  await shiftedDataSource.query(
    `INSERT INTO base_user_account
       (id, login_name, login_email, login_password, status, identity_hint)
     VALUES (?, ?, ?, 'not-a-real-hash', 'ACTIVE', 'CUSTOMER')`,
    [PROBE_ACCOUNT_ID, PROBE_LOGIN_NAME, PROBE_LOGIN_EMAIL],
  );
  await shiftedDataSource.query(
    `INSERT INTO base_user_info (account_id, nickname, email, access_group, user_state)
     VALUES (?, ?, ?, ?, 'ACTIVE')`,
    [PROBE_ACCOUNT_ID, PROBE_NICKNAME, PROBE_LOGIN_EMAIL, JSON.stringify(['CUSTOMER'])],
  );
};

const probeLedger = () => {
  const ledger = createOwnedResourceLedger();
  recordOwnedResource(ledger, 'account', PROBE_ACCOUNT_ID, {
    loginName: PROBE_LOGIN_NAME,
    loginEmail: PROBE_LOGIN_EMAIL,
    status: 'ACTIVE',
    identityHint: 'CUSTOMER',
    accessGroup: ['CUSTOMER'],
    nickname: PROBE_NICKNAME,
    userInfoEmail: PROBE_LOGIN_EMAIL,
    userState: 'ACTIVE',
  });
  return ledger;
};

const readProbeAccount = async (): Promise<Array<Record<string, unknown>>> =>
  dataSource.query(
    `SELECT id, login_name, login_email FROM \`${PROBE_DATABASE}\`.base_user_account WHERE id = ?`,
    [PROBE_ACCOUNT_ID],
  );

describe('N04 预期/实际目标库一致性（真实两库单会话切库）', () => {
  beforeAll(async () => {
    // M02：许可必须先于应用初始化、DDL 和造数校验；缺失/0 直接失败关闭。
    try {
      startupConsent = captureAndValidateProbeConsent('G04');
    } catch (error) {
      phase = 'consent-rejected';
      throw error;
    }
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    phase = 'app-initialized';

    // M01：CREATE DATABASE（无 IF NOT EXISTS）；只有明确成功才产生本轮所有权。
    const injection = process.env.E2E_G04_INJECT?.trim();
    // Q01：父进程注入的运行标识与该实例范围一起绑定本次创建事实；
    // 没有标识时（独立运行 G04）不输出凭据，避免脱离具体运行的“可删授权”。
    const childRunId = process.env.E2E_G04_RUN_ID?.trim();
    probeScope = childRunId
      ? {
          runId: childRunId,
          target: PROBE_DATABASE,
          instance: probeInstanceIdentity(dataSource),
        }
      : undefined;
    const createTarget =
      injection === 'create-unknown'
        ? {
            query: (): Promise<never> => Promise.reject(new Error('G04 注入：CREATE 请求响应未知')),
          }
        : dataSource;
    try {
      probeOwnership = await createOwnedProbeDatabase(
        createTarget,
        PROBE_DATABASE,
        'G04',
        probeScope,
      );
    } catch (error) {
      phase = 'create-failed';
      console.log(
        `G04_OWNERSHIP=${error instanceof ProbeDatabaseCollisionError ? 'collision' : 'unknown'}`,
      );
      console.log(`G04_PROBE_TARGET=${PROBE_DATABASE}`);
      throw error;
    }
    phase = 'probe-owned';
    console.log('G04_OWNERSHIP=acquired');
    console.log(`G04_PROBE_TARGET=${PROBE_DATABASE}`);
    // 只在 CREATE 明确成功分支输出结构化创建凭据；普通日志文本不是删除授权。
    if (probeScope) {
      console.log(formatProbeCreationCredential({ ...probeScope, created: true }));
    }

    // 所有权明确后才允许把本轮必须的两个库放进局部白名单；afterAll 恢复启动原值。
    process.env.E2E_ALLOWED_DB_NAMES = `${mainDatabaseName()},${PROBE_DATABASE}`;

    if (injection === 'clone-failure') {
      console.log('G04_INJECTED=clone-failure');
      throw new Error('G04 注入：CREATE 成功后、克隆 schema 前失败');
    }

    await cloneSchemaToProbe();
    shiftedDataSource = createShiftedDataSource();
    await shiftedDataSource.initialize();
    await seedProbeTarget();
    phase = 'ready';
  });

  afterAll(async () => {
    console.log(`G04_AFTERALL_STATE=${phase}`);
    const injection = process.env.E2E_G04_INJECT?.trim();
    const dropTarget =
      injection === 'drop-unknown' && dataSource?.isInitialized
        ? {
            query: (sql: string, parameters?: unknown[]): Promise<unknown> =>
              /^DROP\s+DATABASE/i.test(sql.trim())
                ? Promise.reject(new Error('G04 注入：DROP 请求响应未知'))
                : dataSource.query(sql, parameters),
          }
        : dataSource;

    // M03：shifted 释放、探针 DROP、环境恢复、app 关闭各自独立尝试。
    await runProbeLifecycleTeardown('G04', {
      destroyShifted: async () => {
        if (shiftedDataSource?.isInitialized) {
          await shiftedDataSource.destroy();
        }
        console.log('G04_SHIFTED=destroyed');
      },
      dropProbe: async () => {
        if (!probeOwnership) {
          console.log('G04_DROP=skipped-not-owned');
          return;
        }
        try {
          const outcome = await dropOwnedProbeDatabase(
            dropTarget,
            probeOwnership,
            'G04',
            probeScope,
          );
          console.log(`G04_DROP=${outcome}`);
        } catch (error) {
          const causeMessage =
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : error instanceof Error
                ? error.message
                : String(error);
          console.log('G04_DROP=unknown');
          console.log(`G04_DROP_ERROR=${causeMessage}`);
          throw error;
        }
      },
      restoreEnv: () => {
        if (!startupConsent) {
          console.log('G04_ENV_RESTORED=not-needed');
          return;
        }
        restoreProbeConsent(startupConsent);
        console.log('G04_ENV_RESTORED=1');
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('G04_CLOSE=closed');
          return;
        }
        console.log('G04_CLOSE=no-app');
      },
    });
  });

  it('G04 两库均允许但会话已切至探针库：入口门禁拒绝，探针行原样保留，零 DELETE', async () => {
    if (!shiftedDataSource) {
      throw new Error('G04 探针 DataSource 未初始化');
    }
    deleteCountBefore = await readDeleteCount();
    await expect(
      runGuardedSpecCleanup({
        dataSource: shiftedDataSource,
        owned: probeLedger(),
        helper: 'G04 真实切库',
      }),
    ).rejects.toThrow(/预期目标库 "lithography_e2e" 与实际连接库 "lithography_e2e_probe" 不一致/);
    deleteCountAfter = await readDeleteCount();

    expect(deleteCountAfter - deleteCountBefore).toBe(0);
    expect(await readProbeAccount()).toEqual([
      {
        id: PROBE_ACCOUNT_ID,
        login_name: PROBE_LOGIN_NAME,
        login_email: PROBE_LOGIN_EMAIL,
      },
    ]);
  });

  it('G04b 入口连接返回预期库、事务会话实际在探针库：事务内同一 manager 校验拒绝且零 DELETE', async () => {
    if (!shiftedDataSource) {
      throw new Error('G04 探针 DataSource 未初始化');
    }
    const entrySaysExpected = new Proxy(shiftedDataSource, {
      get: (object, property, receiver) => {
        if (property === 'query') {
          return (sql: string, parameters?: unknown[]) =>
            /^SELECT\s+DATABASE\(\)/i.test(sql.trim())
              ? Promise.resolve([{ current_database: 'lithography_e2e' }])
              : object.query(sql, parameters);
        }
        return Reflect.get(object, property, receiver);
      },
    });
    const before = await readDeleteCount();
    await expect(
      runGuardedSpecCleanup({
        dataSource: entrySaysExpected,
        owned: probeLedger(),
        helper: 'G04b 事务内切库',
      }),
    ).rejects.toThrow(/预期目标库 "lithography_e2e" 与实际连接库 "lithography_e2e_probe" 不一致/);
    const after = await readDeleteCount();

    expect(after - before).toBe(0);
    expect(await readProbeAccount()).toHaveLength(1);
  });
});
