import type { EntityManager } from 'typeorm';

import { createFieldCipher } from '../field-encryption/field-encryption.cipher';
import { applyAdminBootstrap, parseAdminBootstrapConfig } from './admin-bootstrap';
import {
  applyAdminBindingInventory,
  buildAdminBindingPlanId,
  inspectAdminBindingInventory,
} from './admin-binding-inventory';

const TEST_KEY = '0123456789abcdef';
const TEST_IV = 'abcdef0123456789';
const PASSWORD = 'Xk7#mQ2!vR9';

interface FakeOrganizationRecord {
  id: number;
  code: string;
  name: string;
  kind: 'CLIENT' | 'PEER';
  isManagedCompany: boolean;
  isServiceProvider: boolean;
  status: string;
}

interface FakeAccountRecord {
  id: number;
  loginName: string;
  loginEmail: string | null;
  passwordHash: string | null;
  adminLevel: number | null;
  identityHint: string | null;
  accountStatus: string;
  hasUserInfo: boolean;
  customerOrganizationId: number | null;
  accessGroup: unknown;
  metaDigest: unknown;
  userState: string | null;
  nickname: string | null;
  membershipOrganizationId: number | null;
  membershipRole: string | null;
  membershipActive: boolean;
}

/**
 * 内存替身数据库：只实现被测路径实际发出的 SQL 形状。
 *
 * 目的不是复刻 MySQL 语义，而是让「复用 / 新建 / 零写入 / 重跑幂等」这些
 * 绑定判定的行为分支在无实库的前提下可被精确断言。
 */
class FakeAdminDatabase {
  readonly organizations: FakeOrganizationRecord[] = [];
  readonly accounts: FakeAccountRecord[] = [];
  readonly statements: string[] = [];
  private nextOrganizationId = 1;
  private nextAccountId = 1;
  private lastInsertedId: number | null = null;

  addOrganization(
    input: Omit<FakeOrganizationRecord, 'id' | 'name' | 'isServiceProvider'> & {
      readonly name?: string;
    },
  ): FakeOrganizationRecord {
    const record: FakeOrganizationRecord = {
      id: this.nextOrganizationId++,
      code: input.code,
      name: input.name ?? input.code,
      kind: input.kind,
      isManagedCompany: input.isManagedCompany,
      isServiceProvider: false,
      status: input.status,
    };
    this.organizations.push(record);
    return record;
  }

  addAccount(
    input: Partial<Omit<FakeAccountRecord, 'id' | 'loginName'>> & {
      readonly loginName: string;
    },
  ): FakeAccountRecord {
    const record: FakeAccountRecord = {
      id: this.nextAccountId++,
      loginName: input.loginName,
      loginEmail: input.loginEmail ?? null,
      passwordHash: input.passwordHash ?? 'pre-existing-hash',
      adminLevel: input.adminLevel ?? null,
      identityHint: input.identityHint ?? null,
      accountStatus: input.accountStatus ?? 'ACTIVE',
      hasUserInfo: input.hasUserInfo ?? true,
      customerOrganizationId: input.customerOrganizationId ?? null,
      accessGroup: input.accessGroup ?? null,
      metaDigest: input.metaDigest ?? null,
      userState: input.userState ?? 'ACTIVE',
      nickname: input.nickname ?? input.loginName,
      membershipOrganizationId: input.membershipOrganizationId ?? null,
      membershipRole: input.membershipRole ?? null,
      membershipActive: input.membershipActive ?? false,
    };
    this.accounts.push(record);
    return record;
  }

  insertCount(): number {
    return this.statements.filter((statement) => statement.includes('INSERT INTO')).length;
  }

  findAccount(loginName: string): FakeAccountRecord | undefined {
    return this.accounts.find((account) => account.loginName === loginName);
  }

  manager(): EntityManager {
    const fake = {
      query: (sql: string, parameters?: ReadonlyArray<unknown>): Promise<unknown> =>
        this.handleQuery(sql, parameters ?? []),
    };
    return fake as unknown as EntityManager;
  }

  /**
   * 事务替身：失败时把内存状态与 SQL 记录恢复到进入事务前，
   * 使「整批拒绝 = 零写入」可被真实断言，而不是只验证异常消息。
   */
  dataSource(): { transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T> } {
    return {
      transaction: async <T>(run: (manager: EntityManager) => Promise<T>): Promise<T> => {
        const accountsBefore = this.accounts.map((account) => ({ ...account }));
        const organizationsBefore = this.organizations.map((organization) => ({
          ...organization,
        }));
        const nextAccountIdBefore = this.nextAccountId;
        const lastInsertedIdBefore = this.lastInsertedId;
        const statementCountBefore = this.statements.length;
        try {
          return await run(this.manager());
        } catch (error: unknown) {
          this.accounts.splice(0, this.accounts.length, ...accountsBefore);
          this.organizations.splice(0, this.organizations.length, ...organizationsBefore);
          this.nextAccountId = nextAccountIdBefore;
          this.lastInsertedId = lastInsertedIdBefore;
          this.statements.splice(statementCountBefore);
          throw error;
        }
      },
    };
  }

  private handleQuery(sql: string, params: ReadonlyArray<unknown>): Promise<unknown> {
    this.statements.push(sql);
    if (sql.includes('INSERT INTO `base_user_account`')) {
      return Promise.resolve(this.insertAccount(params));
    }
    if (sql.includes('SELECT LAST_INSERT_ID()')) {
      return Promise.resolve([{ account_id: this.lastInsertedId }]);
    }
    if (sql.includes('INSERT INTO `base_user_info`')) {
      return Promise.resolve(this.insertUserInfo(params));
    }
    if (sql.includes('INSERT INTO `organization_membership`')) {
      return Promise.resolve(this.insertMembership(params));
    }
    if (sql.includes('UPDATE `base_user_account` SET `admin_level`')) {
      const account = this.accounts.find((item) => item.id === Number(params[1]));
      if (account !== undefined) {
        account.adminLevel = Number(params[0]);
      }
      return Promise.resolve([]);
    }
    if (sql.includes('UPDATE `base_user_info` SET `customer_organization_id`')) {
      const account = this.accounts.find((item) => item.id === Number(params[1]));
      if (account !== undefined) {
        account.customerOrganizationId = Number(params[0]);
      }
      return Promise.resolve([]);
    }
    if (sql.includes('SELECT `login_name` FROM `base_user_account` WHERE `login_email`')) {
      return Promise.resolve(this.findEmailOwner(String(params[0])));
    }
    if (sql.includes('FROM `organization_membership` AS m')) {
      return Promise.resolve(this.loadBindingCandidates(Number(params[0])));
    }
    if (sql.includes('FROM `organization_membership`')) {
      return Promise.resolve(this.loadActiveMembership(Number(params[0]), Number(params[1])));
    }
    if (sql.includes('FROM `base_user_account` AS a')) {
      return Promise.resolve(this.loadBootstrapAccount(String(params[0])));
    }
    if (sql.includes('FROM `organization`') && sql.includes('`is_managed_company` = 1')) {
      return Promise.resolve(this.listManagedCompanies());
    }
    if (sql.includes('FROM `organization`')) {
      return Promise.resolve(this.lockOrganizationByCode(String(params[0])));
    }
    throw new Error(`内存替身未实现 SQL: ${sql}`);
  }

  private insertAccount(params: ReadonlyArray<unknown>): unknown {
    const [loginName, loginEmail, passwordHash, identityHint, adminLevel] = params as [
      string,
      string | null,
      string,
      string,
      number,
    ];
    const account: FakeAccountRecord = {
      id: this.nextAccountId++,
      loginName,
      loginEmail,
      passwordHash,
      identityHint,
      adminLevel,
      accountStatus: 'ACTIVE',
      hasUserInfo: false,
      customerOrganizationId: null,
      accessGroup: null,
      metaDigest: null,
      userState: null,
      nickname: null,
      membershipOrganizationId: null,
      membershipRole: null,
      membershipActive: false,
    };
    this.accounts.push(account);
    this.lastInsertedId = account.id;
    return [];
  }

  private insertUserInfo(params: ReadonlyArray<unknown>): unknown {
    const account = this.accounts.find((item) => item.id === Number(params[0]));
    if (account === undefined) {
      throw new Error('内存替身：base_user_info 找不到账号');
    }
    account.nickname = String(params[1]);
    account.customerOrganizationId = Number(params[3]);
    account.accessGroup = params[4];
    account.metaDigest = params[5];
    account.userState = 'ACTIVE';
    account.hasUserInfo = true;
    return [];
  }

  private insertMembership(params: ReadonlyArray<unknown>): unknown {
    const account = this.accounts.find((item) => item.id === Number(params[1]));
    if (account === undefined) {
      throw new Error('内存替身：organization_membership 找不到账号');
    }
    account.membershipOrganizationId = Number(params[0]);
    account.membershipRole = String(params[2]);
    account.membershipActive = true;
    return [];
  }

  private findEmailOwner(email: string): ReadonlyArray<unknown> {
    const owner = this.accounts.find(
      (account) => account.loginEmail?.toLowerCase() === email.toLowerCase(),
    );
    return owner === undefined ? [] : [{ login_name: owner.loginName }];
  }

  private loadBindingCandidates(organizationId: number): ReadonlyArray<unknown> {
    return this.accounts
      .filter(
        (account) =>
          account.membershipOrganizationId === organizationId &&
          account.membershipActive &&
          (account.adminLevel === 2 || account.membershipRole === 'SUPER_ADMIN'),
      )
      .sort((left, right) => left.id - right.id)
      .map((account) => ({
        account_id: account.id,
        login_name: account.loginName,
        admin_level: account.adminLevel,
        identity_hint: account.identityHint,
        account_status: account.accountStatus,
        user_state: account.userState,
        customer_organization_id: account.customerOrganizationId,
        access_group: account.accessGroup,
        meta_digest: account.metaDigest,
        member_role: account.membershipRole,
        membership_status: 'ACTIVE',
        left_at: null,
      }));
  }

  private loadActiveMembership(accountId: number, organizationId: number): ReadonlyArray<unknown> {
    const account = this.accounts.find((item) => item.id === accountId);
    if (
      account === undefined ||
      account.membershipOrganizationId !== organizationId ||
      !account.membershipActive
    ) {
      return [];
    }
    return [{ member_role: account.membershipRole, left_at: null }];
  }

  private loadBootstrapAccount(loginName: string): ReadonlyArray<unknown> {
    const account = this.findAccount(loginName);
    if (account === undefined) {
      return [];
    }
    return [
      {
        id: account.id,
        admin_level: account.adminLevel,
        identity_hint: account.identityHint,
        login_email: account.loginEmail,
        account_status: account.accountStatus,
        info_id: account.hasUserInfo ? account.id * 10 : null,
        customer_organization_id: account.customerOrganizationId,
        access_group: account.accessGroup,
        meta_digest: account.metaDigest,
        user_state: account.userState,
      },
    ];
  }

  private listManagedCompanies(): ReadonlyArray<unknown> {
    return this.organizations
      .filter((organization) => organization.isManagedCompany)
      .sort((left, right) => left.id - right.id)
      .map((organization) => ({
        id: organization.id,
        organization_code: organization.code,
        status: organization.status,
        is_managed_company: organization.isManagedCompany ? 1 : 0,
      }));
  }

  private lockOrganizationByCode(code: string): ReadonlyArray<unknown> {
    const organization = this.organizations.find((item) => item.code === code);
    if (organization === undefined) {
      return [];
    }
    return [
      {
        id: organization.id,
        name: organization.name,
        short_name: null,
        kind: organization.kind,
        is_managed_company: organization.isManagedCompany ? 1 : 0,
        is_service_provider: organization.isServiceProvider ? 1 : 0,
        status: organization.status,
      },
    ];
  }
}

interface CompanyConfigInput {
  readonly organizationCode: string;
  readonly loginName: string;
}

function buildV2Config(companies: ReadonlyArray<CompanyConfigInput>): string {
  return JSON.stringify({
    schema_version: 2,
    level_one_accounts: [
      {
        login_name: 'level-one-a',
        login_email: 'level-one-a@example.com',
        password: PASSWORD,
        organization_code: 'ORG-CLIENT-A',
        nickname: '一级甲',
      },
      {
        login_name: 'level-one-b',
        login_email: 'level-one-b@example.com',
        password: PASSWORD,
        organization_code: 'ORG-CLIENT-B',
        nickname: '一级乙',
      },
      {
        login_name: 'level-one-c',
        login_email: 'level-one-c@example.com',
        password: PASSWORD,
        organization_code: 'ORG-CLIENT-C',
        nickname: '一级丙',
      },
    ],
    default_managed_companies: companies.map((company) => ({
      organization_code: company.organizationCode,
      account: {
        login_name: company.loginName,
        login_email: `${company.loginName}@example.com`,
        password: PASSWORD,
        nickname: `二级${company.loginName}`,
      },
    })),
  });
}

function seedClientOrganizations(db: FakeAdminDatabase): void {
  db.addOrganization({
    code: 'ORG-CLIENT-A',
    kind: 'CLIENT',
    isManagedCompany: false,
    status: 'ACTIVE',
  });
  db.addOrganization({
    code: 'ORG-CLIENT-B',
    kind: 'CLIENT',
    isManagedCompany: false,
    status: 'ACTIVE',
  });
  db.addOrganization({
    code: 'ORG-CLIENT-C',
    kind: 'CLIENT',
    isManagedCompany: false,
    status: 'ACTIVE',
  });
}

function applyConfig(db: FakeAdminDatabase, raw: string): ReturnType<typeof applyAdminBootstrap> {
  return applyAdminBootstrap(db.dataSource() as never, parseAdminBootstrapConfig(raw), {
    fieldEncryptionKey: TEST_KEY,
    fieldEncryptionIv: TEST_IV,
  });
}

describe('管理员正式初始化 schema_version=2（内存替身）', () => {
  it('恰好 3 个一级账号 + 0 家默认受管公司是合法输入', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);

    const results = await applyConfig(db, buildV2Config([]));

    expect(results).toEqual([
      {
        loginName: 'level-one-a',
        outcome: 'CREATED',
        adminLevel: 1,
        organizationCode: 'ORG-CLIENT-A',
        temporaryPasswordIssued: true,
      },
      {
        loginName: 'level-one-b',
        outcome: 'CREATED',
        adminLevel: 1,
        organizationCode: 'ORG-CLIENT-B',
        temporaryPasswordIssued: true,
      },
      {
        loginName: 'level-one-c',
        outcome: 'CREATED',
        adminLevel: 1,
        organizationCode: 'ORG-CLIENT-C',
        temporaryPasswordIssued: true,
      },
    ]);
  });

  it('一级账号数量不是 3 个时解析失败', () => {
    const raw = JSON.parse(buildV2Config([])) as Record<string, unknown>;
    const levelOne = raw.level_one_accounts as unknown[];
    raw.level_one_accounts = levelOne.slice(0, 2);

    expect(() => parseAdminBootstrapConfig(JSON.stringify(raw))).toThrow(/恰好 3 个/);
  });

  it('缺少 default_managed_companies 时解析失败', () => {
    const raw = JSON.parse(buildV2Config([])) as {
      readonly schema_version: number;
      readonly level_one_accounts: ReadonlyArray<unknown>;
    };
    const withoutCompanies = {
      schema_version: raw.schema_version,
      level_one_accounts: raw.level_one_accounts,
    };

    expect(() => parseAdminBootstrapConfig(JSON.stringify(withoutCompanies))).toThrow(
      /default_managed_companies/,
    );
  });

  it('重复配置同一家公司时解析失败', () => {
    const raw = JSON.parse(
      buildV2Config([
        { organizationCode: 'ORG-MANAGED-A', loginName: 'managed-a' },
        { organizationCode: 'ORG-MANAGED-A', loginName: 'managed-a2' },
      ]),
    ) as Record<string, unknown>;
    raw.default_managed_companies = [
      ...(raw.default_managed_companies as unknown[]),
      (raw.default_managed_companies as unknown[])[0],
    ];

    expect(() => parseAdminBootstrapConfig(JSON.stringify(raw))).toThrow(/重复配置/);
  });

  it('二级账号与一级账号登录名重复时解析失败', () => {
    const raw = JSON.parse(
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'level-one-a' }]),
    );

    expect(() => parseAdminBootstrapConfig(JSON.stringify(raw))).toThrow(/重复账号/);
  });

  it('二级账号携带 admin_level 字段时解析失败', () => {
    const raw = JSON.parse(
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'managed-a' }]),
    ) as {
      readonly default_managed_companies: Array<{ readonly account: Record<string, unknown> }>;
    };
    raw.default_managed_companies[0].account.admin_level = 2;

    expect(() => parseAdminBootstrapConfig(JSON.stringify(raw))).toThrow(/admin_level/);
  });

  it('未配置绑定的受管公司会新建二级账号', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    const managed = db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });

    const results = await applyConfig(
      db,
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'managed-a' }]),
    );

    expect(results.at(-1)).toEqual({
      loginName: 'managed-a',
      outcome: 'CREATED',
      adminLevel: 2,
      organizationCode: 'ORG-MANAGED-A',
      temporaryPasswordIssued: true,
    });
    const created = db.findAccount('managed-a');
    expect(created).toMatchObject({
      adminLevel: 2,
      customerOrganizationId: managed.id,
      membershipOrganizationId: managed.id,
      membershipRole: 'SUPER_ADMIN',
      membershipActive: true,
    });
  });

  it('已有唯一合法绑定但配置登录名不同时复用历史账号且不新建', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    const managed = db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    db.addAccount({
      loginName: 'historical-managed',
      adminLevel: 2,
      identityHint: 'SUPER_ADMIN',
      customerOrganizationId: managed.id,
      accessGroup: JSON.stringify(['SUPER_ADMIN']),
      metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
      membershipOrganizationId: managed.id,
      membershipRole: 'SUPER_ADMIN',
      membershipActive: true,
    });

    const results = await applyConfig(
      db,
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'configured-managed' }]),
    );

    expect(results.at(-1)).toEqual({
      loginName: 'historical-managed',
      outcome: 'UNCHANGED',
      adminLevel: 2,
      organizationCode: 'ORG-MANAGED-A',
      temporaryPasswordIssued: false,
      bindingNote: 'REUSED_EXISTING_BINDING',
    });
    expect(db.findAccount('configured-managed')).toBeUndefined();
    expect(db.insertCount()).toBe(9);
  });

  it('合法绑定但账号停用时沿用原账号并保持原状态', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    const managed = db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    db.addAccount({
      loginName: 'disabled-managed',
      adminLevel: 2,
      identityHint: 'SUPER_ADMIN',
      accountStatus: 'SUSPENDED',
      customerOrganizationId: managed.id,
      accessGroup: JSON.stringify(['SUPER_ADMIN']),
      metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
      membershipOrganizationId: managed.id,
      membershipRole: 'SUPER_ADMIN',
      membershipActive: true,
    });

    const results = await applyConfig(
      db,
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'configured-managed' }]),
    );

    expect(results.at(-1)).toMatchObject({
      loginName: 'disabled-managed',
      outcome: 'UNCHANGED',
      bindingNote: 'BOUND_ACCOUNT_NOT_ACTIVE',
    });
    expect(db.findAccount('disabled-managed')?.accountStatus).toBe('SUSPENDED');
    expect(db.findAccount('configured-managed')).toBeUndefined();
  });

  it('公司存在多个候选绑定时整批拒绝并只输出脱敏标识', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    const managed = db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    for (const loginName of ['first-managed', 'second-managed']) {
      db.addAccount({
        loginName,
        adminLevel: 2,
        identityHint: 'SUPER_ADMIN',
        customerOrganizationId: managed.id,
        accessGroup: JSON.stringify(['SUPER_ADMIN']),
        metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
        membershipOrganizationId: managed.id,
        membershipRole: 'SUPER_ADMIN',
        membershipActive: true,
      });
    }

    const error = await applyConfig(
      db,
      buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'configured-managed' }]),
    ).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('MULTIPLE_BINDINGS');
    expect(message).toContain('f***d');
    expect(message).toContain('s***d');
    expect(message).not.toContain('first-managed');
    expect(message).not.toContain('second-managed');
    expect(db.insertCount()).toBe(0);
  });

  it('配置引用不存在的公司时整批拒绝', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);

    await expect(
      applyConfig(db, buildV2Config([{ organizationCode: 'ORG-MISSING', loginName: 'managed-a' }])),
    ).rejects.toThrow(/缺少公司 organization_code=ORG-MISSING/);
    expect(db.insertCount()).toBe(0);
  });

  it('公司未标记受管时拒绝绑定二级管理员', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    db.addOrganization({
      code: 'ORG-NOT-MANAGED',
      kind: 'PEER',
      isManagedCompany: false,
      status: 'ACTIVE',
    });

    await expect(
      applyConfig(
        db,
        buildV2Config([{ organizationCode: 'ORG-NOT-MANAGED', loginName: 'managed-a' }]),
      ),
    ).rejects.toThrow(/未标记 is_managed_company/);
  });

  it('公司不是 ACTIVE 时拒绝绑定二级管理员', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    db.addOrganization({
      code: 'ORG-DISABLED',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'SUSPENDED',
    });

    await expect(
      applyConfig(
        db,
        buildV2Config([{ organizationCode: 'ORG-DISABLED', loginName: 'managed-a' }]),
      ),
    ).rejects.toThrow(/不是 ACTIVE/);
  });

  it('缺失绑定但配置账号名已存在时拒绝复用、补级或改绑', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    db.addAccount({ loginName: 'configured-managed', adminLevel: null });

    await expect(
      applyConfig(
        db,
        buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'configured-managed' }]),
      ),
    ).rejects.toThrow(/拒绝复用、补级或改绑/);
    expect(db.findAccount('configured-managed')?.adminLevel).toBeNull();
    expect(db.insertCount()).toBe(0);
  });

  it('历史绑定与配置名被其他账号占用时拒绝猜名并保留现场', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    const managed = db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    db.addAccount({
      loginName: 'historical-managed',
      adminLevel: 2,
      identityHint: 'SUPER_ADMIN',
      customerOrganizationId: managed.id,
      accessGroup: JSON.stringify(['SUPER_ADMIN']),
      metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
      membershipOrganizationId: managed.id,
      membershipRole: 'SUPER_ADMIN',
      membershipActive: true,
    });
    db.addAccount({ loginName: 'configured-managed', adminLevel: null });

    await expect(
      applyConfig(
        db,
        buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'configured-managed' }]),
      ),
    ).rejects.toThrow(/拒绝猜名或改绑/);
    expect(db.findAccount('configured-managed')?.adminLevel).toBeNull();
    expect(db.findAccount('historical-managed')?.adminLevel).toBe(2);
  });

  it('重跑同一配置零新增且既有密码哈希不变', async () => {
    const db = new FakeAdminDatabase();
    seedClientOrganizations(db);
    db.addOrganization({
      code: 'ORG-MANAGED-A',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    const raw = buildV2Config([{ organizationCode: 'ORG-MANAGED-A', loginName: 'managed-a' }]);

    await applyConfig(db, raw);
    const insertsAfterFirstRun = db.insertCount();
    const hashesAfterFirstRun = db.accounts.map((account) => account.passwordHash);

    const secondResults = await applyConfig(db, raw);

    expect(secondResults.map((result) => result.outcome)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
    expect(secondResults.at(-1)).toMatchObject({
      loginName: 'managed-a',
      temporaryPasswordIssued: false,
    });
    expect(db.insertCount()).toBe(insertsAfterFirstRun);
    expect(db.accounts.map((account) => account.passwordHash)).toEqual(hashesAfterFirstRun);
  });
});

describe('存量二级绑定盘点与受控应用（内存替身）', () => {
  function seedInventory(db: FakeAdminDatabase): {
    readonly boundOrganization: FakeOrganizationRecord;
    readonly unconfiguredOrganization: FakeOrganizationRecord;
    readonly conflictOrganization: FakeOrganizationRecord;
    readonly disabledOrganization: FakeOrganizationRecord;
  } {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const boundOrganization = db.addOrganization({
      code: 'ORG-BOUND',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    db.addAccount({
      loginName: 'bound-admin',
      adminLevel: 2,
      identityHint: 'SUPER_ADMIN',
      customerOrganizationId: boundOrganization.id,
      accessGroup: JSON.stringify(['SUPER_ADMIN']),
      metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
      membershipOrganizationId: boundOrganization.id,
      membershipRole: 'SUPER_ADMIN',
      membershipActive: true,
    });

    const unconfiguredOrganization = db.addOrganization({
      code: 'ORG-UNCONFIGURED',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });

    const conflictOrganization = db.addOrganization({
      code: 'ORG-CONFLICT',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'ACTIVE',
    });
    for (const loginName of ['conflict-one', 'conflict-two']) {
      db.addAccount({
        loginName,
        adminLevel: 2,
        identityHint: 'SUPER_ADMIN',
        customerOrganizationId: conflictOrganization.id,
        accessGroup: JSON.stringify(['SUPER_ADMIN']),
        metaDigest: cipher.encrypt(JSON.stringify(['SUPER_ADMIN'])),
        membershipOrganizationId: conflictOrganization.id,
        membershipRole: 'SUPER_ADMIN',
        membershipActive: true,
      });
    }

    const disabledOrganization = db.addOrganization({
      code: 'ORG-DISABLED',
      kind: 'PEER',
      isManagedCompany: true,
      status: 'SUSPENDED',
    });

    return {
      boundOrganization,
      unconfiguredOrganization,
      conflictOrganization,
      disabledOrganization,
    };
  }

  it('只读盘点区分正确唯一、缺失、冲突与公司停用', async () => {
    const db = new FakeAdminDatabase();
    const { unconfiguredOrganization } = seedInventory(db);
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);

    const report = await inspectAdminBindingInventory(db.manager(), cipher);

    expect(report.summary).toEqual({
      total: 4,
      bound: 1,
      unconfigured: 1,
      conflict: 1,
      companyDisabled: 1,
      manual: 2,
    });
    const byCode = new Map(report.items.map((item) => [item.organizationCode, item]));
    expect(byCode.get('ORG-BOUND')).toMatchObject({
      status: 'BOUND',
      action: 'NONE',
      boundLoginNameMasked: 'b***n',
    });
    expect(byCode.get('ORG-UNCONFIGURED')?.planId).toBe(
      buildAdminBindingPlanId('UNCONFIGURED', unconfiguredOrganization.id),
    );
    expect(byCode.get('ORG-CONFLICT')).toMatchObject({
      status: 'CONFLICT',
      reason: 'MULTIPLE_BINDINGS',
      action: 'MANUAL',
    });
    expect(byCode.get('ORG-DISABLED')).toMatchObject({
      status: 'COMPANY_DISABLED',
      action: 'MANUAL',
    });
    expect(byCode.get('ORG-CONFLICT')?.candidates.map((item) => item.loginNameMasked)).toEqual([
      'c***e',
      'c***o',
    ]);
    expect(db.insertCount()).toBe(0);
  });

  it('批准清单包含非缺失项时整批拒绝且零写入', async () => {
    const db = new FakeAdminDatabase();
    const { boundOrganization } = seedInventory(db);
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const insertsBefore = db.insertCount();

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: [buildAdminBindingPlanId('BOUND', boundOrganization.id)],
        managedCompanyEntries: parseAdminBootstrapConfig(
          buildV2Config([{ organizationCode: 'ORG-BOUND', loginName: 'new-bound' }]),
        ).defaultManagedCompanies,
        cipher,
      }),
    ).rejects.toThrow(/只允许应用缺失绑定项/);
    expect(db.insertCount()).toBe(insertsBefore);
  });

  it('缺失项缺少显式二级账号映射时整批拒绝', async () => {
    const db = new FakeAdminDatabase();
    const { unconfiguredOrganization } = seedInventory(db);
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const insertsBefore = db.insertCount();

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: [buildAdminBindingPlanId('UNCONFIGURED', unconfiguredOrganization.id)],
        managedCompanyEntries: [],
        cipher,
      }),
    ).rejects.toThrow(/缺少公司 ORG-UNCONFIGURED 的二级账号映射/);
    expect(db.insertCount()).toBe(insertsBefore);
  });

  it('批准缺失项后只新建 1 个账号，重跑不再新增', async () => {
    const db = new FakeAdminDatabase();
    const { unconfiguredOrganization } = seedInventory(db);
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const planId = buildAdminBindingPlanId('UNCONFIGURED', unconfiguredOrganization.id);
    const managedCompanyEntries = parseAdminBootstrapConfig(
      buildV2Config([{ organizationCode: 'ORG-UNCONFIGURED', loginName: 'fresh-managed' }]),
    ).defaultManagedCompanies;
    const insertsBefore = db.insertCount();

    const applied = await applyAdminBindingInventory(db.manager(), {
      approvedPlanIds: [planId],
      managedCompanyEntries,
      cipher,
    });

    expect(applied).toEqual([
      {
        planId,
        organizationCode: 'ORG-UNCONFIGURED',
        loginName: 'fresh-managed',
        outcome: 'CREATED',
      },
    ]);
    expect(db.insertCount()).toBe(insertsBefore + 3);
    expect(db.findAccount('fresh-managed')).toMatchObject({
      adminLevel: 2,
      membershipOrganizationId: unconfiguredOrganization.id,
      membershipRole: 'SUPER_ADMIN',
    });

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: [planId],
        managedCompanyEntries,
        cipher,
      }),
    ).rejects.toThrow(/当前盘点不存在该 ID/);
    expect(db.insertCount()).toBe(insertsBefore + 3);
  });

  it('缺失绑定但映射账号已存在时拒绝应用且不改动既有账号', async () => {
    const db = new FakeAdminDatabase();
    const { unconfiguredOrganization } = seedInventory(db);
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    db.addAccount({ loginName: 'fresh-managed', adminLevel: null });
    const insertsBefore = db.insertCount();

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: [buildAdminBindingPlanId('UNCONFIGURED', unconfiguredOrganization.id)],
        managedCompanyEntries: parseAdminBootstrapConfig(
          buildV2Config([{ organizationCode: 'ORG-UNCONFIGURED', loginName: 'fresh-managed' }]),
        ).defaultManagedCompanies,
        cipher,
      }),
    ).rejects.toThrow(/拒绝复用、补级或改绑/);
    expect(db.findAccount('fresh-managed')?.adminLevel).toBeNull();
    expect(db.insertCount()).toBe(insertsBefore);
  });

  it('批准清单为空或重复时直接拒绝', async () => {
    const db = new FakeAdminDatabase();
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: [],
        managedCompanyEntries: [],
        cipher,
      }),
    ).rejects.toThrow(/至少一个已审查的待处理 ID/);

    await expect(
      applyAdminBindingInventory(db.manager(), {
        approvedPlanIds: ['L2-UNCONFIGURED-1', 'L2-UNCONFIGURED-1'],
        managedCompanyEntries: [],
        cipher,
      }),
    ).rejects.toThrow(/存在重复/);
  });
});
