// src/usecases/local-runtime/import-record-package.usecase.spec.ts
/// <reference types="jest" />

/**
 * 记录包导入编排的定向测试（任务 09 S3.2）。
 *
 * 守住：预检未通过不导入、确认绑定包（换包作废）、无受控写入入口失败关闭、
 * 逐条结果与批次终态、与同步去重、中断重试不重做。
 */

import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';

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
  const recordImportedVersion = jest.fn().mockResolvedValue('receipt-new');

  const usecase = new ImportRecordPackageUsecase(
    { resolve: jest.fn().mockResolvedValue({ organizationId: 9, role: 'ENGINEER' }) } as never,
    {
      readImportFacts,
      evaluatePackage,
      markImportRunning,
      finalizeImport,
      writeItemResult,
      findReceipt,
    } as never,
    { recordImportedVersion } as never,
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

  return {
    usecase,
    evaluatePackage,
    markImportRunning,
    finalizeImport,
    writeItemResult,
    findReceipt,
    recordImportedVersion,
  };
}

const WRITER_OK = {
  supportedResourceTypes: ['MAINTENANCE_REPORT'],
  write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
};

describe('记录包导入编排（S3.2）', () => {
  it('未通过预检不导入', async () => {
    const { usecase, markImportRunning } = buildUsecase({ checkStatus: 'REJECTED' });

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

  it('范围外的包与不存在的包同码返回', async () => {
    const { usecase } = buildUsecase({ organizationId: 10 });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND });
  });

  it('确认绑定的清单摘要与检查结论不一致时旧确认作废', async () => {
    const { usecase, markImportRunning } = buildUsecase({ evaluationChecksum: 'b'.repeat(64) });

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

  it('没有受控写入入口时该条失败关闭，批次记失败', async () => {
    const { usecase, writeItemResult, finalizeImport } = buildUsecase();

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'FAILED' }),
      expect.anything(),
    );
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'FAILED', succeeded: 0, failed: 1 },
      expect.anything(),
    );
  });

  it('受控写入成功：落导入回执、逐条成功、批次成功', async () => {
    const { usecase, writeItemResult, recordImportedVersion, finalizeImport } = buildUsecase({
      writer: WRITER_OK,
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(recordImportedVersion).toHaveBeenCalledTimes(1);
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'SUCCEEDED', receiptId: 'receipt-new' }),
      expect.anything(),
    );
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'SUCCEEDED', succeeded: 1, failed: 0 },
      expect.anything(),
    );
  });

  it('同键回执已存在（与同步去重）时跳过该条', async () => {
    const { usecase, writeItemResult, recordImportedVersion } = buildUsecase({
      writer: WRITER_OK,
      receiptExists: true,
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'SKIPPED' }),
      expect.anything(),
    );
    expect(recordImportedVersion).not.toHaveBeenCalled();
  });

  it('受控写入判冲突时逐条记 CONFLICT，批次记失败', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest
        .fn()
        .mockResolvedValue({ status: 'CONFLICT', localRecordId: null, reason: '版本不一致' }),
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
      expect.objectContaining({ result: 'CONFLICT', errorMessage: '版本不一致' }),
      expect.anything(),
    );
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'FAILED', succeeded: 0, failed: 1 },
      expect.anything(),
    );
  });

  it('中断重试：已成功的条目不重做', async () => {
    const writer = {
      supportedResourceTypes: ['MAINTENANCE_REPORT'],
      write: jest.fn().mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null }),
    };
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      items: [makeItem({ result: 'SUCCEEDED' })],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.write).not.toHaveBeenCalled();
    expect(writeItemResult).not.toHaveBeenCalled();
  });
});
