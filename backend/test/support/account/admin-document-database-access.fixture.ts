// test/support/account/admin-document-database-access.fixture.ts

import { createAdminOrganizationFact } from './admin-user.fixture';

/**
 * 管理员文档数据库全域入口（F1）授权依赖的共享替身。
 *
 * 缺省为「一级管理员 + 单一有效组织成员」的正常前置：
 * - `findAdminLevelByAccountId` 返回 1；
 * - `resolveForAccount` 返回有效成员事实。
 *
 * 拒绝分支由各用例按需覆盖（等级 2/null、成员解析抛错），不在缺省值里预置失败，
 * 避免既有通过用例被连带改红。
 */
export const createAdminDocumentDatabaseAccessMocks = (): {
  readonly findAdminLevelByAccountId: jest.Mock;
  readonly resolveForAccount: jest.Mock;
  /** 覆盖当前等级事实（null 表示账号存在但未映射等级） */
  readonly setAdminLevel: (level: number | null) => void;
  /** 覆盖成员解析结果（null 表示恢复缺省有效成员） */
  readonly setMembershipError: (error: Error | null) => void;
} => {
  let membershipError: Error | null = null;
  let adminLevel: number | null = 1;

  const findAdminLevelByAccountId = jest.fn(() => Promise.resolve(adminLevel));
  const resolveForAccount = jest.fn(() => {
    if (membershipError) {
      return Promise.reject(membershipError);
    }
    return Promise.resolve(createAdminOrganizationFact());
  });

  return {
    findAdminLevelByAccountId,
    resolveForAccount,
    setAdminLevel: (level) => {
      adminLevel = level;
    },
    setMembershipError: (error) => {
      membershipError = error;
    },
  };
};
