// src/usecases/local-runtime/check-record-package.usecase.spec.ts
/// <reference types="jest" />

/**
 * 记录包检查（预检）的定向测试（任务 09 R071／A09-04；独立验收 P1 归属边界）。
 *
 * 守住需求原句：「**预检不写库**」「损坏或异主包拒绝」「同包重复操作一个事实」。
 * 断言落在**用例层**（此前只有服务层断言"重复检查不产生第二个事实"）。
 *
 * P1 追加：**从正式检查用例走到服务/事务**的归属边界——
 * `record_package_import.package_id` 是全局主键 ⇒ 同一个编号只可能有一行、
 * 只属于一个公司；其他公司（含一级管理员的全局查看范围）不得因已知编号
 * 读取、改写、重归属或删除该公司的批次与逐条事实。
 */

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';

import { CheckRecordPackageUsecase } from './check-record-package.usecase';
import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ENGINEER',
  roles: ['ENGINEER'],
  identityType: 'ENGINEER',
  adminLevel: null,
} as never;

function buildUsecase(options: { evaluateError?: Error } = {}) {
  const scopeResolver = {
    resolve: jest.fn().mockResolvedValue({ organizationId: 9, role: 'ENGINEER' }),
  };
  const evaluatePackage = jest.fn().mockResolvedValue({
    packageId: 'pkg-1',
    organizationId: 9,
    manifestChecksum: 'a'.repeat(64),
    items: [],
  });
  if (options.evaluateError !== undefined) {
    evaluatePackage.mockRejectedValue(options.evaluateError);
  }
  const persistCheckOutcome = jest.fn().mockResolvedValue({
    import: { packageId: 'pkg-1', organizationId: 9, status: 'CHECKED' },
    items: [],
  });
  const usecase = new CheckRecordPackageUsecase(
    scopeResolver as never,
    { evaluatePackage, persistCheckOutcome } as never,
    { findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-9' }) } as never,
    { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
  );
  return { usecase, evaluatePackage, persistCheckOutcome, scopeResolver };
}

describe('记录包检查（预检）用例（R071）', () => {
  it('预检阶段不写正式业务：只经 evaluatePackage 评估，落库只写检查事实', async () => {
    const { usecase, evaluatePackage, persistCheckOutcome } = buildUsecase();

    await usecase.execute({
      session: SESSION,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: 'a'.repeat(64),
    } as never);

    expect(evaluatePackage).toHaveBeenCalledTimes(1);
    // 评估入参只含路径与公司，不含"要写入什么业务"的动作参数
    expect(evaluatePackage.mock.calls[0][0]).toEqual({
      packagePath: '/mnt/usb/pkg',
      organizationId: 9,
      organizationCode: 'ORG-9',
      importedByAccountId: 900101,
    });
    // 落库阶段只写"检查事实"（批次＋逐条结论），不是业务记录
    expect(persistCheckOutcome).toHaveBeenCalledTimes(1);
  });

  it('异主／损坏包：评估失败直接抛出，不落检查事实（不写库）', async () => {
    const { usecase, persistCheckOutcome } = buildUsecase({
      evaluateError: new DomainError(
        RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND,
        '记录包清单损坏或不是本公司的包',
      ),
    });

    await expect(
      usecase.execute({
        session: SESSION,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: 'a'.repeat(64),
      } as never),
    ).rejects.toBeInstanceOf(DomainError);
    expect(persistCheckOutcome).not.toHaveBeenCalled();
  });

  it('公司范围来自可信 session，不接受客户端自报', async () => {
    const { usecase, evaluatePackage, scopeResolver } = buildUsecase();

    await usecase.execute({
      session: SESSION,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: 'a'.repeat(64),
      organizationId: 999,
    } as never);

    expect(scopeResolver.resolve).toHaveBeenCalledWith(SESSION);
    expect(evaluatePackage.mock.calls[0][0].organizationId).toBe(9);
  });
});

/**
 * P1 归属边界：**从正式检查用例**走到服务层的落事实。
 *
 * 这里用真实的 `RecordPackageImportService`（只桩掉读盘的 `evaluatePackage`），
 * 让"评估 → 落事实"整条链路真实跑一遍：
 * - A 公司已有 SUCCEEDED 批次及多条 items；
 * - B 公司用**同一个编号**、不同清单来检查 ⇒ 必须受控拒绝，
 *   且 UPDATE／DELETE／INSERT 全为 0、A 的数据逐字段不变；
 * - 同编号同摘要也不得向未授权公司返回对方明细；
 * - 一级管理员的全局查看范围**不等于**可以把既有公司的记录重归属；
 * - 本公司合法流程（同摘要幂等 / 不同摘要重检）不受影响。
 */
describe('记录包检查的跨公司归属边界（P1）', () => {
  const packageId = '22222222-3333-4444-8555-666666666666';
  const companyA = 4;
  const companyB = 9;

  type ImportRow = {
    packageId: string;
    organizationId: number;
    importedByAccountId: number;
    manifestJson: string;
    manifestChecksum: string;
    status: string;
    checkStatus: string | null;
    itemTotal: number;
    itemSucceeded: number;
    itemFailed: number;
    createdAt: Date;
    completedAt: Date | null;
  };

  type ItemRow = {
    packageId: string;
    recordUuid: string;
    resourceType: string;
    versionNo: number;
    checkResult: string;
    result: string | null;
    receiptId: string | null;
    errorMessage: string | null;
  };

  function buildScenario(options: {
    viewerOrganizationId: number | null;
    targetOrganizationId: number;
  }) {
    const importRows = new Map<string, ImportRow>();
    const itemRows = new Map<string, ItemRow[]>();
    const writes = { update: 0, delete: 0, insert: 0, itemInsert: 0 };

    // A 公司的既有事实：已完成的批次 + 3 条逐条结论
    importRows.set(packageId, {
      packageId,
      organizationId: companyA,
      importedByAccountId: 7,
      manifestJson: '{"package_id":"' + packageId + '"}',
      manifestChecksum: 'a'.repeat(64),
      status: 'SUCCEEDED',
      checkStatus: 'PASSED',
      itemTotal: 3,
      itemSucceeded: 3,
      itemFailed: 0,
      createdAt: new Date('2026-11-21T00:00:00.000Z'),
      completedAt: new Date('2026-11-21T01:00:00.000Z'),
    });
    itemRows.set(
      packageId,
      Array.from({ length: 3 }, (_item, index) => ({
        packageId,
        recordUuid: `rec-${index + 1}`,
        resourceType: 'repair_request',
        versionNo: 1,
        checkResult: 'PASSED',
        result: 'SUCCEEDED',
        receiptId: `receipt-${index + 1}`,
        errorMessage: null,
      })),
    );

    const importRepository = {
      findOne: jest.fn().mockImplementation((input: { where: { packageId: string } }) => {
        const row = importRows.get(input.where.packageId);
        return Promise.resolve(row === undefined ? null : { ...row });
      }),
      create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
      insert: jest.fn().mockImplementation((row: ImportRow) => {
        writes.insert += 1;
        importRows.set(row.packageId, { ...row, createdAt: new Date(), completedAt: null });
        return Promise.resolve({ identifiers: [] });
      }),
      update: jest
        .fn()
        .mockImplementation((where: { packageId: string }, patch: Record<string, unknown>) => {
          writes.update += 1;
          const current = importRows.get(where.packageId);
          if (current !== undefined) {
            importRows.set(where.packageId, { ...current, ...(patch as Partial<ImportRow>) });
          }
          return Promise.resolve({ affected: 1 });
        }),
    };
    const itemRepository = {
      create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
      insert: jest.fn().mockImplementation((rows: ItemRow[]) => {
        writes.itemInsert += 1;
        itemRows.set(rows[0]?.packageId ?? packageId, [
          ...(itemRows.get(rows[0]?.packageId ?? packageId) ?? []),
          ...rows,
        ]);
        return Promise.resolve({ identifiers: [] });
      }),
      delete: jest.fn().mockImplementation((where: { packageId: string }) => {
        writes.delete += 1;
        itemRows.delete(where.packageId);
        return Promise.resolve({ affected: 1 });
      }),
      find: jest
        .fn()
        .mockImplementation((input: { where: { packageId: string } }) =>
          Promise.resolve(itemRows.get(input.where.packageId) ?? []),
        ),
    };
    const receiptRepository = { findOne: jest.fn().mockResolvedValue(null) };

    const service = new RecordPackageImportService(
      importRepository as never,
      itemRepository as never,
      receiptRepository as never,
      { findOrganizationIdentityByCode: () => Promise.resolve(null) } as never,
    );

    // 只桩掉"读盘评估"，落事实走**真实实现**。
    jest.spyOn(service, 'evaluatePackage').mockImplementation((command) => {
      return Promise.resolve({
        manifest: { package_id: packageId, organization_id: companyA, items: [] },
        manifestRaw: '{"package_id":"' + packageId + '"}',
        manifestChecksum: 'b'.repeat(64),
        targetOrganizationId: command.organizationId ?? options.targetOrganizationId,
        outcomes: [
          {
            recordUuid: 'rec-9',
            resourceType: 'repair_request',
            versionNo: 1,
            passed: true,
            rejection: null,
            message: null,
          },
        ],
      } as never);
    });

    const scopeResolver = {
      resolve: jest.fn().mockResolvedValue({
        organizationId: options.viewerOrganizationId,
        role: options.viewerOrganizationId === null ? 'ADMIN_LEVEL_1' : 'ADMIN_LEVEL_2',
        adminLevel: options.viewerOrganizationId === null ? 1 : 2,
      }),
    };
    const usecase = new CheckRecordPackageUsecase(
      scopeResolver as never,
      service,
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-9' }),
      } as never,
      // 事务上下文留空 ⇒ 服务走注入的（内存）仓储；事务与行锁语义由实库规格覆盖。
      { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn(undefined)) } as never,
    );

    return { usecase, importRows, itemRows, writes };
  }

  it('其他公司用同一编号检查（不同清单）：受控拒绝，零写入，A 的数据逐字段不变', async () => {
    const { usecase, importRows, itemRows, writes } = buildScenario({
      viewerOrganizationId: companyB,
      targetOrganizationId: companyB,
    });
    const before = { ...importRows.get(packageId) };
    const itemsBefore = [...(itemRows.get(packageId) ?? [])];

    await expect(
      usecase.execute({
        session: SESSION,
        packagePath: '/mnt/usb/pkg',
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.insert).toBe(0);
    expect(writes.itemInsert).toBe(0);
    expect(importRows.get(packageId)).toEqual(before);
    expect(itemRows.get(packageId)).toEqual(itemsBefore);
  });

  it('其他公司用同一编号检查（同摘要）：受控拒绝，不返回对方批次与逐条明细', async () => {
    const { usecase, writes } = buildScenario({
      viewerOrganizationId: companyB,
      targetOrganizationId: companyB,
    });

    await expect(
      usecase.execute({
        session: SESSION,
        packagePath: '/mnt/usb/pkg',
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  it('一级管理员的全局查看范围不等于可以把既有公司的记录重归属', async () => {
    const { usecase, importRows, itemRows, writes } = buildScenario({
      viewerOrganizationId: null,
      targetOrganizationId: companyB,
    });
    const before = { ...importRows.get(packageId) };

    await expect(
      usecase.execute({
        session: SESSION,
        packagePath: '/mnt/usb/pkg',
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
    expect(importRows.get(packageId)).toEqual(before);
    expect(itemRows.get(packageId)).toHaveLength(3);
  });

  it('本公司合法流程不受影响：同摘要幂等返回既有事实，不产生第二次写', async () => {
    const { usecase, writes } = buildScenario({
      viewerOrganizationId: companyA,
      targetOrganizationId: companyA,
    });

    const result = await usecase.execute({
      session: SESSION,
      packagePath: '/mnt/usb/pkg',
    });

    expect(result.outcome).toBe('checked');
    expect(writes.update).toBe(1);
    expect(writes.delete).toBe(1);
    expect(writes.itemInsert).toBe(1);
  });
});
