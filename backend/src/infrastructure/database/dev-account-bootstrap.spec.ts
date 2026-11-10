import type { EntityManager } from 'typeorm';

import { createFieldCipher } from '../field-encryption/field-encryption.cipher';
import {
  applyDevAccountBootstrap,
  assertDevAccountTargetDatabase,
  parseDevAccountBootstrapConfig,
  type DevAccountBootstrapConfig,
} from './dev-account-bootstrap';

const TEST_KEY = '0123456789abcdef';
const TEST_IV = 'abcdef0123456789';

const validFile = JSON.stringify({
  schema_version: 1,
  customers: [
    {
      login_name: 'dev-customer-01',
      login_email: 'dev-customer-01@example.com',
      password: 'Xk7#mQ2!vR9',
      nickname: '开发客户一',
      real_name: '客户一',
      organization_code: 'ORG-CLIENT-A',
    },
    {
      login_name: 'dev-customer-02',
      password: 'Zt5$nW8@uP3',
      nickname: '开发客户二',
      organization_code: 'ORG-CLIENT-A',
    },
  ],
  engineers: [
    {
      login_name: 'dev-engineer-01',
      login_email: 'dev-engineer-01@example.com',
      password: 'Hj4%kL6^bN2',
      nickname: '开发工程师一',
      organization_code: 'ORG-PEER-A',
    },
    {
      login_name: 'dev-engineer-02',
      password: 'Qw1&eR7*tY5',
      nickname: '开发工程师二',
      organization_code: 'ORG-PEER-A',
    },
  ],
});

function parseValid(): DevAccountBootstrapConfig {
  return parseDevAccountBootstrapConfig(validFile);
}

function mutateFirst(list: Array<Record<string, unknown>>, patch: Record<string, unknown>): void {
  const first = list[0];
  if (!first) {
    throw new Error('测试夹具缺少第一条记录');
  }
  Object.assign(first, patch);
}

describe('开发账号映射文件（不连接实库）', () => {
  it('合法映射保留客户与工程师数量及公司', () => {
    const config = parseValid();
    expect(config.customers).toHaveLength(2);
    expect(config.engineers).toHaveLength(2);
    expect(config.engineers[1]).toMatchObject({
      loginName: 'dev-engineer-02',
      organizationCode: 'ORG-PEER-A',
    });
  });

  it('缺少列表、合计为空、重复账号/邮箱与未知字段均失败关闭', () => {
    expect(() =>
      parseDevAccountBootstrapConfig(JSON.stringify({ schema_version: 1, customers: [] })),
    ).toThrow(/engineers/);
    expect(() =>
      parseDevAccountBootstrapConfig(
        JSON.stringify({ schema_version: 1, customers: [], engineers: [] }),
      ),
    ).toThrow(/至少包含 1 个账号/);

    const duplicateLogin = JSON.parse(validFile) as {
      engineers: Array<Record<string, unknown>>;
    };
    mutateFirst(duplicateLogin.engineers, { login_name: 'dev-customer-01' });
    expect(() => parseDevAccountBootstrapConfig(JSON.stringify(duplicateLogin))).toThrow(
      /重复账号/,
    );

    const duplicateEmail = JSON.parse(validFile) as {
      engineers: Array<Record<string, unknown>>;
    };
    mutateFirst(duplicateEmail.engineers, {
      login_email: 'dev-customer-01@example.com',
    });
    expect(() => parseDevAccountBootstrapConfig(JSON.stringify(duplicateEmail))).toThrow(
      /重复邮箱/,
    );

    const unknownField = JSON.parse(validFile) as {
      customers: Array<Record<string, unknown>>;
    };
    mutateFirst(unknownField.customers, { role: 'CUSTOMER' });
    expect(() => parseDevAccountBootstrapConfig(JSON.stringify(unknownField))).toThrow(
      /不支持的字段/,
    );
  });

  it('目标库安全门只接受带开发标记的库名', () => {
    for (const database of ['app_dev', 'app_test', 'app-local', 'drill_01']) {
      expect(() => assertDevAccountTargetDatabase(database)).not.toThrow();
    }
    for (const database of ['lithography', 'lithography_prod', 'production']) {
      expect(() => assertDevAccountTargetDatabase(database)).toThrow(/开发或测试库/);
    }
  });
});

describe('开发账号初始化写入契约（伪 EntityManager）', () => {
  function buildManager(params: {
    readonly account: Record<string, unknown> | null;
    readonly accounts?: Readonly<Record<string, Record<string, unknown> | null>>;
    readonly membership: ReadonlyArray<Record<string, unknown>>;
    readonly kind?: string;
    readonly isManagedCompany?: number;
    readonly isServiceProvider?: number;
    readonly emailOwner?: string;
    readonly emailOwnerEmail?: string;
  }): { readonly manager: EntityManager; readonly queries: string[] } {
    const queries: string[] = [];
    const manager = {
      query: jest.fn((sql: string, parameters?: ReadonlyArray<unknown>): Promise<unknown> => {
        queries.push(sql);
        if (sql.includes('FROM `organization`')) {
          return Promise.resolve([
            {
              id: 3,
              kind: params.kind ?? 'PEER',
              is_managed_company: params.isManagedCompany ?? 1,
              is_service_provider: params.isServiceProvider ?? 1,
              status: 'ACTIVE',
            },
          ]);
        }
        if (sql.includes('FROM `base_user_account` AS a')) {
          const loginName = parameters?.[0];
          if (params.accounts !== undefined && typeof loginName === 'string') {
            return Promise.resolve(
              params.accounts[loginName] === null || params.accounts[loginName] === undefined
                ? []
                : [params.accounts[loginName]],
            );
          }
          return Promise.resolve(params.account === null ? [] : [params.account]);
        }
        if (sql.includes('FROM `organization_membership`')) {
          return Promise.resolve(params.membership);
        }
        if (sql.includes('FROM `base_user_account`')) {
          const email = parameters?.[0];
          if (params.emailOwner === undefined) {
            return Promise.resolve([]);
          }
          if (params.emailOwnerEmail !== undefined && email !== params.emailOwnerEmail) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ login_name: params.emailOwner }]);
        }
        if (sql.includes('LAST_INSERT_ID()')) {
          return Promise.resolve([{ account_id: 11 }]);
        }
        return Promise.resolve([]);
      }),
    };
    return { manager: manager as unknown as EntityManager, queries };
  }

  function engineerOnlyConfig(): DevAccountBootstrapConfig {
    return {
      schemaVersion: 1,
      customers: [],
      engineers: [
        {
          loginName: 'dev-engineer-01',
          loginEmail: 'dev-engineer-01@example.com',
          password: 'Hj4%kL6^bN2',
          nickname: '开发工程师一',
          realName: null,
          organizationCode: 'ORG-PEER-A',
        },
      ],
    };
  }

  it('密码不符合项目策略时在任何写库前失败', async () => {
    const config = parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [
          {
            login_name: 'dev-customer-weak',
            password: 'password123',
            nickname: '弱密码',
            organization_code: 'ORG-CLIENT-A',
          },
        ],
        engineers: [],
      }),
    );
    const { manager, queries } = buildManager({ account: null, membership: [] });

    await expect(
      applyDevAccountBootstrap(manager, config, {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/密码策略/);
    expect(queries).toHaveLength(0);
  });

  it('既有账号事实完整且成员关系一致时返回 UNCHANGED 且不重置密码', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'ENGINEER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: null,
        access_group: '["ENGINEER"]',
        meta_digest: cipher.encrypt('["ENGINEER"]'),
        user_state: 'ACTIVE',
        login_email: 'dev-engineer-01@example.com',
      },
      membership: [{ member_role: 'ENGINEER', left_at: null }],
    });

    const results = await applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
      fieldEncryptionKey: TEST_KEY,
      fieldEncryptionIv: TEST_IV,
    });

    expect(results).toEqual([
      {
        loginName: 'dev-engineer-01',
        role: 'ENGINEER',
        organizationCode: 'ORG-PEER-A',
        outcome: 'UNCHANGED',
      },
    ]);
    expect(queries.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('ACTIVE 但不在管理名单的公司拒绝创建工程师账号，即使 kind=PEER 也零写入', async () => {
    const { manager, queries } = buildManager({
      account: null,
      membership: [],
      kind: 'PEER',
      isManagedCompany: 0,
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/管理名单内公司/);
    expect(queries.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('名单内但无维修服务资格的公司允许创建工程师账号', async () => {
    const { manager } = buildManager({
      account: null,
      membership: [],
      kind: 'PEER',
      isManagedCompany: 1,
      isServiceProvider: 0,
    });

    const results = await applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
      fieldEncryptionKey: TEST_KEY,
      fieldEncryptionIv: TEST_IV,
    });

    expect(results).toEqual([
      {
        loginName: 'dev-engineer-01',
        role: 'ENGINEER',
        organizationCode: 'ORG-PEER-A',
        outcome: 'CREATED',
      },
    ]);
  });

  it('复跑时公司已不在管理名单则拒绝，不返回 UNCHANGED', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'ENGINEER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: null,
        access_group: '["ENGINEER"]',
        meta_digest: cipher.encrypt('["ENGINEER"]'),
        user_state: 'ACTIVE',
        login_email: 'dev-engineer-01@example.com',
      },
      membership: [{ member_role: 'ENGINEER', left_at: null }],
      isManagedCompany: 0,
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/管理名单内公司/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('既有工程师的映射邮箱已被其他账号占用时拒绝，不覆盖账号事实', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'ENGINEER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: null,
        access_group: '["ENGINEER"]',
        meta_digest: cipher.encrypt('["ENGINEER"]'),
        user_state: 'ACTIVE',
        login_email: 'dev-engineer-01@example.com',
      },
      membership: [{ member_role: 'ENGINEER', left_at: null }],
      emailOwner: 'dev-customer-02',
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/已被账号 dev-customer-02 占用/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('既有工程师的映射邮箱与既有邮箱不一致时明确拒绝，不接管', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'ENGINEER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: null,
        access_group: '["ENGINEER"]',
        meta_digest: cipher.encrypt('["ENGINEER"]'),
        user_state: 'ACTIVE',
        login_email: 'existing-engineer@example.com',
      },
      membership: [{ member_role: 'ENGINEER', left_at: null }],
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/既有邮箱 existing-engineer@example\.com 与映射邮箱/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('合法新增项在前、既有工程师邮箱冲突在后时整批失败且不覆盖既有账号', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const config = parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [
          {
            login_name: 'dev-customer-03',
            login_email: 'dev-customer-03@example.com',
            password: 'Rt8#yU3!iO6',
            nickname: '开发客户三',
            organization_code: 'ORG-CLIENT-A',
          },
        ],
        engineers: [
          {
            login_name: 'dev-engineer-01',
            login_email: 'dev-engineer-01@example.com',
            password: 'Hj4%kL6^bN2',
            nickname: '开发工程师一',
            organization_code: 'ORG-PEER-A',
          },
        ],
      }),
    );
    const { manager, queries } = buildManager({
      account: null,
      accounts: {
        ['dev-customer-03']: null,
        ['dev-engineer-01']: {
          id: 11,
          admin_level: null,
          identity_hint: 'ENGINEER',
          account_status: 'ACTIVE',
          info_id: 21,
          customer_organization_id: null,
          access_group: '["ENGINEER"]',
          meta_digest: cipher.encrypt('["ENGINEER"]'),
          user_state: 'ACTIVE',
          login_email: 'dev-engineer-01@example.com',
        },
      },
      membership: [{ member_role: 'ENGINEER', left_at: null }],
      emailOwner: 'dev-customer-99',
      emailOwnerEmail: 'dev-engineer-01@example.com',
    });

    await expect(
      applyDevAccountBootstrap(manager, config, {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/已被账号 dev-customer-99 占用/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('既有账号缺少 ACTIVE 成员关系时失败关闭，不自动授予', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'ENGINEER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: null,
        access_group: '["ENGINEER"]',
        meta_digest: cipher.encrypt('["ENGINEER"]'),
        user_state: 'ACTIVE',
        login_email: 'dev-engineer-01@example.com',
      },
      membership: [],
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/缺少 ACTIVE 成员关系/);
  });

  it('既有账号角色与样例不一致时失败关闭，不静默提权或降级', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager } = buildManager({
      account: {
        id: 11,
        admin_level: null,
        identity_hint: 'CUSTOMER',
        account_status: 'ACTIVE',
        info_id: 21,
        customer_organization_id: 3,
        access_group: '["CUSTOMER"]',
        meta_digest: cipher.encrypt('["CUSTOMER"]'),
        user_state: 'ACTIVE',
        login_email: 'dev-engineer-01@example.com',
      },
      membership: [{ member_role: 'CUSTOMER', left_at: null }],
    });

    await expect(
      applyDevAccountBootstrap(manager, engineerOnlyConfig(), {
        fieldEncryptionKey: TEST_KEY,
        fieldEncryptionIv: TEST_IV,
      }),
    ).rejects.toThrow(/与开发样例 ENGINEER 不一致/);
  });
});
