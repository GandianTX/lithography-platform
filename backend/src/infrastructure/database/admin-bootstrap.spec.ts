import type { EntityManager } from 'typeorm';

import { createFieldCipher } from '../field-encryption/field-encryption.cipher';
import { applyAdminBootstrap, parseAdminBootstrapConfig } from './admin-bootstrap';

const TEST_KEY = '0123456789abcdef';
const TEST_IV = 'abcdef0123456789';

const validAdminFile = JSON.stringify({
  schema_version: 1,
  accounts: [
    {
      login_name: 'admin01',
      login_email: 'admin01@example.com',
      password: 'Xk7#mQ2!vR9',
      admin_level: 1,
      organization_code: 'ORG-CLIENT-A',
      nickname: '管理员一',
      real_name: '张三',
    },
  ],
});

describe('管理员初始化邮箱冲突（伪 EntityManager）', () => {
  function buildManager(params: {
    readonly existingEmailOwner: string | null;
    readonly account?: Record<string, unknown> | null;
    readonly membership?: ReadonlyArray<Record<string, unknown>>;
    readonly emailOwnerEmail?: string;
  }): {
    readonly manager: EntityManager;
    readonly queries: string[];
  } {
    const queries: string[] = [];
    const manager = {
      query: jest.fn((sql: string, parameters?: ReadonlyArray<unknown>): Promise<unknown> => {
        queries.push(sql);
        if (sql.includes('FROM `organization`')) {
          return Promise.resolve([
            {
              id: 3,
              kind: 'CLIENT',
              is_managed_company: 1,
              is_service_provider: 0,
              status: 'ACTIVE',
            },
          ]);
        }
        if (sql.includes('FROM `base_user_account` AS a')) {
          return Promise.resolve(
            params.account === null || params.account === undefined ? [] : [params.account],
          );
        }
        if (sql.includes('FROM `organization_membership`')) {
          return Promise.resolve(params.membership ?? []);
        }
        if (sql.includes('FROM `base_user_account`')) {
          const email = parameters?.[0];
          if (params.existingEmailOwner === null) {
            return Promise.resolve([]);
          }
          if (params.emailOwnerEmail !== undefined && email !== params.emailOwnerEmail) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ login_name: params.existingEmailOwner }]);
        }
        return Promise.resolve([]);
      }),
    };
    return { manager: manager as unknown as EntityManager, queries };
  }

  it('管理员邮箱已被开发账号占用时拒绝创建且零写入', async () => {
    const { manager, queries } = buildManager({ existingEmailOwner: 'dev-customer-01' });

    await expect(
      applyAdminBootstrap(
        {} as never,
        parseAdminBootstrapConfig(validAdminFile),
        { fieldEncryptionKey: TEST_KEY, fieldEncryptionIv: TEST_IV },
        manager,
      ),
    ).rejects.toThrow(/邮箱 admin01@example\.com 已被账号 dev-customer-01 占用/);
    expect(queries.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('已存在管理员的映射邮箱改为另一账号实际邮箱时整批拒绝且零写入', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      existingEmailOwner: 'dev-engineer-01',
      account: {
        id: 5,
        admin_level: 1,
        identity_hint: 'SUPER_ADMIN',
        account_status: 'ACTIVE',
        info_id: 51,
        customer_organization_id: 3,
        access_group: '["SUPER_ADMIN"]',
        meta_digest: cipher.encrypt('["SUPER_ADMIN"]'),
        user_state: 'ACTIVE',
        login_email: 'admin01@example.com',
      },
      membership: [{ member_role: 'SUPER_ADMIN', left_at: null }],
    });

    await expect(
      applyAdminBootstrap(
        {} as never,
        parseAdminBootstrapConfig(validAdminFile),
        { fieldEncryptionKey: TEST_KEY, fieldEncryptionIv: TEST_IV },
        manager,
      ),
    ).rejects.toThrow(/邮箱 admin01@example\.com 已被账号 dev-engineer-01 占用/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('既有管理员邮箱与映射邮箱不同但未被占用时明确拒绝，不接管', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      existingEmailOwner: null,
      account: {
        id: 5,
        admin_level: 1,
        identity_hint: 'SUPER_ADMIN',
        account_status: 'ACTIVE',
        info_id: 51,
        customer_organization_id: 3,
        access_group: '["SUPER_ADMIN"]',
        meta_digest: cipher.encrypt('["SUPER_ADMIN"]'),
        user_state: 'ACTIVE',
        login_email: 'existing-admin@example.com',
      },
      membership: [{ member_role: 'SUPER_ADMIN', left_at: null }],
    });

    await expect(
      applyAdminBootstrap(
        {} as never,
        parseAdminBootstrapConfig(validAdminFile),
        { fieldEncryptionKey: TEST_KEY, fieldEncryptionIv: TEST_IV },
        manager,
      ),
    ).rejects.toThrow(/既有邮箱 existing-admin@example\.com 与映射邮箱/);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
  });

  it('合法原映射复跑返回 UNCHANGED 且不写账号事实', async () => {
    const cipher = createFieldCipher(TEST_KEY, TEST_IV);
    const { manager, queries } = buildManager({
      existingEmailOwner: 'admin01',
      emailOwnerEmail: 'admin01@example.com',
      account: {
        id: 5,
        admin_level: 1,
        identity_hint: 'SUPER_ADMIN',
        account_status: 'ACTIVE',
        info_id: 51,
        customer_organization_id: 3,
        access_group: '["SUPER_ADMIN"]',
        meta_digest: cipher.encrypt('["SUPER_ADMIN"]'),
        user_state: 'ACTIVE',
        login_email: 'admin01@example.com',
      },
      membership: [{ member_role: 'SUPER_ADMIN', left_at: null }],
    });

    const results = await applyAdminBootstrap(
      {} as never,
      parseAdminBootstrapConfig(validAdminFile),
      { fieldEncryptionKey: TEST_KEY, fieldEncryptionIv: TEST_IV },
      manager,
    );

    expect(results).toEqual([
      {
        loginName: 'admin01',
        adminLevel: 1,
        organizationCode: 'ORG-CLIENT-A',
        outcome: 'UNCHANGED',
      },
    ]);
    expect(queries.some((sql) => sql.includes('UPDATE `base_user_account`'))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });
});
