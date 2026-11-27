/// <reference types="jest" />
import type { LocalRuntimeViewerScope } from './local-runtime-viewer-scope.policy';
import {
  resolveSyncConflictAccess,
  type SyncConflictAccessFacts,
} from './sync-conflict-access.policy';

/**
 * 冲突读取的记录级授权（任务 09 后续S2·S2.2）。
 *
 * 覆盖口径：读不到来源记录事实即不放行；一级管理员全局放行；
 * 工程师／二级管理员按记录归属核对公司，区分本人与同公司；
 * 跨公司与归属未知一律拒绝。
 */
describe('resolveSyncConflictAccess（冲突读取记录级授权）', () => {
  const engineerScope: LocalRuntimeViewerScope = {
    role: 'ENGINEER',
    organizationId: 4,
    adminLevel: null,
  };
  const adminScope: LocalRuntimeViewerScope = {
    role: 'ADMIN_LEVEL_1',
    organizationId: null,
    adminLevel: 1,
  };

  const baseFacts = (
    overrides: Partial<SyncConflictAccessFacts> = {},
  ): SyncConflictAccessFacts => ({
    sessionAccountId: 900101,
    scope: engineerScope,
    conflictOrganizationId: 4,
    recordResolved: true,
    ownerOrganizationId: 4,
    relatedAccountIds: [900101],
    ...overrides,
  });

  it('记录事实不可取得时不放行（读不到授权依据不等于有权看）', () => {
    const result = resolveSyncConflictAccess(baseFacts({ recordResolved: false }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DENIED_RECORD_UNRESOLVED');
  });

  it('一级管理员为全局授权范围，直接放行', () => {
    const result = resolveSyncConflictAccess(
      baseFacts({ scope: adminScope, ownerOrganizationId: 9, relatedAccountIds: [] }),
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ADMIN_GLOBAL');
  });

  it('同公司且为本人时按本人放行', () => {
    const result = resolveSyncConflictAccess(baseFacts());

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('SELF');
  });

  it('同公司但非本人时按同公司放行', () => {
    const result = resolveSyncConflictAccess(baseFacts({ relatedAccountIds: [900202] }));

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('SAME_COMPANY');
  });

  it('记录归属跨公司时拒绝', () => {
    const result = resolveSyncConflictAccess(baseFacts({ ownerOrganizationId: 5 }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DENIED_COMPANY');
  });

  it('记录归属未知时拒绝（不猜归属）', () => {
    const result = resolveSyncConflictAccess(baseFacts({ ownerOrganizationId: null }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DENIED_UNKNOWN_OWNER');
  });
});
