// src/usecases/maintenance-report/maintenance-report-reader-scope.spec.ts
// 「我的资料记录」读者范围决议的失败关闭回归（2026-11-21 平台级角色口径确认）。
//
// 覆盖目标（安全核对结论的固化）：
// - 一级管理员（SUPER_ADMIN 且 admin_level=1）是平台级角色：短路返回，
//   不解析组织成员关系，列表/详情只按作者谓词；
// - 二级管理员与缺等级管理员：回退可信组织成员关系，公司范围不被放宽；
// - 等级事实不可用（账号行缺失）与身份异常（无成员关系 / 多重成员关系）：
//   一律失败关闭向上抛错，绝不降级为「空列表」或「全范围」；
// - 非管理员（工程师）：不查等级，直接组织解析。

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import { ACCOUNT_ERROR, ORGANIZATION_ERROR } from '@core/common/errors/domain-error';
import { resolveMyMaintenanceReportReaderScope } from './maintenance-report-reader-scope';

const ORG_ID = 910001;

const makeSession = (
  overrides: Partial<{ accountId: number; roles: string[]; activeRole: string }> = {},
): UsecaseSession =>
  ({
    accountId: 900001,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    ...overrides,
  }) as unknown as UsecaseSession;

type DepsError = Error & { code?: string };

const makeDeps = (params: { adminLevel?: number | null; membershipError?: DepsError } = {}) => {
  const adminLevelReader = {
    // 缺省 null（未映射等级）；undefined 表示本替身不应被调用
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(params.adminLevel ?? null),
  };
  const organizationContextService = {
    resolveForAccount:
      params.membershipError !== undefined
        ? jest.fn().mockRejectedValue(params.membershipError)
        : jest.fn().mockResolvedValue({ organizationId: ORG_ID, memberRole: 'ENGINEER' }),
  };
  return { adminLevelReader, organizationContextService };
};

describe('resolveMyMaintenanceReportReaderScope（我的资料记录读者范围）', () => {
  it('一级管理员（admin_level=1）：短路返回 FIRST_LEVEL_ADMIN，不解析组织成员关系', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({ adminLevel: 1 });

    const scope = await resolveMyMaintenanceReportReaderScope({
      session: makeSession({
        accountId: 900090,
        roles: ['SUPER_ADMIN'],
        activeRole: 'SUPER_ADMIN',
      }),
      adminLevelReader,
      organizationContextService,
    });

    expect(scope).toEqual({ kind: 'FIRST_LEVEL_ADMIN' });
    expect(adminLevelReader.findAdminLevelByAccountId).toHaveBeenCalledWith(900090);
    // 平台级角色不读取成员事实：即使存在技术性成员关系行也不得当作业务所属公司
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('二级管理员（admin_level=2）：回退组织成员关系，公司范围不被放宽', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({ adminLevel: 2 });

    const scope = await resolveMyMaintenanceReportReaderScope({
      session: makeSession({
        accountId: 900099,
        roles: ['SUPER_ADMIN'],
        activeRole: 'SUPER_ADMIN',
      }),
      adminLevelReader,
      organizationContextService,
    });

    expect(scope).toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900099,
    });
  });

  it('等级缺失（admin_level=null）：不按一级放行，回退组织成员关系', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({ adminLevel: null });

    const scope = await resolveMyMaintenanceReportReaderScope({
      session: makeSession({
        accountId: 900099,
        roles: ['SUPER_ADMIN'],
        activeRole: 'SUPER_ADMIN',
      }),
      adminLevelReader,
      organizationContextService,
    });

    expect(scope).toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
  });

  it('账号行缺失（等级事实不可用）：ACCOUNT_NOT_FOUND 传播，失败关闭，不回退组织解析', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({
      membershipError: Object.assign(new Error('不应回退到组织解析'), {
        code: ACCOUNT_ERROR.ACCOUNT_NOT_FOUND,
      }),
    });
    adminLevelReader.findAdminLevelByAccountId.mockRejectedValue({
      code: ACCOUNT_ERROR.ACCOUNT_NOT_FOUND,
    });

    await expect(
      resolveMyMaintenanceReportReaderScope({
        session: makeSession({
          accountId: 900099,
          roles: ['SUPER_ADMIN'],
          activeRole: 'SUPER_ADMIN',
        }),
        adminLevelReader,
        organizationContextService,
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_ERROR.ACCOUNT_NOT_FOUND });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('无有效组织成员关系：NO_ACTIVE_MEMBERSHIP 传播，失败关闭，不是空态也不是全范围', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({
      membershipError: Object.assign(new Error('无有效组织成员关系'), {
        code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      }),
    });

    await expect(
      resolveMyMaintenanceReportReaderScope({
        session: makeSession({
          accountId: 900099,
          roles: ['SUPER_ADMIN'],
          activeRole: 'SUPER_ADMIN',
        }),
        adminLevelReader,
        organizationContextService,
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
  });

  it('多重组织成员关系：AMBIGUOUS_MEMBERSHIP 传播，失败关闭', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps({
      membershipError: Object.assign(new Error('多重组织成员关系'), {
        code: ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
      }),
    });

    await expect(
      resolveMyMaintenanceReportReaderScope({
        session: makeSession({
          accountId: 900099,
          roles: ['SUPER_ADMIN'],
          activeRole: 'SUPER_ADMIN',
        }),
        adminLevelReader,
        organizationContextService,
      }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP });
  });

  it('非管理员（工程师）：不查等级事实，直接按可信组织成员关系收敛本公司', async () => {
    const { adminLevelReader, organizationContextService } = makeDeps();

    const scope = await resolveMyMaintenanceReportReaderScope({
      session: makeSession({ accountId: 900001, roles: ['ENGINEER'], activeRole: 'ENGINEER' }),
      adminLevelReader,
      organizationContextService,
    });

    expect(scope).toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
    expect(adminLevelReader.findAdminLevelByAccountId).not.toHaveBeenCalled();
    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900001,
    });
  });
});
