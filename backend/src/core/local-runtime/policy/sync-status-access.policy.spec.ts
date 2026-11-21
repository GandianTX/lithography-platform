/// <reference types="jest" />
import type { LocalRuntimeViewerScope } from './local-runtime-viewer-scope.policy';
import { resolveSyncStatusAccess } from './sync-status-access.policy';

describe('resolveSyncStatusAccess（同步状态记录级授权）', () => {
  const engineerScope: LocalRuntimeViewerScope = {
    role: 'ENGINEER',
    organizationId: 4,
    adminLevel: null,
  };
  const adminLevel2Scope: LocalRuntimeViewerScope = {
    role: 'ADMIN_LEVEL_2',
    organizationId: 4,
    adminLevel: 2,
  };
  const adminLevel1Scope: LocalRuntimeViewerScope = {
    role: 'ADMIN_LEVEL_1',
    organizationId: null,
    adminLevel: 1,
  };

  it('一级管理员为全局授权范围，直接放行', () => {
    const result = resolveSyncStatusAccess({
      sessionAccountId: 1,
      scope: adminLevel1Scope,
      ownerOrganizationId: 99,
      relatedAccountIds: [],
    });

    expect(result).toEqual({ allowed: true, reason: 'ADMIN_GLOBAL' });
  });

  it('同公司且为本人时按本人放行', () => {
    const result = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: engineerScope,
      ownerOrganizationId: 4,
      relatedAccountIds: [900101, 900102],
    });

    expect(result).toEqual({ allowed: true, reason: 'SELF' });
  });

  it('同公司但非本人时按同公司放行', () => {
    const result = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: engineerScope,
      ownerOrganizationId: 4,
      relatedAccountIds: [900102],
    });

    expect(result).toEqual({ allowed: true, reason: 'SAME_COMPANY' });
  });

  it('跨公司记录一律拒绝', () => {
    const result = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: engineerScope,
      ownerOrganizationId: 5,
      relatedAccountIds: [900101],
    });

    expect(result).toEqual({ allowed: false, reason: 'DENIED_COMPANY' });
  });

  it('归属未知（无证据）时拒绝放行', () => {
    const result = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: engineerScope,
      ownerOrganizationId: null,
      relatedAccountIds: [900101],
    });

    expect(result).toEqual({ allowed: false, reason: 'DENIED_UNKNOWN_OWNER' });
  });

  it('二级管理员同样按可信公司核对归属', () => {
    const denied = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: adminLevel2Scope,
      ownerOrganizationId: 5,
      relatedAccountIds: [],
    });
    expect(denied).toEqual({ allowed: false, reason: 'DENIED_COMPANY' });

    const allowed = resolveSyncStatusAccess({
      sessionAccountId: 900101,
      scope: adminLevel2Scope,
      ownerOrganizationId: 4,
      relatedAccountIds: [],
    });
    expect(allowed).toEqual({ allowed: true, reason: 'SAME_COMPANY' });
  });
});
