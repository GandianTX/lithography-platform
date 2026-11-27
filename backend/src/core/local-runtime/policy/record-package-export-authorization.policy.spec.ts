/// <reference types="jest" />

/**
 * 导出逐条记录级授权的定向测试（任务 09 S1-3）。
 *
 * 守住四类反例：同公司他人草稿（工程师越权）、同公司他人正式资料（工程师越权）、
 * 归属未知（不猜归属）、跨公司直接请求（拒绝）。
 */

import {
  describeRecordPackageExportDenial,
  resolveRecordPackageExportAuthorization,
} from './record-package-export-authorization.policy';

const ENGINEER_SCOPE = {
  role: 'ENGINEER' as const,
  organizationId: 9,
  adminLevel: null,
};
const LEVEL2_SCOPE = {
  role: 'ADMIN_LEVEL_2' as const,
  organizationId: 9,
  adminLevel: 2 as const,
};
const LEVEL1_SCOPE = {
  role: 'ADMIN_LEVEL_1' as const,
  organizationId: null,
  adminLevel: 1 as const,
};

describe('记录包导出逐条授权（S1-3）', () => {
  it('工程师导出本人创建的报告：放行', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: ENGINEER_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: 9, relatedAccountIds: [900101, 900202] },
    });

    expect(outcome).toEqual({ allowed: true, reason: 'AUTHOR_SELF' });
  });

  it('工程师导出同公司他人草稿：拒绝（逐条原因可读）', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: ENGINEER_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: 9, relatedAccountIds: [900202] },
    });

    expect(outcome.allowed).toBe(false);
    expect(describeRecordPackageExportDenial(outcome.reason)).toContain('本人创建');
  });

  it('工程师导出同公司他人正式资料：拒绝', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: ENGINEER_SCOPE,
      resourceType: 'REFERENCE_DOCUMENT',
      record: { ownerOrganizationId: 9, relatedAccountIds: [900202] },
    });

    expect(outcome.allowed).toBe(false);
  });

  it('工程师导出本公司工单：放行（来源域工程师可见本公司全部工单）', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: ENGINEER_SCOPE,
      resourceType: 'REPAIR_REQUEST',
      record: { ownerOrganizationId: 9, relatedAccountIds: [900303] },
    });

    expect(outcome).toEqual({ allowed: true, reason: 'COMPANY_SCOPE' });
  });

  it('二级管理员：本公司范围放行', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: LEVEL2_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: 9, relatedAccountIds: [900202] },
    });

    expect(outcome).toEqual({ allowed: true, reason: 'COMPANY_SCOPE' });
  });

  it('一级管理员：全局范围放行', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: LEVEL1_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: 999, relatedAccountIds: [900202] },
    });

    expect(outcome).toEqual({ allowed: true, reason: 'ADMIN_GLOBAL' });
  });

  it('归属未知：不猜归属，拒绝', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: LEVEL2_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: null, relatedAccountIds: [900101] },
    });

    expect(outcome).toEqual({ allowed: false, reason: 'DENIED_UNKNOWN_OWNER' });
  });

  it('跨公司直接请求：拒绝', () => {
    const outcome = resolveRecordPackageExportAuthorization({
      sessionAccountId: 900101,
      scope: LEVEL2_SCOPE,
      resourceType: 'MAINTENANCE_REPORT',
      record: { ownerOrganizationId: 10, relatedAccountIds: [900101] },
    });

    expect(outcome).toEqual({ allowed: false, reason: 'DENIED_COMPANY' });
  });
});
