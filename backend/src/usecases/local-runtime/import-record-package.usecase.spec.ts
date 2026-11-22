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
    /** 已存在回执登记的摘要（缺省＝与当前包一致＝同一事实） */
    receiptChecksum?: string;
    /** 清单条目登记的归属公司（缺省＝与目标公司一致） */
    manifestOwnerOrganizationId?: number;
    /** 清单条目登记的来源账号（缺省＝与导入会话账号相同） */
    manifestSourceAccountId?: number | null;
    /** 清单条目登记的原件清单（缺省＝无原件） */
    manifestFiles?: { relative_path: string; sha256: string; byte_size: number }[];
    /** 本机同编号记录的来源事实（缺省＝本机无该记录） */
    localFact?: {
      withdrawn: boolean;
      currentVersion: number | null;
      identityPersisted: boolean;
    } | null;
  } = {},
) {
  const items = options.items ?? [makeItem()];
  const manifestSourceAccountId =
    options.manifestSourceAccountId === undefined ? 900101 : options.manifestSourceAccountId;
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
            files: options.manifestFiles ?? [],
            source_account_id: manifestSourceAccountId,
            owner_organization_id: options.manifestOwnerOrganizationId ?? 9,
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
  const findReceipt = jest.fn().mockResolvedValue(
    options.receiptExists === true
      ? {
          receiptId: 'receipt-1',
          manifestChecksum: options.receiptChecksum ?? CHECKSUM,
        }
      : null,
  );
  const recordImportedVersion = jest.fn().mockResolvedValue('receipt-new');
  const stage = jest.fn().mockResolvedValue([]);
  const release = jest.fn().mockResolvedValue(0);

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
    { stage, release } as never,
    {
      listFacts: jest.fn().mockResolvedValue({
        facts:
          options.localFact === undefined || options.localFact === null
            ? new Map()
            : new Map([
                [
                  RECORD_UUID,
                  {
                    resourceType: 'MAINTENANCE_REPORT',
                    recordUuid: RECORD_UUID,
                    recordId: 12,
                    ownerOrganizationId: 9,
                    currentVersion: options.localFact.currentVersion,
                    versionTrusted: true,
                    materialApplicable: true,
                    relatedAccountIds: [900101],
                    authorizationSubjectAccountId: 900101,
                    withdrawn: options.localFact.withdrawn,
                    identityPersisted: options.localFact.identityPersisted,
                    contentState: { withdrawn: false, frozen: false, closed: false },
                  },
                ],
              ]),
        scanComplete: true,
      }),
    } as never,
    { assertCompanyWritable: jest.fn().mockResolvedValue(undefined) } as never,
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
    stage,
    release,
  };
}

/**
 * 受控写入替身：默认放行来源身份核验（裁决逻辑由 core 策略与其单测负责），
 * 可按用例覆盖为"拒绝"以验证编排侧的失败关闭。
 */
function buildWriterMock(
  options: {
    identity?: { allowed: true; sourceAccountId: number } | { allowed: false; reason: string };
    write?: {
      status: 'CREATED' | 'DUPLICATE' | 'CONFLICT' | 'FAILED';
      localRecordId: number | null;
      reason: string | null;
    };
  } = {},
) {
  return {
    supportedResourceTypes: ['MAINTENANCE_REPORT'],
    verifySourceIdentity: jest
      .fn()
      .mockResolvedValue(options.identity ?? { allowed: true, sourceAccountId: 900101 }),
    write: jest
      .fn()
      .mockResolvedValue(options.write ?? { status: 'CREATED', localRecordId: 42, reason: null }),
  };
}

const WRITER_OK = buildWriterMock();

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

  it('P4｜异公司：包内归属公司与目标公司不一致时该条拒绝', async () => {
    // 本地 mock：避免与共享 mock 的调用计数互相干扰
    const writer = buildWriterMock();
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      manifestOwnerOrganizationId: 10,
    });

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
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('P4｜来源身份不可信：该条拒绝，不暂存原件、不调用受控写入', async () => {
    const writer = buildWriterMock({
      identity: { allowed: false, reason: '包内来源账号已停用（INACTIVE），该条未导入' },
    });
    const { usecase, writeItemResult, stage } = buildUsecase({ writer });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.verifySourceIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAccountId: 900101,
        targetOrganizationId: 9,
        importerAccountId: 900101,
      }),
    );
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({
        result: 'FAILED',
        errorMessage: expect.stringContaining('已停用'),
      }),
      expect.anything(),
    );
    // 关键：不可信来源账号不得进入原件暂存（否则留下指向不可信账号的孤儿暂存行）
    expect(stage).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('P4｜包内缺来源账号：该条拒绝，不调用受控写入', async () => {
    const writer = buildWriterMock({
      identity: {
        allowed: false,
        reason: '包内未携带来源账号，原作者不可核验（不以导入人冒充原作者），该条未导入',
      },
    });
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      manifestSourceAccountId: null,
    });

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
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('P3-3｜写入失败：精确释放本条暂存原件，不留孤儿行', async () => {
    const writer = buildWriterMock({
      write: { status: 'FAILED', localRecordId: null, reason: '机型不存在' },
    });
    const { usecase, writeItemResult, stage, release } = buildUsecase({
      writer,
      manifestFiles: [{ relative_path: 'originals/a.pdf', sha256: 'a'.repeat(64), byte_size: 10 }],
    });
    stage.mockResolvedValue([
      {
        fileId: 'file-1',
        uploadContextId: 'ctx-1',
        originalFilename: 'a.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
        checksumSha256: 'a'.repeat(64),
      },
    ]);

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(stage).toHaveBeenCalledTimes(1);
    // 精确补偿：只释放本条自己登记的暂存行
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toEqual([expect.objectContaining({ fileId: 'file-1' })]);
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'FAILED' }),
      expect.anything(),
    );
  });

  it('P3-3｜写入抛错：先精确补偿再如实登记失败（不掩盖主失败）', async () => {
    const writer = buildWriterMock();
    writer.write.mockRejectedValue(new Error('受控写入炸了'));
    const { usecase, writeItemResult, release, stage } = buildUsecase({
      writer,
      manifestFiles: [{ relative_path: 'originals/a.pdf', sha256: 'a'.repeat(64), byte_size: 10 }],
    });
    stage.mockResolvedValue([
      {
        fileId: 'file-1',
        uploadContextId: 'ctx-1',
        originalFilename: 'a.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
        checksumSha256: 'a'.repeat(64),
      },
    ]);

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({
        result: 'FAILED',
        errorMessage: expect.stringContaining('受控写入异常'),
      }),
      expect.anything(),
    );
  });

  it('P3-3｜写入成功：不补偿（暂存行已被绑定）', async () => {
    const writer = buildWriterMock();
    const { usecase, release } = buildUsecase({ writer });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(release).not.toHaveBeenCalled();
  });

  it('P3-3｜结果未知：本机已有同一持久化身份且同一版本 → 先核对再重试，判同一事实跳过', async () => {
    const writer = buildWriterMock();
    const { usecase, writeItemResult, recordImportedVersion, stage } = buildUsecase({
      writer,
      localFact: { withdrawn: false, currentVersion: 2, identityPersisted: true },
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    // 不重复写、不重复绑定、不再暂存原件
    expect(writer.write).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    // 补记回执，让后续重试直接命中回执去重
    expect(recordImportedVersion).toHaveBeenCalledTimes(1);
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'SKIPPED', receiptId: 'receipt-new' }),
      expect.anything(),
    );
  });

  it('P3-3｜本机同版本但身份非持久化（派生值）：不按"同一事实"跳过，仍走正常导入', async () => {
    const writer = buildWriterMock();
    const { usecase } = buildUsecase({
      writer,
      localFact: { withdrawn: false, currentVersion: 2, identityPersisted: false },
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it('P4｜核验放行：写入使用已核验的来源账号（不直接用包内原值）', async () => {
    const writer = buildWriterMock({ identity: { allowed: true, sourceAccountId: 900303 } });
    const { usecase } = buildUsecase({ writer, manifestSourceAccountId: 900303 });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: 900303 }),
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
    const writer = buildWriterMock({
      write: { status: 'CONFLICT', localRecordId: null, reason: '版本不一致' },
    });
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
    const writer = buildWriterMock();
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
