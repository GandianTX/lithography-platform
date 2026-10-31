import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { ADMIN_USER_ERROR } from '@core/common/errors/domain-error';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { FieldEncryptionSubscriber } from '@src/infrastructure/field-encryption/field-encryption.subscriber';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { AccountService } from '@src/modules/account/base/services/account.service';
import type { AdminUserView } from '@src/modules/account/account.types';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { AccountUsecasesModule } from '@src/usecases/account/account-usecases.module';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import { join } from 'path';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  assertFixtureIdsAvailable,
  finalizeFixtureTeardown,
  prepareFixtureSetup,
} from '../../../test/utils/e2e-owned-fixture';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedAccountFacts,
  type OwnedMembershipFacts,
  type OwnedResourceLedger,
} from '../../../test/utils/e2e-scoped-cleanup';
import { runTwoBranchTransactionRace } from '../../../test/utils/upload-race-runner';
import { AdminSetUserStatusUsecase } from './admin-set-user-status.usecase';

/**
 * 管理员启停链路真实 MySQL 并发验收。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   ADMIN_USER_STATUS_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/usecases/account/admin-set-user-status.concurrency.integration.spec.ts --runInBand
 *
 * 覆盖 P1「锁后读取」与 P2 场景 A / B / 跨组织：
 * - A 持锁停用并等待，B 请求启用并阻塞在同一行锁上，A 提交后 B 必须读到最新状态并真正启用；
 * - B 与 A 请求同一状态时，B 必须幂等成功且不重复更新，`updatedAt` 保持 A 提交后的值；
 * - 跨组织管理员操作目标仍返回 `TARGET_NOT_FOUND`，目标零修改。
 *
 * 竞争同步点来自真实锁等待（performance_schema.data_lock_waits），不使用固定 sleep。
 * 两个连接分别由竞争执行器创建，未完成事务在 finally 中回滚，连接必释放，分支错误与
 * 收尾错误分别保留。
 *
 * 夹具策略：环境门禁全部通过后才写入；固定 ID 创建前查重；每个夹具创建成功后立即按
 * 实际主键登记；合法状态变更在提交后显式更新预期事实；清理只按登记资源精确删除。
 */
const ENABLED = process.env.ADMIN_USER_STATUS_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ROUND_TAG = 'ADMIN-STATUS-CONC';
const PRIMARY_ORGANIZATION_ID = 9710001;
const PRIMARY_ORGANIZATION_CODE = 'CONC-ADMIN-STATUS-PRIMARY';
const CROSS_ORGANIZATION_ID = 9710002;
const CROSS_ORGANIZATION_CODE = 'CONC-ADMIN-STATUS-CROSS';
const ADMIN_ACCOUNT_ID = 9710101;
const TARGET_A_ACCOUNT_ID = 9710102;
const TARGET_B_ACCOUNT_ID = 9710103;
const TARGET_CROSS_ACCOUNT_ID = 9710104;
/** 失败路径回归专用账号：每个用例一个，绝不与并发夹具复用。 */
const FAILURE_USER_INFO_ACCOUNT_ID = 9710201;
const FAILURE_MEMBERSHIP_ACCOUNT_ID = 9710202;
const FAILURE_SUCCESS_ACCOUNT_ID = 9710203;
const FAILURE_ROLLBACK_ACCOUNT_ID = 9710204;
const FAILURE_DESTROY_ACCOUNT_ID = 9710205;
const FAILURE_RELEASE_ACCOUNT_ID = 9710206;
/** 中途断言失败仍收尾回归专用账号：销毁路径与释放路径各一个。 */
const FAILURE_ASSERTION_DESTROY_ACCOUNT_ID = 9710207;
const FAILURE_ASSERTION_RELEASE_ACCOUNT_ID = 9710208;
const FAILURE_ACCOUNT_IDS = [
  FAILURE_USER_INFO_ACCOUNT_ID,
  FAILURE_MEMBERSHIP_ACCOUNT_ID,
  FAILURE_SUCCESS_ACCOUNT_ID,
  FAILURE_ROLLBACK_ACCOUNT_ID,
  FAILURE_DESTROY_ACCOUNT_ID,
  FAILURE_RELEASE_ACCOUNT_ID,
  FAILURE_ASSERTION_DESTROY_ACCOUNT_ID,
  FAILURE_ASSERTION_RELEASE_ACCOUNT_ID,
];
const ALL_FIXTURE_ACCOUNT_IDS = [
  ADMIN_ACCOUNT_ID,
  TARGET_A_ACCOUNT_ID,
  TARGET_B_ACCOUNT_ID,
  TARGET_CROSS_ACCOUNT_ID,
  ...FAILURE_ACCOUNT_IDS,
];
const FIXTURE_PASSWORD = 'fixture-login-password-hash';

const ADMIN_SESSION: UsecaseSession = {
  accountId: ADMIN_ACCOUNT_ID,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
};

jest.setTimeout(180_000);

describeIntegration('管理员启停真实并发验收（锁后读取）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let accountService: AccountService;
  let adminUserQueryService: AdminUserQueryService;
  let organizationContextQueryService: TrustedOrganizationContextQueryService;
  let organizationMembershipQueryService: OrganizationMembershipQueryService;
  let crossOrganizationUsecase: AdminSetUserStatusUsecase;
  let setupAllowed = false;
  let expectedDatabase = '';
  const ledger = createOwnedResourceLedger();

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query<T[]>(sql, parameters);

  const readLockWaiterCount = async (): Promise<number> => {
    const rows = await query<{ total: number | string }>(
      'SELECT COUNT(DISTINCT REQUESTING_THREAD_ID) AS total FROM performance_schema.data_lock_waits',
    );
    return Number(rows[0]?.total ?? 0);
  };

  const waitForLockWaiters = async (expected: number, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
      observed = await readLockWaiterCount();
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待锁竞争超时：期望 ${expected} 个等待者，实际观察到 ${observed} 个。`);
  };

  const assertFixtureNaturalKeysAvailable = async (): Promise<void> => {
    const organizationRows = await query<{ id: number }>(
      'SELECT id FROM organization WHERE organization_code IN (?, ?)',
      [PRIMARY_ORGANIZATION_CODE, CROSS_ORGANIZATION_CODE],
    );
    if (organizationRows.length > 0) {
      throw new Error(
        `组织夹具编码已被占用（${organizationRows.map((row) => row.id).join(', ')}）`,
      );
    }
    const accountRows = await query<{ id: number }>(
      'SELECT id FROM base_user_account WHERE id IN (?, ?, ?, ?)',
      [ADMIN_ACCOUNT_ID, TARGET_A_ACCOUNT_ID, TARGET_B_ACCOUNT_ID, TARGET_CROSS_ACCOUNT_ID],
    );
    if (accountRows.length > 0) {
      throw new Error(`账号夹具 ID 已被占用（${accountRows.map((row) => row.id).join(', ')}）`);
    }
  };

  const insertOrganization = async (params: {
    id: number;
    code: string;
    name: string;
  }): Promise<void> => {
    await query(
      'INSERT INTO organization (id, organization_code, name, kind, status) VALUES (?, ?, ?, ?, ?)',
      [params.id, params.code, params.name, 'CLIENT', 'ACTIVE'],
    );
    recordOwnedResource(ledger, 'organization', params.id, {
      organizationCode: params.code,
      name: params.name,
      kind: 'CLIENT',
      status: 'ACTIVE',
    });
  };

  /**
   * 失败路径回归的故障注入点：只在测试内生效，不改变业务代码。
   * 回滚/销毁/释放失败一律通过 `onRunnerReady` 对真实驱动方法打替身，不使用布尔开关。
   */
  type FixtureCreationFaults = {
    readonly failBeforeUserInfoInsert?: Error;
    readonly failBeforeMembershipInsert?: Error;
    readonly onRunnerReady?: (runner: QueryRunner) => void;
  };

  type PendingFixtureFact =
    | { readonly kind: 'account'; readonly id: number; readonly facts: OwnedAccountFacts }
    | { readonly kind: 'membership'; readonly id: number; readonly facts: OwnedMembershipFacts };

  interface FixtureAccountParams {
    readonly accountId: number;
    readonly loginName: string;
    readonly loginEmail: string;
    readonly nickname: string;
    readonly role: IdentityTypeEnum;
    readonly organizationId: number;
    readonly memberRole: IdentityTypeEnum;
  }

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /** 按阶段保留的收尾错误：创建、回滚、销毁、释放互不覆盖。 */
  interface CollectedFixtureError {
    readonly stage: '创建' | '回滚' | '销毁' | '释放';
    readonly error: unknown;
  }

  const formatCollectedFixtureErrors = (errors: readonly CollectedFixtureError[]): string =>
    errors.map((item) => `${item.stage}错误=${describeError(item.error)}`).join('；');

  /**
   * 销毁本轮独占连接（驱动为 mysql2 时是 `PoolConnection.destroy()`）。
   * 未提交事务随连接断开由数据库回滚；只调用 `release()` 会把仍活动的事务归还连接池。
   * 共享连接池（带 `getConnection`）与其它测试连接绝不在此销毁。
   */
  const destroyRunnerConnection = async (runner: QueryRunner): Promise<void> => {
    const connection = (
      runner as unknown as {
        databaseConnection?: { destroy?: () => Promise<void>; getConnection?: unknown };
      }
    ).databaseConnection;
    if (connection === undefined || connection === null) {
      return;
    }
    if (typeof connection.getConnection === 'function') {
      throw new Error('拒绝销毁共享连接池：只允许销毁本轮独占连接');
    }
    if (typeof connection.destroy !== 'function') {
      throw new Error('当前驱动不支持 destroy，无法安全关闭本轮连接');
    }
    await connection.destroy();
  };

  /** 事务内成员关系插入：返回数据库真实 ID 与显式创建事实，不在此处登记账本。 */
  const insertMembershipInTransaction = async (
    runner: QueryRunner,
    params: { organizationId: number; accountId: number; memberRole: IdentityTypeEnum },
  ): Promise<{ id: number; facts: OwnedMembershipFacts }> => {
    await runner.query(
      `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
       VALUES (?, ?, ?, ?)`,
      [params.organizationId, params.accountId, params.memberRole, 'ACTIVE'],
    );
    const rows = (await runner.query(
      `SELECT id FROM organization_membership
        WHERE organization_id = ? AND account_id = ? AND status = 'ACTIVE'`,
      [params.organizationId, params.accountId],
    )) as Array<{ id: number }>;
    const membershipId = Number(rows[0]?.id);
    if (!Number.isInteger(membershipId) || membershipId <= 0) {
      throw new Error(
        `成员关系创建后回读失败：组织 ${params.organizationId} / 账号 ${params.accountId}`,
      );
    }
    return {
      id: membershipId,
      facts: {
        organizationId: params.organizationId,
        accountId: params.accountId,
        memberRole: params.memberRole,
        status: 'ACTIVE',
      },
    };
  };

  /**
   * 原子创建账号夹具：账号、用户资料与成员关系在同一事务连接内创建。
   *
   * - 任一步失败整体回滚，**没有**任何直接 DELETE 的补偿分支；
   * - 各步成功后先写入本地 pending（真实 ID + 显式创建事实），提交成功后才转入清理账本；
   * - 资料创建走域内入口但注入同一事务上下文，绝不在事务内另开连接；
   * - **提交成功后先登记，再释放连接**；释放失败会让 helper 拒绝成功，但已登记资源保留给受保护清理；
   * - 回滚失败（真实异常或替身异常）统一走销毁路径，销毁失败不覆盖原始错误；
   * - 创建、回滚、销毁、释放错误分别保留，按阶段汇总抛出；
   * - 提交结果不明确时保留 pending 与事实并报告，既不删除也不宣称零残留。
   */
  const createAccountFixtureAtomically = async (
    params: FixtureAccountParams,
    faults: FixtureCreationFaults = {},
    targetLedger: OwnedResourceLedger = ledger,
  ): Promise<void> => {
    const runner = dataSource.createQueryRunner();
    const pending: PendingFixtureFact[] = [];
    const collectedErrors: CollectedFixtureError[] = [];
    let connected = false;
    let commitAttempted = false;
    let committed = false;

    try {
      await runner.connect();
      connected = true;
      faults.onRunnerReady?.(runner);
      await runner.startTransaction();
      const transactionContext = createTypeOrmPersistenceTransactionContext(runner.manager);

      await runner.query(
        `INSERT INTO base_user_account
           (id, login_name, login_email, login_password, status, identity_hint)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          params.accountId,
          params.loginName,
          params.loginEmail,
          FIXTURE_PASSWORD,
          AccountStatus.ACTIVE,
          params.role,
        ],
      );
      pending.push({
        kind: 'account',
        id: params.accountId,
        facts: {
          loginName: params.loginName,
          loginEmail: params.loginEmail,
          status: AccountStatus.ACTIVE,
          identityHint: params.role,
          accessGroup: [params.role],
          nickname: params.nickname,
          userInfoEmail: params.loginEmail,
          userState: UserState.ACTIVE,
        },
      });

      if (faults.failBeforeUserInfoInsert !== undefined) {
        throw faults.failBeforeUserInfoInsert;
      }
      await accountService.insertUserInfo({
        userInfoData: {
          accountId: params.accountId,
          nickname: params.nickname,
          email: params.loginEmail,
          accessGroup: [params.role],
          metaDigest: [params.role],
          userState: UserState.ACTIVE,
        },
        transactionContext,
      });

      if (faults.failBeforeMembershipInsert !== undefined) {
        throw faults.failBeforeMembershipInsert;
      }
      const membership = await insertMembershipInTransaction(runner, params);
      pending.push({ kind: 'membership', ...membership });

      commitAttempted = true;
      await runner.commitTransaction();
      committed = true;
    } catch (error) {
      collectedErrors.push({ stage: '创建', error });
    }

    if (committed) {
      // 提交已明确成功：先把全部资源与事实登记入账，再尝试释放
      for (const item of pending) {
        if (item.kind === 'account') {
          recordOwnedResource(targetLedger, 'account', item.id, item.facts);
        } else {
          recordOwnedResource(targetLedger, 'membership', item.id, item.facts);
        }
      }
      let releaseError: unknown = undefined;
      try {
        await runner.release();
      } catch (releaseFailure) {
        releaseError = releaseFailure;
      }
      if (releaseError !== undefined) {
        throw new AggregateError(
          [releaseError],
          `账号夹具 ${params.accountId} 已提交并完成登记，但连接释放失败：` +
            `${describeError(releaseError)}；资源交由受保护清理回收`,
        );
      }
      return;
    }

    // 失败或提交结果不明确：按连接实际事务状态回滚
    if (runner.isTransactionActive === true) {
      try {
        await runner.rollbackTransaction();
      } catch (rollbackFailure) {
        collectedErrors.push({ stage: '回滚', error: rollbackFailure });
      }
    }

    const rollbackFailed = collectedErrors.some((item) => item.stage === '回滚');
    if (rollbackFailed) {
      // 回滚失败：销毁本轮连接，绝不把可能仍活动的事务以普通 release 归还池
      try {
        await destroyRunnerConnection(runner);
      } catch (destroyFailure) {
        collectedErrors.push({ stage: '销毁', error: destroyFailure });
      }
    } else if (connected) {
      try {
        await runner.release();
      } catch (releaseFailure) {
        collectedErrors.push({ stage: '释放', error: releaseFailure });
      }
    }

    if (commitAttempted) {
      const message =
        `账号夹具 ${params.accountId} 提交结果不明确：保留已知资源与事实并报告，` +
        `不执行删除，也不宣称零残留。pending=${JSON.stringify(pending)}；` +
        formatCollectedFixtureErrors(collectedErrors);
      if (pending.length > 0) {
        ambiguousFixtureCreation = message;
      }
      throw new AggregateError(
        collectedErrors.map((item) => item.error),
        message,
      );
    }

    throw new AggregateError(
      collectedErrors.length > 0
        ? collectedErrors.map((item) => item.error)
        : [new Error('未知夹具创建失败')],
      `账号夹具 ${params.accountId} 创建失败，事务已按实际状态收尾：` +
        formatCollectedFixtureErrors(collectedErrors),
    );
  };

  /** 兼容既有调用点：原子创建（默认写入主账本）。 */
  const insertAccountFixture = createAccountFixtureAtomically;

  /** 提交结果不明确的报告文本；非空表示本轮无法宣称零残留。 */
  let ambiguousFixtureCreation: string | null = null;

  const readDatabaseStatus = async (
    accountId: number,
  ): Promise<{
    status: string;
    userState: string;
    accountUpdatedAt: Date;
    userInfoUpdatedAt: Date;
  }> => {
    const rows = await query<{
      status: string;
      user_state: string;
      account_updated_at: Date;
      user_info_updated_at: Date;
    }>(
      `SELECT a.status, ui.user_state,
              a.updated_at AS account_updated_at, ui.updated_at AS user_info_updated_at
         FROM base_user_account a
         JOIN base_user_info ui ON ui.account_id = a.id
        WHERE a.id = ?`,
      [accountId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`账号 ${accountId} 状态回读失败：行不存在`);
    }
    return {
      status: row.status,
      userState: row.user_state,
      accountUpdatedAt: new Date(row.account_updated_at),
      userInfoUpdatedAt: new Date(row.user_info_updated_at),
    };
  };

  const createBranchUsecase = (runner: QueryRunner): AdminSetUserStatusUsecase => {
    const transactionContext = createTypeOrmPersistenceTransactionContext(runner.manager);
    const transactionRunner: TransactionRunner = {
      run: async <T>(
        callback: (context: PersistenceTransactionContext) => Promise<T>,
      ): Promise<T> => callback(transactionContext),
    };
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    } as unknown as PinoLogger;
    return new AdminSetUserStatusUsecase(
      accountService,
      adminUserQueryService,
      organizationContextQueryService,
      organizationMembershipQueryService,
      logger,
      transactionRunner,
    );
  };

  const executeInBranch = async (
    runner: QueryRunner,
    accountId: number,
    status: AccountStatus.ACTIVE | AccountStatus.INACTIVE,
  ) => createBranchUsecase(runner).execute({ session: ADMIN_SESSION, accountId, status });

  const recordCommittedStatus = (
    accountId: number,
    status: AccountStatus.ACTIVE | AccountStatus.INACTIVE,
  ): void => {
    updateOwnedExpectation(ledger, 'account', accountId, {
      status,
      userState: status === AccountStatus.ACTIVE ? UserState.ACTIVE : UserState.INACTIVE,
    });
  };

  const countKeepRows = async (): Promise<{
    organizations: number;
    accounts: number;
    userInfos: number;
    memberships: number;
  }> => {
    const rows = await query<{
      organizations: number;
      accounts: number;
      user_infos: number;
      memberships: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM organization) AS organizations,
         (SELECT COUNT(*) FROM base_user_account) AS accounts,
         (SELECT COUNT(*) FROM base_user_info) AS user_infos,
         (SELECT COUNT(*) FROM organization_membership) AS memberships`,
    );
    const row = rows[0];
    if (!row) throw new Error('KEEP 基线计数读取失败');
    return {
      organizations: Number(row.organizations),
      accounts: Number(row.accounts),
      userInfos: Number(row.user_infos),
      memberships: Number(row.memberships),
    };
  };

  let keepBaseline: Promise<Awaited<ReturnType<typeof countKeepRows>>> | null = null;

  beforeAll(async () => {
    const declared = process.env.ADMIN_USER_STATUS_INTEGRATION_DATABASE ?? 'lithography_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              FIELD_ENCRYPTION_KEY: 'admin-status-key-16x',
              FIELD_ENCRYPTION_IV: 'admin-status-iv-16x',
            }),
          ],
        }),
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
        AccountUsecasesModule,
      ],
    }).compile();
    // 触发 OnModuleInit：账户字段加密注册器只在初始化阶段登记加密列元数据，
    // 未初始化时 `meta_digest` 不会被加密/解密，三源角色收敛失败关闭。
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    /**
     * 本规格自建 DataSource 以注入隔离库配置，因此不经过 `DatabaseModule` 的订阅者装配
     * （`DatabaseSubscriberInitializer`）。必须在这里按生产同源挂载字段加密订阅者：
     * 未挂载时 `meta_digest` 会以明文写入 varchar 列，三源角色收敛失败关闭。
     */
    const fieldEncryptionSubscriber = moduleRef.get(FieldEncryptionSubscriber, { strict: false });
    if (!dataSource.subscribers.includes(fieldEncryptionSubscriber)) {
      dataSource.subscribers.push(fieldEncryptionSubscriber);
    }
    // 环境门禁全部通过后才允许读取/写入夹具
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    expectedDatabase = gate.database;
    // 门禁通过即允许清理：后续任一步写入成功后失败，afterAll 都必须能回收已登记资源
    setupAllowed = true;

    accountService = moduleRef.get(AccountService, { strict: false });
    adminUserQueryService = moduleRef.get(AdminUserQueryService, { strict: false });
    organizationContextQueryService = moduleRef.get(TrustedOrganizationContextQueryService, {
      strict: false,
    });
    organizationMembershipQueryService = moduleRef.get(OrganizationMembershipQueryService, {
      strict: false,
    });
    crossOrganizationUsecase = moduleRef.get(AdminSetUserStatusUsecase, { strict: false });

    await assertFixtureNaturalKeysAvailable();
    await assertFixtureIdsAvailable(
      dataSource,
      'organization',
      [PRIMARY_ORGANIZATION_ID, CROSS_ORGANIZATION_ID],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'base_user_account',
      ALL_FIXTURE_ACCOUNT_IDS,
      ROUND_TAG,
    );

    keepBaseline = countKeepRows();

    await insertOrganization({
      id: PRIMARY_ORGANIZATION_ID,
      code: PRIMARY_ORGANIZATION_CODE,
      name: '管理员启停并发主组织',
    });
    await insertOrganization({
      id: CROSS_ORGANIZATION_ID,
      code: CROSS_ORGANIZATION_CODE,
      name: '管理员启停并发跨组织',
    });

    await insertAccountFixture({
      accountId: ADMIN_ACCOUNT_ID,
      loginName: 'conc-admin-status-admin',
      loginEmail: 'conc.admin.status.admin@example.com',
      nickname: 'conc_admin_status_admin',
      role: IdentityTypeEnum.SUPER_ADMIN,
      organizationId: PRIMARY_ORGANIZATION_ID,
      memberRole: IdentityTypeEnum.SUPER_ADMIN,
    });
    await insertAccountFixture({
      accountId: TARGET_A_ACCOUNT_ID,
      loginName: 'conc-admin-status-a',
      loginEmail: 'conc.admin.status.a@example.com',
      nickname: 'conc_admin_status_a',
      role: IdentityTypeEnum.CUSTOMER,
      organizationId: PRIMARY_ORGANIZATION_ID,
      memberRole: IdentityTypeEnum.CUSTOMER,
    });
    await insertAccountFixture({
      accountId: TARGET_B_ACCOUNT_ID,
      loginName: 'conc-admin-status-b',
      loginEmail: 'conc.admin.status.b@example.com',
      nickname: 'conc_admin_status_b',
      role: IdentityTypeEnum.CUSTOMER,
      organizationId: PRIMARY_ORGANIZATION_ID,
      memberRole: IdentityTypeEnum.CUSTOMER,
    });
    await insertAccountFixture({
      accountId: TARGET_CROSS_ACCOUNT_ID,
      loginName: 'conc-admin-status-cross',
      loginEmail: 'conc.admin.status.cross@example.com',
      nickname: 'conc_admin_status_cross',
      role: IdentityTypeEnum.CUSTOMER,
      organizationId: CROSS_ORGANIZATION_ID,
      memberRole: IdentityTypeEnum.CUSTOMER,
    });

    // 夹具可用性前置：三源角色必须能收敛，否则后续并发断言会误判为实现失败
    for (const accountId of [
      ADMIN_ACCOUNT_ID,
      TARGET_A_ACCOUNT_ID,
      TARGET_B_ACCOUNT_ID,
      TARGET_CROSS_ACCOUNT_ID,
    ]) {
      try {
        const view = await adminUserQueryService.findAdminUserViewById({ accountId });
        if (view === null) {
          throw new Error(`夹具账号 ${accountId} 创建后无法生成管理视图`);
        }
      } catch (error) {
        throw new Error(`夹具账号 ${accountId} 角色三源不可收敛：${(error as Error).message}`, {
          cause: error,
        });
      }
    }

    setupAllowed = true;
  });

  afterAll(async () => {
    await finalizeFixtureTeardown({
      steps: [
        {
          label: `清理夹具（目标库 ${expectedDatabase || '(未确认)'}）`,
          run: async () => {
            if (!setupAllowed) return;
            await runGuardedSpecCleanup({
              dataSource,
              helper: 'admin-set-user-status.concurrency.integration.spec',
              owned: ledger,
              expectedDatabase,
            });
          },
        },
        {
          label: '核验夹具零残留',
          run: async () => {
            if (!setupAllowed) return;
            const rows = await query<{
              organizations: number;
              accounts: number;
              user_infos: number;
              memberships: number;
            }>(
              `SELECT
                 (SELECT COUNT(*) FROM organization WHERE id IN (?, ?)) AS organizations,
                 (SELECT COUNT(*) FROM base_user_account WHERE id IN (?)) AS accounts,
                 (SELECT COUNT(*) FROM base_user_info WHERE account_id IN (?)) AS user_infos,
                 (SELECT COUNT(*) FROM organization_membership WHERE account_id IN (?)) AS memberships`,
              [
                PRIMARY_ORGANIZATION_ID,
                CROSS_ORGANIZATION_ID,
                ALL_FIXTURE_ACCOUNT_IDS,
                ALL_FIXTURE_ACCOUNT_IDS,
                ALL_FIXTURE_ACCOUNT_IDS,
              ],
            );
            const row = rows[0];
            const residue = {
              organizations: Number(row?.organizations ?? -1),
              accounts: Number(row?.accounts ?? -1),
              userInfos: Number(row?.user_infos ?? -1),
              memberships: Number(row?.memberships ?? -1),
            };
            if (ambiguousFixtureCreation !== null) {
              // 提交结果不明确：保留已知资源与事实并报告，不得宣称零残留
              throw new Error(`${ambiguousFixtureCreation}；当前残留=${JSON.stringify(residue)}`);
            }
            if (Object.values(residue).some((count) => count !== 0)) {
              throw new Error(`夹具残留未清空：${JSON.stringify(residue)}`);
            }
          },
        },
        {
          label: '核验 KEEP 数据不变',
          run: async () => {
            if (!setupAllowed) return;
            if (keepBaseline === null) {
              throw new Error('KEEP 基线未建立，无法判定外部数据是否被改动');
            }
            const baseline = await keepBaseline;
            const current = await countKeepRows();
            if (JSON.stringify(current) !== JSON.stringify(baseline)) {
              throw new Error(
                `KEEP 数据发生变化：基线 ${JSON.stringify(baseline)}，当前 ${JSON.stringify(current)}`,
              );
            }
          },
        },
        {
          label: '关闭数据源',
          run: async () => {
            await moduleRef?.close();
          },
        },
      ],
    });
  });

  it('场景 A：A 持锁停用，B 请求启用等待后真正启用，返回状态与数据库一致', async () => {
    const targetAccountId = TARGET_A_ACCOUNT_ID;
    const race = await runTwoBranchTransactionRace<AdminUserView>({
      createRunner: () => dataSource.createQueryRunner(),
      runFirst: (runner) => executeInBranch(runner, targetAccountId, AccountStatus.INACTIVE),
      runSecond: (runner) => executeInBranch(runner, targetAccountId, AccountStatus.ACTIVE),
      waitForCompetition: () => waitForLockWaiters(1),
      onFirstCommitted: () => {
        recordCommittedStatus(targetAccountId, AccountStatus.INACTIVE);
        return Promise.resolve();
      },
      onSecondCommitted: () => {
        recordCommittedStatus(targetAccountId, AccountStatus.ACTIVE);
        return Promise.resolve();
      },
    });

    // 分支错误与回滚/释放错误全部保留：任一非空即失败
    expect(race.errors).toEqual([]);
    expect(race.first.status).toBe('fulfilled');
    expect(race.second.status).toBe('fulfilled');
    if (race.first.status !== 'fulfilled' || race.second.status !== 'fulfilled') {
      throw new Error('场景 A 分支未成功完成');
    }
    expect(race.first.value.status).toBe(AccountStatus.INACTIVE);
    expect(race.second.value.status).toBe(AccountStatus.ACTIVE);

    const database = await readDatabaseStatus(targetAccountId);
    expect(database.status).toBe(AccountStatus.ACTIVE);
    expect(database.userState).toBe(UserState.ACTIVE);
    // 返回状态与数据库一致
    expect(race.second.value.status).toBe(database.status);
  });

  it('场景 B：A 持锁停用，B 同样请求停用时幂等成功，updatedAt 保持 A 提交后的值', async () => {
    const targetAccountId = TARGET_B_ACCOUNT_ID;
    const race = await runTwoBranchTransactionRace<AdminUserView>({
      createRunner: () => dataSource.createQueryRunner(),
      runFirst: (runner) => executeInBranch(runner, targetAccountId, AccountStatus.INACTIVE),
      runSecond: (runner) => executeInBranch(runner, targetAccountId, AccountStatus.INACTIVE),
      waitForCompetition: () => waitForLockWaiters(1),
      onFirstCommitted: () => {
        recordCommittedStatus(targetAccountId, AccountStatus.INACTIVE);
        return Promise.resolve();
      },
      onSecondCommitted: () => {
        recordCommittedStatus(targetAccountId, AccountStatus.INACTIVE);
        return Promise.resolve();
      },
    });

    expect(race.errors).toEqual([]);
    expect(race.first.status).toBe('fulfilled');
    expect(race.second.status).toBe('fulfilled');
    if (race.first.status !== 'fulfilled' || race.second.status !== 'fulfilled') {
      throw new Error('场景 B 分支未成功完成');
    }
    expect(race.first.value.status).toBe(AccountStatus.INACTIVE);
    expect(race.second.value.status).toBe(AccountStatus.INACTIVE);

    const database = await readDatabaseStatus(targetAccountId);
    expect(database.status).toBe(AccountStatus.INACTIVE);
    expect(database.userState).toBe(UserState.INACTIVE);

    // B 读到锁内最新状态后走幂等分支：不执行 UPDATE，updatedAt 与 A 提交后完全一致
    const latest = Math.max(
      database.accountUpdatedAt.getTime(),
      database.userInfoUpdatedAt.getTime(),
    );
    expect(race.first.value.updatedAt.getTime()).toBe(latest);
    expect(race.second.value.updatedAt.getTime()).toBe(latest);
    expect(race.second.value.updatedAt.getTime()).toBe(race.first.value.updatedAt.getTime());
  });

  it('跨组织管理员操作目标：仍返回 TARGET_NOT_FOUND，目标零修改', async () => {
    const targetAccountId = TARGET_CROSS_ACCOUNT_ID;
    const before = await readDatabaseStatus(targetAccountId);

    const error = await crossOrganizationUsecase
      .execute({
        session: ADMIN_SESSION,
        accountId: targetAccountId,
        status: AccountStatus.INACTIVE,
      })
      .then(
        () => {
          throw new Error('预期跨组织操作被拒绝，但调用成功');
        },
        (reason: unknown) => reason,
      );

    expect(error).toMatchObject({ code: ADMIN_USER_ERROR.TARGET_NOT_FOUND });
    const after = await readDatabaseStatus(targetAccountId);
    expect(after).toEqual(before);
  });

  describe('夹具原子创建失败路径', () => {
    const fixtureParams = (accountId: number, loginName: string): FixtureAccountParams => ({
      accountId,
      loginName,
      loginEmail: `${loginName}@example.com`,
      nickname: loginName.replace(/-/g, '_'),
      role: IdentityTypeEnum.CUSTOMER,
      organizationId: PRIMARY_ORGANIZATION_ID,
      memberRole: IdentityTypeEnum.CUSTOMER,
    });

    const countFixtureRows = async (
      accountId: number,
    ): Promise<{ accounts: number; userInfos: number; memberships: number }> => {
      const rows = await query<{
        accounts: number;
        user_infos: number;
        memberships: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM base_user_account WHERE id = ?) AS accounts,
           (SELECT COUNT(*) FROM base_user_info WHERE account_id = ?) AS user_infos,
           (SELECT COUNT(*) FROM organization_membership WHERE account_id = ?) AS memberships`,
        [accountId, accountId, accountId],
      );
      const row = rows[0];
      return {
        accounts: Number(row?.accounts ?? -1),
        userInfos: Number(row?.user_infos ?? -1),
        memberships: Number(row?.memberships ?? -1),
      };
    };

    const expectZeroRows = async (accountId: number): Promise<void> => {
      expect(await countFixtureRows(accountId)).toEqual({
        accounts: 0,
        userInfos: 0,
        memberships: 0,
      });
    };

    /**
     * 故障注入用例的统一收尾：执行与断言包在 try/catch/finally 中。
     *
     * - 断言失败不会跳过 `finally`：替身必定恢复，捕获的本轮连接必定执行销毁或释放；
     * - 主错误与收尾错误分别保留，两者同时存在时以 AggregateError 上报，互不覆盖；
     * - 收尾失败绝不吞掉主错误，主错误也绝不掩盖收尾失败。
     */
    const runWithFixtureTeardown = async (options: {
      readonly takeRunner: () => QueryRunner | undefined;
      readonly restoreSpies: () => void;
      readonly teardown: (runner: QueryRunner) => Promise<void>;
      readonly main: () => Promise<void>;
    }): Promise<void> => {
      let mainError: unknown = undefined;
      const teardownErrors: unknown[] = [];

      try {
        await options.main();
      } catch (error) {
        mainError = error;
      } finally {
        const runner = options.takeRunner();
        if (runner === undefined) {
          teardownErrors.push(new Error('未捕获到本轮连接，无法确认收尾路径'));
        } else {
          try {
            await options.teardown(runner);
          } catch (error) {
            teardownErrors.push(error);
          }
        }
        try {
          options.restoreSpies();
        } catch (error) {
          teardownErrors.push(error);
        }
      }

      const allErrors = mainError === undefined ? teardownErrors : [mainError, ...teardownErrors];
      if (allErrors.length === 0) {
        return;
      }
      const message =
        teardownErrors.length === 0
          ? '主流程错误已保留，连接收尾已完成'
          : mainError !== undefined
            ? '主流程与收尾均失败：两类错误均已保留'
            : '连接收尾失败，收尾错误已保留';
      throw new AggregateError(allErrors, message);
    };

    it('账号插入成功、资料创建失败：事务回滚，两表无本轮记录', async () => {
      const accountId = FAILURE_USER_INFO_ACCOUNT_ID;
      const membershipIdsBefore = [...ledger.membershipIds];
      const thrown = await createAccountFixtureAtomically(
        fixtureParams(accountId, 'conc-as-fail-ui'),
        { failBeforeUserInfoInsert: new Error('注入：用户资料创建失败') },
      ).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      const messages = ((thrown as AggregateError).errors as unknown[]).map(describeError);
      expect(messages).toContain('注入：用户资料创建失败');
      // 没有补偿 DELETE：账号与资料都由同一事务回滚移除
      await expectZeroRows(accountId);
      expect(ledger.accountIds).not.toContain(accountId);
      expect(ledger.membershipIds).toEqual(membershipIdsBefore);
    });

    it('成员关系创建失败：前序账号、资料全部回滚', async () => {
      const accountId = FAILURE_MEMBERSHIP_ACCOUNT_ID;
      const membershipIdsBefore = [...ledger.membershipIds];
      const thrown = await createAccountFixtureAtomically(
        fixtureParams(accountId, 'conc-as-fail-mem'),
        { failBeforeMembershipInsert: new Error('注入：成员关系创建失败') },
      ).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      const messages = ((thrown as AggregateError).errors as unknown[]).map(describeError);
      expect(messages).toContain('注入：成员关系创建失败');
      await expectZeroRows(accountId);
      expect(ledger.accountIds).not.toContain(accountId);
      expect(ledger.membershipIds).toEqual(membershipIdsBefore);
    });

    it('创建成功：提交返回后、后续断言前，清理资源已全部登记', async () => {
      const accountId = FAILURE_SUCCESS_ACCOUNT_ID;
      const membershipIdsBefore = [...ledger.membershipIds];
      await createAccountFixtureAtomically(fixtureParams(accountId, 'conc-as-fail-ok'));

      // 提交返回即已转入账本：账号与成员关系连同显式事实齐全，且无重复
      expect(ledger.accountIds.filter((id) => id === accountId)).toHaveLength(1);
      expect(ledger.facts.account.get(accountId)).toMatchObject({
        loginName: 'conc-as-fail-ok',
        loginEmail: 'conc-as-fail-ok@example.com',
        status: AccountStatus.ACTIVE,
        userState: UserState.ACTIVE,
      });
      const addedMembershipIds = ledger.membershipIds.filter(
        (membershipId) => !membershipIdsBefore.includes(membershipId),
      );
      expect(addedMembershipIds).toHaveLength(1);
      expect(ledger.facts.membership.get(addedMembershipIds[0])).toMatchObject({
        organizationId: PRIMARY_ORGANIZATION_ID,
        accountId,
        memberRole: IdentityTypeEnum.CUSTOMER,
      });

      // 后续查询发生在登记之后
      const view = await adminUserQueryService.findAdminUserViewById({ accountId });
      expect(view).not.toBeNull();
      expect(ledger.accountIds.filter((id) => id === accountId)).toHaveLength(1);
    });

    it('rollbackTransaction 真正抛错：销毁本轮连接而非普通归池', async () => {
      const accountId = FAILURE_ROLLBACK_ACCOUNT_ID;
      const accountIdsBefore = [...ledger.accountIds];
      let destroySpy: jest.SpyInstance | undefined = undefined;
      const thrown = await createAccountFixtureAtomically(
        fixtureParams(accountId, 'conc-as-fail-rb'),
        {
          failBeforeUserInfoInsert: new Error('注入：用户资料创建失败'),
          onRunnerReady: (runner) => {
            const connection = (
              runner as unknown as { databaseConnection: { destroy: () => Promise<void> } }
            ).databaseConnection;
            destroySpy = jest.spyOn(connection, 'destroy');
            jest
              .spyOn(runner, 'rollbackTransaction')
              .mockRejectedValueOnce(new Error('驱动回滚失败'));
          },
        },
      ).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      const messages = ((thrown as AggregateError).errors as unknown[]).map(describeError);
      expect(messages.some((message) => message.includes('注入：用户资料创建失败'))).toBe(true);
      expect(messages.some((message) => message.includes('驱动回滚失败'))).toBe(true);
      // 回滚失败必须销毁本轮连接，不能只 release 把活动事务归池
      expect(destroySpy).toHaveBeenCalledTimes(1);
      expect(ledger.accountIds).toEqual(accountIdsBefore);
      await expectZeroRows(accountId);
    });

    it('回滚与销毁均失败：创建、回滚、销毁三个错误均保留', async () => {
      const accountId = FAILURE_DESTROY_ACCOUNT_ID;
      const accountIdsBefore = [...ledger.accountIds];
      const holders: { runner?: QueryRunner } = {};
      const spies: jest.SpyInstance[] = [];
      let teardownAttempts = 0;
      let destroyed = false;

      await runWithFixtureTeardown({
        takeRunner: () => holders.runner,
        restoreSpies: () => {
          for (const spy of spies) spy.mockRestore();
        },
        teardown: async (runner) => {
          teardownAttempts += 1;
          await destroyRunnerConnection(runner);
          destroyed = true;
        },
        main: async () => {
          const error = await createAccountFixtureAtomically(
            fixtureParams(accountId, 'conc-as-fail-dst'),
            {
              failBeforeUserInfoInsert: new Error('注入：用户资料创建失败'),
              onRunnerReady: (runner) => {
                holders.runner = runner;
                const connection = (
                  runner as unknown as { databaseConnection: { destroy: () => Promise<void> } }
                ).databaseConnection;
                const destroySpy = jest.spyOn(connection, 'destroy');
                spies.push(destroySpy);
                destroySpy.mockRejectedValueOnce(new Error('驱动销毁失败'));
                const rollbackSpy = jest.spyOn(runner, 'rollbackTransaction');
                spies.push(rollbackSpy);
                rollbackSpy.mockRejectedValueOnce(new Error('驱动回滚失败'));
              },
            },
          ).catch((reason: unknown) => reason);

          expect(error).toBeInstanceOf(AggregateError);
          const messages = ((error as AggregateError).errors as unknown[]).map(describeError);
          expect(messages.some((message) => message.includes('注入：用户资料创建失败'))).toBe(true);
          expect(messages.some((message) => message.includes('驱动回滚失败'))).toBe(true);
          expect(messages.some((message) => message.includes('驱动销毁失败'))).toBe(true);
          expect(ledger.accountIds).toEqual(accountIdsBefore);
        },
      });

      // 替身在 finally 内已恢复；收尾销毁真实执行后才允许断言通过
      expect(teardownAttempts).toBe(1);
      expect(destroyed).toBe(true);
      expect(ledger.accountIds).toEqual(accountIdsBefore);
      await expectZeroRows(accountId);
    });

    it('commit 成功、release 抛错：资源已全部登记，helper 失败并报告释放错误', async () => {
      const accountId = FAILURE_RELEASE_ACCOUNT_ID;
      const membershipIdsBefore = [...ledger.membershipIds];
      const holders: { runner?: QueryRunner } = {};
      const spies: jest.SpyInstance[] = [];
      let teardownAttempts = 0;
      let released = false;

      await runWithFixtureTeardown({
        takeRunner: () => holders.runner,
        restoreSpies: () => {
          for (const spy of spies) spy.mockRestore();
        },
        teardown: async (runner) => {
          teardownAttempts += 1;
          await runner.release();
          released = true;
        },
        main: async () => {
          const error = await createAccountFixtureAtomically(
            fixtureParams(accountId, 'conc-as-fail-rel'),
            {
              onRunnerReady: (runner) => {
                holders.runner = runner;
                const releaseSpy = jest.spyOn(runner, 'release');
                spies.push(releaseSpy);
                releaseSpy.mockRejectedValueOnce(new Error('驱动释放失败'));
              },
            },
          ).catch((reason: unknown) => reason);

          expect(error).toBeInstanceOf(AggregateError);
          const messages = ((error as AggregateError).errors as unknown[]).map(describeError);
          expect(messages.some((message) => message.includes('驱动释放失败'))).toBe(true);
          // 提交已成功：资源与事实必须全部登记，交给受保护清理
          expect(ledger.accountIds).toContain(accountId);
          expect(ledger.facts.account.get(accountId)).toBeDefined();
          const addedMembershipIds = ledger.membershipIds.filter(
            (membershipId) => !membershipIdsBefore.includes(membershipId),
          );
          expect(addedMembershipIds).toHaveLength(1);
        },
      });

      // 替身在 finally 内已恢复；连接真实释放后才允许断言通过
      expect(teardownAttempts).toBe(1);
      expect(released).toBe(true);
      expect(ledger.accountIds).toContain(accountId);
    });

    it('中途断言失败仍收尾：主错误与收尾错误分别保留，且不跳过销毁/释放', async () => {
      // 分支一：销毁路径。断言中途抛错，收尾销毁也失败，两个错误都必须保留
      const destroyAccountId = FAILURE_ASSERTION_DESTROY_ACCOUNT_ID;
      const destroyHolders: { runner?: QueryRunner } = {};
      const destroySpies: jest.SpyInstance[] = [];
      let destroyTeardownAttempts = 0;
      let destroyed = false;

      const destroyThrown = await runWithFixtureTeardown({
        takeRunner: () => destroyHolders.runner,
        restoreSpies: () => {
          for (const spy of destroySpies) spy.mockRestore();
        },
        teardown: async (runner) => {
          destroyTeardownAttempts += 1;
          await destroyRunnerConnection(runner);
          destroyed = true;
        },
        main: async () => {
          const error = await createAccountFixtureAtomically(
            fixtureParams(destroyAccountId, 'conc-as-mid-dst'),
            {
              failBeforeUserInfoInsert: new Error('注入：用户资料创建失败'),
              onRunnerReady: (runner) => {
                destroyHolders.runner = runner;
                const connection = (
                  runner as unknown as { databaseConnection: { destroy: () => Promise<void> } }
                ).databaseConnection;
                const destroySpy = jest.spyOn(connection, 'destroy');
                destroySpies.push(destroySpy);
                // 第一次给 helper 的回滚失败路径，第二次给 finally 收尾：模拟收尾同样失败
                destroySpy
                  .mockRejectedValueOnce(new Error('驱动销毁失败（helper）'))
                  .mockRejectedValueOnce(new Error('驱动销毁失败（finally）'));
                const rollbackSpy = jest.spyOn(runner, 'rollbackTransaction');
                destroySpies.push(rollbackSpy);
                rollbackSpy.mockRejectedValueOnce(new Error('驱动回滚失败'));
              },
            },
          ).catch((reason: unknown) => reason);

          expect(error).toBeInstanceOf(AggregateError);
          const messages = ((error as AggregateError).errors as unknown[]).map(describeError);
          expect(messages.some((message) => message.includes('驱动回滚失败'))).toBe(true);
          throw new Error('模拟中途断言失败（销毁路径）');
        },
      }).catch((reason: unknown) => reason);

      try {
        expect(destroyThrown).toBeInstanceOf(AggregateError);
        const messages = ((destroyThrown as AggregateError).errors as unknown[]).map(describeError);
        expect(messages).toContain('模拟中途断言失败（销毁路径）');
        expect(messages).toContain('驱动销毁失败（finally）');
        expect(destroyTeardownAttempts).toBe(1);
        expect(destroyed).toBe(false);
        expect(ledger.accountIds).not.toContain(destroyAccountId);
      } finally {
        // 替身已恢复：再销毁一次走真实驱动，确保不留下活动事务
        const leaked = destroyHolders.runner;
        if (leaked !== undefined) {
          await destroyRunnerConnection(leaked);
        }
      }
      await expectZeroRows(destroyAccountId);

      // 分支二：释放路径。断言中途抛错，finally 仍必须释放连接
      const releaseAccountId = FAILURE_ASSERTION_RELEASE_ACCOUNT_ID;
      const membershipIdsBefore = [...ledger.membershipIds];
      const releaseHolders: { runner?: QueryRunner } = {};
      const releaseSpies: jest.SpyInstance[] = [];
      let releaseTeardownAttempts = 0;
      let released = false;

      const releaseThrown = await runWithFixtureTeardown({
        takeRunner: () => releaseHolders.runner,
        restoreSpies: () => {
          for (const spy of releaseSpies) spy.mockRestore();
        },
        teardown: async (runner) => {
          releaseTeardownAttempts += 1;
          await runner.release();
          released = true;
        },
        main: async () => {
          const error = await createAccountFixtureAtomically(
            fixtureParams(releaseAccountId, 'conc-as-mid-rel'),
            {
              onRunnerReady: (runner) => {
                releaseHolders.runner = runner;
                const releaseSpy = jest.spyOn(runner, 'release');
                releaseSpies.push(releaseSpy);
                releaseSpy.mockRejectedValueOnce(new Error('驱动释放失败'));
              },
            },
          ).catch((reason: unknown) => reason);

          expect(error).toBeInstanceOf(AggregateError);
          const messages = ((error as AggregateError).errors as unknown[]).map(describeError);
          expect(messages.some((message) => message.includes('驱动释放失败'))).toBe(true);
          throw new Error('模拟中途断言失败（释放路径）');
        },
      }).catch((reason: unknown) => reason);

      try {
        expect(releaseThrown).toBeInstanceOf(AggregateError);
        const messages = ((releaseThrown as AggregateError).errors as unknown[]).map(describeError);
        expect(messages).toContain('模拟中途断言失败（释放路径）');
        expect(releaseTeardownAttempts).toBe(1);
        expect(released).toBe(true);
        // 提交成功：资源登记保留，交给 afterAll 受保护清理
        expect(ledger.accountIds).toContain(releaseAccountId);
        const addedMembershipIds = ledger.membershipIds.filter(
          (membershipId) => !membershipIdsBefore.includes(membershipId),
        );
        expect(addedMembershipIds).toHaveLength(1);
      } finally {
        const leaked = releaseHolders.runner;
        if (leaked !== undefined && !released) {
          await leaked.release();
        }
      }
    });
  });
});
