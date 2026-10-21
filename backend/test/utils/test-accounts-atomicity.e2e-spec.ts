// test/utils/test-accounts-atomicity.e2e-spec.ts
//
// PR0 复核 V01：账号造数原子性与失败收敛。
// 纯内存 fake DataSource，不连接数据库；验证：
// - 回落路径的账号插入/密码回写/user_info 写入同事务，任一阶段失败整体回滚；
// - 事务提交成功即登记 ownership，不推迟到调用方完整返回；
// - seedTestAccounts 使用 allSettled，一项失败时等待其他造数收敛后再抛错。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import type { DataSource } from 'typeorm';

import { createOwnedResourceLedger } from './e2e-scoped-cleanup';
import {
  createTestAccount,
  seedTestAccounts,
  testAccountsConfig,
  type TestAccountConfig,
} from './test-accounts';

type FailureStage = 'account-save' | 'password-update' | 'userinfo-save';

interface FakeAccountRow {
  id: number;
  loginName: string;
  loginEmail: string;
  loginPassword: string;
  createdAt: Date;
}

interface FakeUserInfoRow {
  accountId: number;
  nickname: string;
}

interface FakeAccountRepository {
  create(data: Partial<FakeAccountRow>): FakeAccountRow;
  save(entity: FakeAccountRow): Promise<FakeAccountRow>;
  update(id: number, patch: { loginPassword: string }): Promise<unknown>;
}

interface FakeUserInfoRepository {
  create(data: Partial<FakeUserInfoRow>): FakeUserInfoRow;
  save(entity: FakeUserInfoRow): Promise<FakeUserInfoRow>;
}

interface FakeDb {
  committedAccounts: Map<number, FakeAccountRow>;
  committedUserInfos: Map<number, FakeUserInfoRow>;
  dataSource: DataSource;
}

/**
 * 每个事务有独立 staging；提交时合并，抛错时丢弃（模拟真实事务回滚）。
 * behavior 允许按登录名注入不同阶段的失败与延迟。
 */
const createFakeDataSource = (options: {
  failAt?: FailureStage;
  behavior?: (cfg: TestAccountConfig) => { failAt?: FailureStage; delayMs?: number } | undefined;
}): FakeDb => {
  const committedAccounts = new Map<number, FakeAccountRow>();
  const committedUserInfos = new Map<number, FakeUserInfoRow>();
  let nextId = 1000;

  const dataSource = {
    transaction: async <T>(run: (manager: unknown) => Promise<T>): Promise<T> => {
      const stagedAccounts = new Map<number, FakeAccountRow>();
      const stagedUserInfos = new Map<number, FakeUserInfoRow>();
      let effective: { failAt?: FailureStage; delayMs: number } = {
        failAt: options.failAt,
        delayMs: 0,
      };

      const accountRepo: FakeAccountRepository = {
        create: (data) => ({
          id: nextId++,
          loginName: String(data.loginName),
          loginEmail: String(data.loginEmail),
          loginPassword: String(data.loginPassword),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        save: async (entity) => {
          const behavior = options.behavior?.({
            loginName: entity.loginName,
            loginEmail: entity.loginEmail,
            loginPassword: entity.loginPassword,
            status: AccountStatus.ACTIVE,
            accessGroup: [IdentityTypeEnum.ENGINEER],
            identityType: IdentityTypeEnum.ENGINEER,
          });
          if (behavior) {
            effective = {
              failAt: behavior.failAt ?? options.failAt,
              delayMs: behavior.delayMs ?? 0,
            };
            if (effective.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, effective.delayMs));
            }
          }
          if (effective.failAt === 'account-save') {
            throw new Error('注入失败：账号插入');
          }
          stagedAccounts.set(entity.id, entity);
          return entity;
        },
        update: (id, patch) => {
          if (effective.failAt === 'password-update') {
            return Promise.reject(new Error('注入失败：密码回写'));
          }
          const row = stagedAccounts.get(id);
          if (!row) return Promise.reject(new Error('账号不存在'));
          row.loginPassword = patch.loginPassword;
          return Promise.resolve({ affected: 1 });
        },
      };

      const userInfoRepo: FakeUserInfoRepository = {
        create: (data) => ({
          accountId: Number(data.accountId),
          nickname: String(data.nickname),
        }),
        save: (entity) => {
          if (effective.failAt === 'userinfo-save') {
            return Promise.reject(new Error('注入失败：user_info 写入'));
          }
          stagedUserInfos.set(entity.accountId, entity);
          return Promise.resolve(entity);
        },
      };

      const manager = {
        getRepository: (target: unknown): FakeAccountRepository | FakeUserInfoRepository => {
          if (target === AccountEntity) {
            return accountRepo;
          }
          if (target === UserInfoEntity) {
            return userInfoRepo;
          }
          throw new Error('未识别的 Repository');
        },
      };

      try {
        const result = await run(manager);
        for (const [id, row] of stagedAccounts) {
          committedAccounts.set(id, row);
        }
        for (const [accountId, row] of stagedUserInfos) {
          committedUserInfos.set(accountId, row);
        }
        return result;
      } finally {
        stagedAccounts.clear();
        stagedUserInfos.clear();
      }
    },
  };

  return { committedAccounts, committedUserInfos, dataSource: dataSource as unknown as DataSource };
};

const config = (key: keyof typeof testAccountsConfig): TestAccountConfig => testAccountsConfig[key];

describe('账号造数原子性（V01）', () => {
  it.each<FailureStage>(['account-save', 'password-update', 'userinfo-save'])(
    '%s 阶段失败：事务回滚，无半账号与归属登记',
    async (failAt) => {
      const db = createFakeDataSource({ failAt });
      const ledger = createOwnedResourceLedger();

      await expect(createTestAccount(db.dataSource, null, config('staff'), ledger)).rejects.toThrow(
        /注入失败/,
      );

      expect(db.committedAccounts.size).toBe(0);
      expect(db.committedUserInfos.size).toBe(0);
      expect(ledger.accountIds).toEqual([]);
    },
  );

  it('成功提交后立即登记真实账号 ID，且 user_info 完整', async () => {
    const db = createFakeDataSource({});
    const ledger = createOwnedResourceLedger();

    const created = await createTestAccount(db.dataSource, null, config('staff'), ledger);

    expect(db.committedAccounts.has(created.accountId)).toBe(true);
    expect(db.committedUserInfos.has(created.accountId)).toBe(true);
    expect(ledger.accountIds).toEqual([created.accountId]);
  });

  it('一项失败而另一项延迟成功：seedTestAccounts 等待全部收敛后抛错并登记成功项', async () => {
    const failingLogin = config('staff').loginName;
    const db = createFakeDataSource({
      behavior: (cfg) =>
        cfg.loginName === failingLogin ? { failAt: 'userinfo-save', delayMs: 10 } : { delayMs: 60 },
    });
    const ledger = createOwnedResourceLedger();

    await expect(
      seedTestAccounts({
        dataSource: db.dataSource,
        includeKeys: ['staff', 'staffPrimary'],
        ownership: ledger,
      }),
    ).rejects.toThrow('注入失败：user_info 写入');

    // 抛错时刻晚到的成功项必须已经提交并登记，不能遗留 afterAll 之后的在途写
    expect(ledger.accountIds).toHaveLength(1);
    const successfulId = ledger.accountIds[0];
    expect(db.committedAccounts.has(successfulId)).toBe(true);
    expect(db.committedUserInfos.has(successfulId)).toBe(true);
    expect(db.committedAccounts.size).toBe(1);
  });
});
