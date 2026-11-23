// src/usecases/local-runtime/export-record-package.usecase.spec.ts

/**
 * 记录包导出（用例层）。
 *
 * 守住：
 * - **混合导出**：一个包里可同时有 >=2 种资源类型（逐条自带类型）；
 * - **entries 优先**：给出 entries 时以它为准（旧单一类型形态保持兼容）；
 * - **公司范围**：工程师只能导出本公司；一级管理员可指定任意公司；
 * - **恢复期冻结**：该公司数据区正在恢复时不得导出；
 * - **参数受控**：资源类型不在白名单、目标目录非法 => 失败关闭。
 */
import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { RecordPackageExportService } from '@src/modules/lithography/record-package-export.service';

import { ExportRecordPackageUsecase } from './export-record-package.usecase';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

type Scope = {
  role: 'ENGINEER' | 'ADMIN_LEVEL_2' | 'ADMIN_LEVEL_1';
  organizationId: number | null;
  adminLevel: number | null;
};

describe('ExportRecordPackageUsecase（记录包导出）', () => {
  const session = { accountId: 21, accountUuid: 'uuid-21' } as never;

  const buildUsecase = (options: { scope: Scope; writeHoldError?: Error }) => {
    const scopeResolver = {
      resolve: jest.fn(() =>
        Promise.resolve({
          role: options.scope.role,
          organizationId: options.scope.organizationId,
          adminLevel: options.scope.adminLevel,
        }),
      ),
    } as unknown as LocalRuntimeScopeResolver;

    const exportPackage = jest.fn(
      (_command: {
        organizationId: number;
        targetPath: string;
        resourceType: string;
        recordIds: number[];
        entries?: { resourceType: string; recordId: number }[];
      }) =>
        Promise.resolve({
          packageId: 'pkg-1',
          packagePath: '/mnt/usb/pkg',
          organizationId: 4,
          resourceType: 'REPAIR_REQUEST',
          manifestChecksum: 'a'.repeat(64),
          itemTotal: 2,
          itemExported: 2,
          itemFailed: 0,
          items: [],
        }),
    );
    const exportService = { exportPackage } as unknown as RecordPackageExportService;
    const accountQueryService = {
      findCrossInstallationIdentityByAccountId: jest.fn(() =>
        Promise.resolve({ accountUuid: 'uuid-x', loginName: 'x', realName: 'X' }),
      ),
    } as unknown as AccountQueryService;
    const localWriteHoldService = {
      assertCompanyWritable: jest.fn(() =>
        options.writeHoldError === undefined
          ? Promise.resolve()
          : Promise.reject(options.writeHoldError),
      ),
    } as unknown as LocalWriteHoldService;

    const usecase = new ExportRecordPackageUsecase(
      scopeResolver,
      exportService,
      accountQueryService,
      localWriteHoldService,
    );
    return { usecase, exportPackage };
  };

  it('混合导出：一个包里可同时有 >=2 种资源类型（逐条自带类型）', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await usecase.execute({
      session,
      targetPath: '/mnt/usb/pkg',
      resourceType: 'REPAIR_REQUEST',
      recordIds: [],
      entries: [
        { resourceType: 'REPAIR_REQUEST', recordId: 31 },
        { resourceType: 'REFERENCE_DOCUMENT', recordId: 42 },
        { resourceType: 'MAINTENANCE_REPORT', recordId: 53 },
      ],
    });

    expect(exportPackage).toHaveBeenCalledTimes(1);
    expect(exportPackage.mock.calls[0][0].entries).toEqual([
      { resourceType: 'REPAIR_REQUEST', recordId: 31 },
      { resourceType: 'REFERENCE_DOCUMENT', recordId: 42 },
      { resourceType: 'MAINTENANCE_REPORT', recordId: 53 },
    ]);
  });

  it('entries 优先于旧形态：给出 entries 时不以旧单一类型形态为准', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await usecase.execute({
      session,
      targetPath: '/mnt/usb/pkg',
      resourceType: 'MAINTENANCE_REPORT',
      recordIds: [99],
      entries: [{ resourceType: 'REPAIR_REQUEST', recordId: 31 }],
    });

    expect(exportPackage.mock.calls[0][0].entries).toEqual([
      { resourceType: 'REPAIR_REQUEST', recordId: 31 },
    ]);
  });

  it('旧形态保持兼容：只给 resourceType + recordIds 时按单一类型逐条处理', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await usecase.execute({
      session,
      targetPath: '/mnt/usb/pkg',
      resourceType: 'MAINTENANCE_REPORT',
      recordIds: [53, 54],
    });

    expect(exportPackage.mock.calls[0][0].entries).toEqual([
      { resourceType: 'MAINTENANCE_REPORT', recordId: 53 },
      { resourceType: 'MAINTENANCE_REPORT', recordId: 54 },
    ]);
  });

  it('省略公司时按可信 session 范围取本公司（不要求用户手抄公司 ID）', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await usecase.execute({
      session,
      targetPath: '/mnt/usb/pkg',
      resourceType: 'REPAIR_REQUEST',
      recordIds: [31],
    });

    expect(exportPackage.mock.calls[0][0].organizationId).toBe(4);
  });

  it('工程师不得导出其它公司数据区：失败关闭', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await expect(
      usecase.execute({
        session,
        targetPath: '/mnt/usb/pkg',
        organizationId: 9,
        resourceType: 'REPAIR_REQUEST',
        recordIds: [31],
      }),
    ).rejects.toBeDefined();
    expect(exportPackage).not.toHaveBeenCalled();
  });

  it('一级管理员可指定任意公司数据区', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
    });

    await usecase.execute({
      session,
      targetPath: '/mnt/usb/pkg',
      organizationId: 9,
      resourceType: 'REPAIR_REQUEST',
      recordIds: [31],
    });

    expect(exportPackage.mock.calls[0][0].organizationId).toBe(9);
  });

  it('恢复期冻结：该数据区正在恢复时不得导出', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      writeHoldError: new Error('该数据区正在恢复'),
    });

    await expect(
      usecase.execute({
        session,
        targetPath: '/mnt/usb/pkg',
        resourceType: 'REPAIR_REQUEST',
        recordIds: [31],
      }),
    ).rejects.toBeDefined();
    expect(exportPackage).not.toHaveBeenCalled();
  });

  it('资源类型不在白名单：失败关闭（不静默降级）', async () => {
    const { usecase, exportPackage } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
    });

    await expect(
      usecase.execute({
        session,
        targetPath: '/mnt/usb/pkg',
        resourceType: 'NOT_A_TYPE',
        recordIds: [31],
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.INVALID_PARAMS });
    expect(exportPackage).not.toHaveBeenCalled();
  });
});
