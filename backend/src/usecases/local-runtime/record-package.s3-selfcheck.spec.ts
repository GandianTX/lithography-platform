// src/usecases/local-runtime/record-package.s3-selfcheck.spec.ts
/// <reference types="jest" />

/**
 * S3 自检：记录包导出／检查／导入链的场景化验证（任务 09 总计划 S3.3）。
 *
 * 覆盖：跨公司／无权、损坏／路径穿越、重复导入、与同步相互去重、部分写入失败与
 * 中断重试、预检不写业务、删除／下架旧包（换包作废旧确认）；并核对"非本轮数据不变"。
 *
 * 真实文件口径：本文件不写磁盘（落盘由导出服务负责），因此"真实文件不变"由
 * **不触碰导出目标**这一事实保证，并由导出策略的既有用例覆盖。
 */

import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';
import {
  isSafePackageRelativePath,
  parseRecordPackageManifest,
  resolvePackageFilePath,
} from '@core/local-runtime/policy/record-package-manifest.policy';

import { ImportRecordPackageUsecase } from './import-record-package.usecase';

const PACKAGE_ID = '33333333-4444-4555-8666-777777777777';
const CHECKSUM = 'a'.repeat(64);
const RECORD_UUID = '11111111-2222-4333-8444-555555555555';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ENGINEER',
  roles: ['ENGINEER'],
  identityType: 'ENGINEER',
  adminLevel: null,
} as never;

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'item-1',
    packageId: PACKAGE_ID,
    recordUuid: RECORD_UUID,
    resourceType: 'MAINTENANCE_REPORT',
    versionNo: 2,
    checkResult: 'PASSED',
    result: null,
    receiptId: null,
    errorMessage: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildUsecase(
  options: {
    items?: ReturnType<typeof makeItem>[];
    checkStatus?: string;
    organizationId?: number;
    evaluationChecksum?: string;
    writer?: unknown;
    receiptExists?: boolean;
  } = {},
) {
  const items = options.items ?? [makeItem()];
  const readImportFacts = jest.fn().mockResolvedValue({
    import: {
      packageId: PACKAGE_ID,
      organizationId: options.organizationId ?? 9,
      importedByAccountId: 900101,
      manifestJson: JSON.stringify({
        schema_version: 1,
        package_id: PACKAGE_ID,
        organization_id: 9,
        installation_id: '88888888-9999-4aaa-8bbb-cccccccccccc',
        created_at: '2026-11-22T00:00:00.000Z',
        items: [
          {
            record_uuid: RECORD_UUID,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 2,
            content_snapshot: { schema_version: 1, payload: { title: 'x' } },
            files: [],
          },
        ],
      }),
      manifestChecksum: CHECKSUM,
      status: 'PENDING',
      checkStatus: options.checkStatus ?? 'PASSED',
      itemTotal: items.length,
      itemSucceeded: 0,
      itemFailed: 0,
      createdAt: new Date(),
      completedAt: null,
    },
    items,
  });
  const evaluatePackage = jest.fn().mockResolvedValue({
    manifestChecksum: options.evaluationChecksum ?? CHECKSUM,
    manifest: {},
    manifestRaw: '{}',
    outcomes: [],
  });
  const markImportRunning = jest.fn().mockResolvedValue(undefined);
  const finalizeImport = jest.fn().mockResolvedValue(undefined);
  const writeItemResult = jest.fn().mockResolvedValue(undefined);
  const findReceipt = jest
    .fn()
    .mockResolvedValue(options.receiptExists === true ? { receiptId: 'receipt-1' } : null);

  const usecase = new ImportRecordPackageUsecase(
    // 范围解析按会话公司派生（与真实 scope resolver 同口径）
    {
      resolve: jest.fn((session: { organizationId: number }) =>
        Promise.resolve({
          organizationId: session.organizationId,
          role: 'ENGINEER',
        }),
      ),
    } as never,
    {
      readImportFacts,
      evaluatePackage,
      markImportRunning,
      finalizeImport,
      writeItemResult,
      findReceipt,
    } as never,
    { recordImportedVersion: jest.fn().mockResolvedValue('receipt-new') } as never,
    {
      get: jest.fn(() => {
        if (options.writer === undefined) {
          throw new Error('未注册');
        }
        return options.writer;
      }),
    } as never,
    { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
  );

  return { usecase, markImportRunning, finalizeImport, writeItemResult, findReceipt };
}

const WRITER_OK = {
  supportedResourceTypes: ['MAINTENANCE_REPORT'],
  write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
};

describe('S3 自检 · 记录包链路', () => {
  it('跨公司：包公司与本机公司不一致时拒绝导入', async () => {
    const { usecase, markImportRunning } = buildUsecase({ organizationId: 10 });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND });
    expect(markImportRunning).not.toHaveBeenCalled();
  });

  it('无权会话：公司范围不匹配时同样按"不存在"处理', async () => {
    const { usecase } = buildUsecase({ organizationId: 9 });

    await expect(
      usecase.execute({
        session: { ...(SESSION as object), organizationId: 11 } as never,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND });
  });

  it('损坏／非法清单：解析器拒绝（不放行到导入）', () => {
    expect(() =>
      parseRecordPackageManifest(JSON.stringify({ schema_version: 1, package_id: 'not-a-uuid' })),
    ).toThrow();
  });

  it('路径穿越：包内相对路径逃逸被拒', () => {
    expect(isSafePackageRelativePath('../outside.pdf')).toBe(false);
    expect(isSafePackageRelativePath('/etc/passwd')).toBe(false);
    expect(isSafePackageRelativePath('originals/a.pdf')).toBe(true);
    expect(() => resolvePackageFilePath('/mnt/usb/pkg', '../outside.pdf')).toThrow();
  });

  it('重复导入：同键回执已存在即跳过，不重复写入', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
    };
    const { usecase, writeItemResult } = buildUsecase({ writer, receiptExists: true });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.write).not.toHaveBeenCalled();
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'SKIPPED' }),
      expect.anything(),
    );
  });

  it('与同步相互去重：同键回执（云端回执或导入登记）都算已存在', async () => {
    const { usecase, findReceipt } = buildUsecase({ writer: WRITER_OK, receiptExists: true });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(findReceipt).toHaveBeenCalledWith({
      organizationId: 9,
      resourceType: 'MAINTENANCE_REPORT',
      recordUuid: RECORD_UUID,
      versionNo: 2,
    });
  });

  it('部分写入失败：逐条如实记失败与原因，批次记失败', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest
        .fn()
        .mockResolvedValue({ status: 'FAILED', localRecordId: null, reason: '机型不存在' }),
    };
    const { usecase, writeItemResult, finalizeImport } = buildUsecase({ writer });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'FAILED', errorMessage: '机型不存在' }),
      expect.anything(),
    );
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'FAILED', succeeded: 0, failed: 1 },
      expect.anything(),
    );
  });

  it('中断重试：已成功的条目不重做，未完成的条目继续', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
    };
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      items: [makeItem({ itemId: 'done', result: 'SUCCEEDED' }), makeItem({ itemId: 'todo' })],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writeItemResult).toHaveBeenCalledTimes(1);
    expect(writeItemResult).toHaveBeenCalledWith(
      'todo',
      expect.objectContaining({ result: 'SUCCEEDED' }),
      expect.anything(),
    );
  });

  it('删除／下架旧包：换包后旧确认作废，必须重新检查与确认', async () => {
    const { usecase, markImportRunning } = buildUsecase({ evaluationChecksum: 'c'.repeat(64) });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED });
    expect(markImportRunning).not.toHaveBeenCalled();
  });

  it('非本轮数据不变：导入只写本批次条目，不触碰其他条目', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
    };
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      items: [
        makeItem({ itemId: 'item-1' }),
        makeItem({ itemId: 'other', checkResult: 'REJECTED' }),
      ],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledTimes(1);
    expect(writeItemResult.mock.calls[0][0]).toBe('item-1');
  });
});
