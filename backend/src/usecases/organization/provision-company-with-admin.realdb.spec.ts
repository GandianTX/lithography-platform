// src/usecases/organization/provision-company-with-admin.realdb.spec.ts
//
// S2 同事务开通回滚专项（受控实库验收规格）。
//
// 本文件默认不启用、不连接、不写库；describe 为 skip。
// 只有同时满足以下条件才会执行：
//   E2E_PROVISION_COMPANY_REALDB=1      显式要求执行本专项
//   E2E_ALLOW_PHYSICAL_CLEANUP=1       显式授权物理清理（对照用例按台账回收）
//   E2E_REAL_DB_NAME=<目标库>           本轮授权的独立库
//   E2E_ALLOWED_DB_NAMES=<同一个库>     白名单必须包含该库
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径>  显式 env 文件，DB_NAME 必须与目标一致
//   环境文件还必须提供 FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_IV，
//   否则资料写入无法走与生产一致的加密列路径。
//   目标库还必须已存在操作者账号（本文件 `SESSION.accountId = 1`），
//   否则提交行的 `fk_provisioning_actor` 外键会失败；E2E 全库清理后需重新登记。
//
// 显式设置 E2E_PROVISION_COMPANY_REALDB=1 但许可不全时，模块加载即抛错拒绝，不静默跳过。
//
// 覆盖：分别在 insertAccount 之后、insertUserInfo 之后、insertMembership 之后注入故障，
// 断言事务整体回滚：公司 / 账号 / 资料 / 成员关系 / 提交行全部零残留。
// 本规格不打印、不断言任何口令或哈希原文。
//
// 运行（授权后，仅目标库）：
//   E2E_PROVISION_COMPANY_REALDB=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
//   E2E_REAL_DB_NAME=lithography_provision_spec \
//   E2E_ALLOWED_DB_NAMES=lithography_provision_spec \
//   E2E_REAL_DB_CONFIG_FILE=/abs/path/.env.realdb \
//   npx jest src/usecases/organization/provision-company-with-admin.realdb.spec.ts --runInBand

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  assertAllowedE2eDatabase,
  assertDataSourceOnAllowedE2eDatabase,
  resolveAllowedE2eDatabases,
} from '../../../test/utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../../../test/utils/e2e-scoped-cleanup';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { FieldEncryptionService } from '@src/infrastructure/field-encryption/field-encryption.service';
import { FieldEncryptionSubscriber } from '@src/infrastructure/field-encryption/field-encryption.subscriber';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { OrganizationMembershipService } from '@src/modules/lithography/organization-membership.service';
import type { ProvisionCompanyWithAdminCommand } from './company-provisioning.types';
import { OrganizationUsecasesModule } from './organization-usecases.module';
import { ProvisionCompanyWithAdminUsecase } from './provision-company-with-admin.usecase';

const REQUESTED = process.env.E2E_PROVISION_COMPANY_REALDB === '1';
const CLEANUP_ALLOWED = process.env.E2E_ALLOW_PHYSICAL_CLEANUP === '1';
const EXPECTED_DB = process.env.E2E_REAL_DB_NAME ?? '';
const ALLOWED_DBS = resolveAllowedE2eDatabases();
const TARGET_DB = EXPECTED_DB.toLowerCase();
const CONFIG_FILE = process.env.E2E_REAL_DB_CONFIG_FILE ?? '';

const ENABLED =
  REQUESTED &&
  CLEANUP_ALLOWED &&
  TARGET_DB.length > 0 &&
  ALLOWED_DBS.includes(TARGET_DB) &&
  CONFIG_FILE.length > 0;

if (REQUESTED && !ENABLED) {
  throw new Error(
    'S2 同事务开通回滚专项被显式要求执行（E2E_PROVISION_COMPANY_REALDB=1），但许可不全：' +
      '需要 E2E_ALLOW_PHYSICAL_CLEANUP=1、E2E_REAL_DB_NAME、' +
      'E2E_ALLOWED_DB_NAMES（必须包含目标库）与 E2E_REAL_DB_CONFIG_FILE。明确拒绝，不静默跳过。',
  );
}

const describeRealDb = ENABLED ? describe : describe.skip;

const RUN_TAG = randomUUID().slice(0, 8);
const INJECTED_FAILURE = 'INJECTED_PROVISION_COMPANY_FAILURE';
const CONTACT_PHONE = '021-58880000';

const SESSION: UsecaseSession = {
  accountId: 1,
  roles: [IdentityTypeEnum.SUPER_ADMIN],
  activeRole: IdentityTypeEnum.SUPER_ADMIN,
  adminLevel: 1,
  adminOrganizationId: null,
};

/** 回滚现场的四类计数（账号/资料/成员按本轮 `orgadmin_` 前缀收窄）。 */
interface ResidueSnapshot {
  readonly organization: number;
  readonly adminAccount: number;
  readonly adminUserInfo: number;
  readonly adminMembership: number;
}

const ADMIN_LOGIN_LIKE = "login_name LIKE 'orgadmin\\_%'";

describeRealDb('S2 开通事务回滚（受控实库）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let usecase: ProvisionCompanyWithAdminUsecase;
  let accountService: AccountService;
  let membershipService: OrganizationMembershipService;

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: number | string }>>(sql, params);
    return Number(rows[0]?.total ?? 0);
  };

  const readSnapshot = async (): Promise<ResidueSnapshot> => ({
    organization: await count('SELECT COUNT(*) AS total FROM `organization`'),
    adminAccount: await count(
      `SELECT COUNT(*) AS total FROM base_user_account WHERE ${ADMIN_LOGIN_LIKE}`,
    ),
    adminUserInfo: await count(
      `SELECT COUNT(*) AS total FROM base_user_info info
         JOIN base_user_account account ON account.id = info.account_id
        WHERE account.${ADMIN_LOGIN_LIKE}`,
    ),
    adminMembership: await count(
      `SELECT COUNT(*) AS total FROM organization_membership membership
         JOIN base_user_account account ON account.id = membership.account_id
        WHERE account.${ADMIN_LOGIN_LIKE}`,
    ),
  });

  beforeAll(async () => {
    assertAllowedE2eDatabase(TARGET_DB);

    const config = loadExplicitEnvConfig(CONFIG_FILE, TARGET_DB);
    if (!config.fieldEncryptionKey || !config.fieldEncryptionIv) {
      throw new Error(
        '实库回滚专项要求环境文件提供 FIELD_ENCRYPTION_KEY 与 FIELD_ENCRYPTION_IV，' +
          '否则资料写入无法走与生产一致的加密列路径。',
      );
    }

    const encryption = new FieldEncryptionService(
      new ConfigService({
        FIELD_ENCRYPTION_KEY: config.fieldEncryptionKey,
        FIELD_ENCRYPTION_IV: config.fieldEncryptionIv,
      }),
    );

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
          dropSchema: false,
          logging: false,
          entities: [join(__dirname, '../../modules/**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        OrganizationUsecasesModule,
      ],
    })
      // 被测模块自身也会构造 FieldEncryptionService，必须复用本文件的显式密钥实例，
      // 否则会回落到空的全局 ConfigService 并直接抛「FIELD_ENCRYPTION_KEY is required」。
      .overrideProvider(FieldEncryptionService)
      .useValue(encryption)
      .compile();

    // 触发 OnModuleInit：`AccountFieldEncryptionRegistrar` 只在初始化阶段登记
    // `meta_digest` 加密列；未登记时该列按明文写入，回放的三源角色收敛必然失败。
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    // 本规格自建 DataSource，不经过 `DatabaseModule` 的订阅者装配，需手工挂载生产同源订阅者。
    const fieldEncryptionSubscriber = moduleRef.get(FieldEncryptionSubscriber, { strict: false });
    if (!dataSource.subscribers.includes(fieldEncryptionSubscriber)) {
      dataSource.subscribers.push(fieldEncryptionSubscriber);
    }
    await assertDataSourceOnAllowedE2eDatabase(dataSource, TARGET_DB);

    usecase = moduleRef.get(ProvisionCompanyWithAdminUsecase);
    accountService = moduleRef.get(AccountService);
    membershipService = moduleRef.get(OrganizationMembershipService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const command = (name: string, submissionKey: string): ProvisionCompanyWithAdminCommand => ({
    session: SESSION,
    submissionKey,
    name,
    contactPhone: CONTACT_PHONE,
  });

  /** 执行一次注定失败的开通，并核验事务回滚后的零残留。 */
  const runAndAssertRollback = async (params: {
    caseName: string;
    inject: () => () => void;
  }): Promise<void> => {
    const name = `E2E-S2-回滚-${params.caseName}-${RUN_TAG}`;
    const submissionKey = randomUUID();

    const before = await readSnapshot();
    const restore = params.inject();
    let error: unknown;
    try {
      await usecase.execute(command(name, submissionKey));
    } catch (caught) {
      error = caught;
    } finally {
      restore();
    }

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED);
    // 异常与日志都不得携带原始口令或哈希。
    expect(JSON.stringify(error)).not.toContain('Aa1!');
    expect(JSON.stringify(error)).not.toContain('password');

    const after = await readSnapshot();
    expect(after).toEqual(before);

    // 本次尝试的绝对零残留：公司名与提交标识。
    expect(await count('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [name])).toBe(
      0,
    );
    expect(
      await count(
        'SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE purpose = ? AND submission_key = ?',
        ['ADMIN_CREATE_ORGANIZATION', submissionKey],
      ),
    ).toBe(0);
  };

  it('insertAccount 之后故障：公司与提交行一并回滚', async () => {
    await runAndAssertRollback({
      caseName: '账号',
      inject: () => {
        const original = accountService.insertAccount.bind(accountService);
        const spy = jest.spyOn(accountService, 'insertAccount').mockImplementation(async (args) => {
          const outcome = await original(args);
          expect(outcome.kind).toBe('CREATED');
          throw new Error(INJECTED_FAILURE);
        });
        return () => spy.mockRestore();
      },
    });
  });

  it('insertUserInfo 之后故障：已写入的账号与资料随事务回滚', async () => {
    await runAndAssertRollback({
      caseName: '资料',
      inject: () => {
        const original = accountService.insertUserInfo.bind(accountService);
        const spy = jest
          .spyOn(accountService, 'insertUserInfo')
          .mockImplementation(async (args) => {
            await original(args);
            throw new Error(INJECTED_FAILURE);
          });
        return () => spy.mockRestore();
      },
    });
  });

  it('insertMembership 之后故障：成员关系与公司/账号/提交行全部回滚', async () => {
    await runAndAssertRollback({
      caseName: '成员',
      inject: () => {
        const original = membershipService.insertMembership.bind(membershipService);
        const spy = jest
          .spyOn(membershipService, 'insertMembership')
          .mockImplementation(async (data, transactionContext) => {
            await original(data, transactionContext);
            throw new Error(INJECTED_FAILURE);
          });
        return () => spy.mockRestore();
      },
    });
  });

  it('未注入故障的对照：开通成功后能按提交标识回放（不返回口令），并按台账回收', async () => {
    const name = `E2E-S2-回滚对照-${RUN_TAG}`;
    const submissionKey = randomUUID();
    const ownership: OwnedResourceLedger = createOwnedResourceLedger();

    const created = await usecase.execute(command(name, submissionKey));
    const replayed = await usecase.execute(command(name, submissionKey));

    expect(created.submission.replayed).toBe(false);
    // 用布尔断言而非 toMatch，避免断言失败时把临时密码明文写进失败信息。
    expect(created.temporaryPassword?.startsWith('Aa1!')).toBe(true);
    expect(replayed.submission).toEqual({
      submissionId: created.submission.submissionId,
      replayed: true,
    });
    expect(replayed.organization.id).toBe(created.organization.id);
    expect(replayed.admin.accountId).toBe(created.admin.accountId);
    expect(replayed.temporaryPassword).toBeNull();

    // 按真实回读登记本轮创建的三类资源；成员关系由清理器按账号自动扩图。
    const submissionId = created.submission.submissionId;
    if (submissionId === null) {
      throw new Error('对照用例缺少提交行主键');
    }
    recordOwnedResource(ownership, 'organization', created.organization.id, {
      organizationCode: created.organization.organizationCode,
      name: created.organization.name,
      kind: created.organization.kind,
      status: created.organization.status,
      isManagedCompany: created.organization.isManagedCompany,
    });

    const accountRows = await dataSource.query<
      Array<{
        login_name: string | null;
        login_email: string | null;
        status: string;
        identity_hint: string | null;
      }>
    >('SELECT login_name, login_email, status, identity_hint FROM base_user_account WHERE id = ?', [
      created.admin.accountId,
    ]);
    const infoRows = await dataSource.query<
      Array<{
        nickname: string;
        email: string | null;
        user_state: string;
        customer_organization_id: number | null;
        access_group: unknown;
      }>
    >(
      'SELECT nickname, email, user_state, customer_organization_id, access_group FROM base_user_info WHERE account_id = ?',
      [created.admin.accountId],
    );
    const account = accountRows[0];
    const userInfo = infoRows[0];
    if (!account || !userInfo) {
      throw new Error('对照用例缺少账号或资料行');
    }
    const accessGroup = Array.isArray(userInfo.access_group)
      ? (userInfo.access_group as string[])
      : (JSON.parse(String(userInfo.access_group)) as string[]);
    recordOwnedResource(ownership, 'account', created.admin.accountId, {
      loginName: account.login_name,
      loginEmail: account.login_email,
      status: account.status,
      identityHint: account.identity_hint,
      accessGroup,
      nickname: userInfo.nickname,
      userInfoEmail: userInfo.email,
      userState: userInfo.user_state,
      customerOrganizationId: userInfo.customer_organization_id,
    });
    recordOwnedResource(ownership, 'provisioningRequest', submissionId, {
      purpose: 'ADMIN_CREATE_ORGANIZATION',
      organizationId: created.organization.id,
      adminAccountId: created.admin.accountId,
      state: 'COMPLETED',
    });

    await runGuardedSpecCleanup({
      dataSource,
      owned: ownership,
      helper: 'provision-company-with-admin.realdb 对照用例回收',
    });

    expect(await count('SELECT COUNT(*) AS total FROM `organization` WHERE name = ?', [name])).toBe(
      0,
    );
    expect(
      await count(
        'SELECT COUNT(*) AS total FROM admin_organization_provisioning_request WHERE submission_key = ?',
        [submissionKey],
      ),
    ).toBe(0);
    expect(
      await count('SELECT COUNT(*) AS total FROM base_user_account WHERE id = ?', [
        created.admin.accountId,
      ]),
    ).toBe(0);
  });
});
