// src/usecases/local-runtime/import-record-package.usecase.spec.ts
/// <reference types="jest" />

/**
 * 记录包导入编排的定向测试（任务 09 S3.2）。
 *
 * 守住：预检未通过不导入、确认绑定包（换包作废）、无受控写入入口失败关闭、
 * 逐条结果与批次终态、与同步去重、中断重试不重做。
 */

import { RECORD_PACKAGE_ERROR, DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';

import { ImportRecordPackageUsecase } from './import-record-package.usecase';

const PACKAGE_ID = '33333333-4444-4555-8666-777777777777';
const CHECKSUM = 'a'.repeat(64);
const RECORD_UUID = '11111111-2222-4333-8444-555555555555';

type MockFreshOutcome = {
  resourceType?: string;
  recordUuid?: string;
  versionNo?: number;
  passed: boolean;
  message?: string | null;
  rejection?: string | null;
};

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
    /** 已存在回执登记的摘要（缺省＝与当前包一致；null＝旧数据不可判定） */
    receiptChecksum?: string | null;
    /** 已存在回执的来源安装标识（缺省＝当前包来源安装；传 null 模拟历史未知） */
    receiptInstallationId?: string | null;
    /** 清单条目登记的归属公司（缺省＝与目标公司一致） */
    manifestOwnerOrganizationId?: number;
    /** 清单条目登记的来源账号（缺省＝与导入会话账号相同） */
    manifestSourceAccountId?: number | null;
    /** 清单条目登记的原件清单（缺省＝无原件） */
    manifestFiles?: { relative_path: string; sha256: string; byte_size: number }[];
    /** 完整清单条目（缺省＝沿用固定单条目；混合包反例需显式提供） */
    manifestItems?: Record<string, unknown>[];
    /** 确认期重新评估的逐条结论（缺省＝与初检 checkResult 一致） */
    freshOutcomes?: MockFreshOutcome[];
    /** 恢复期冻结闸门错误（用于验证冻结先于任何写入） */
    writableError?: Error;
    /** 按调用序号注入冻结错误，用于占用前/占用后窗口的状态化反例 */
    writableErrors?: (Error | null)[];
    /** 本条暂存原件补偿失败（冻结路径不得据此收敛为可重试） */
    releaseError?: Error;
    /** 冻结收敛自身失败：必须同时保留原始冻结与收敛错误 */
    finalizeFrozenError?: Error;
    /**
     * 本次评估按可信映射确定的**目标公司**（缺省＝批次归属公司＝一致）。
     * 传不同值即制造"批次公司与包的目标公司不一致"。
     */
    evaluationTargetOrganizationId?: number;
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
  const facts = {
    import: {
      packageId: PACKAGE_ID,
      organizationId: options.organizationId ?? 9,
      importedByAccountId: 900101,
      manifestJson: JSON.stringify({
        schema_version: 1,
        package_id: PACKAGE_ID,
        organization_id: 9,
        organization_code: 'ORG-9',
        installation_id: '88888888-9999-4aaa-8bbb-cccccccccccc',
        created_at: '2026-11-22T00:00:00.000Z',
        items: options.manifestItems ?? [
          {
            record_uuid: RECORD_UUID,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 2,
            content_snapshot: { schema_version: 1, payload: { title: 'x' } },
            files: options.manifestFiles ?? [],
            source_account_id: manifestSourceAccountId,
            source_account_uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            source_account_login_name: 'engineer-1',
            source_account_name: '张三',
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
  };
  const readImportFacts = jest.fn().mockResolvedValue(facts);
  const freshOutcomes: MockFreshOutcome[] =
    options.freshOutcomes ??
    items.map((item) => ({
      resourceType: String(item.resourceType),
      recordUuid: String(item.recordUuid),
      versionNo: Number(item.versionNo),
      passed: item.checkResult === 'PASSED',
      rejection: null,
      message: typeof item.errorMessage === 'string' ? item.errorMessage : null,
    }));
  const evaluatePackage = jest.fn().mockResolvedValue({
    manifestChecksum: options.evaluationChecksum ?? CHECKSUM,
    manifest: {},
    manifestRaw: '{}',
    outcomes: freshOutcomes,
    // 本次评估按可信映射确定的目标公司（缺省＝批次归属公司＝一致）
    targetOrganizationId: options.evaluationTargetOrganizationId ?? options.organizationId ?? 9,
  });
  // 占用（版本绑定）：默认占用成功，回传**锁内同一版本**的批次与逐条事实。
  const claimImportRun = jest.fn((input: { importedByAccountId: number }) =>
    Promise.resolve({
      import: {
        ...facts.import,
        status: 'RUNNING',
        importedByAccountId: input.importedByAccountId,
      },
      items: facts.items,
    }),
  );
  const finalizeImport = jest.fn().mockResolvedValue(undefined);
  const finalizeFrozenImport = jest
    .fn()
    .mockImplementation(() =>
      options.finalizeFrozenError === undefined
        ? Promise.resolve()
        : Promise.reject(options.finalizeFrozenError),
    );
  const writeItemResult = jest.fn().mockResolvedValue(undefined);
  const markItemCheckRejected = jest.fn().mockResolvedValue(undefined);
  const findReceipt = jest.fn().mockResolvedValue(
    options.receiptExists === true
      ? {
          receiptId: 'receipt-1',
          manifestChecksum:
            options.receiptChecksum === undefined ? CHECKSUM : options.receiptChecksum,
          sourceInstallationId:
            options.receiptInstallationId === undefined
              ? '88888888-9999-4aaa-8bbb-cccccccccccc'
              : options.receiptInstallationId,
        }
      : null,
  );
  const recordImportedVersion = jest.fn().mockResolvedValue('receipt-new');
  const stage = jest.fn().mockResolvedValue([
    {
      fileId: 'file-1',
      uploadContextId: 'upload-1',
      originalFilename: 'original.bin',
      mimeType: 'application/octet-stream',
      byteSize: 1,
      checksumSha256: 'f'.repeat(64),
    },
  ]);
  const release = jest
    .fn()
    .mockImplementation(() =>
      options.releaseError === undefined
        ? Promise.resolve(1)
        : Promise.reject(options.releaseError),
    );
  let writableCallIndex = 0;
  const assertCompanyWritable = jest.fn().mockImplementation(() => {
    const callIndex = writableCallIndex++;
    const configured = options.writableErrors?.[callIndex];
    if (configured !== undefined && configured !== null) {
      return Promise.reject(configured);
    }
    if (options.writableError !== undefined) {
      return Promise.reject(options.writableError);
    }
    return Promise.resolve(undefined);
  });

  const usecase = new ImportRecordPackageUsecase(
    { resolve: jest.fn().mockResolvedValue({ organizationId: 9, role: 'ENGINEER' }) } as never,
    {
      readImportFacts,
      evaluatePackage,
      claimImportRun,
      finalizeImport,
      finalizeFrozenImport,
      writeItemResult,
      markItemCheckRejected,
      findReceipt,
    } as never,
    { findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-9' }) } as never,
    { recordImportedVersion } as never,
    { stage, release } as never,

    {
      listFacts: jest.fn().mockResolvedValue({
        facts: (() => {
          const localFact =
            options.localFact === undefined && options.receiptExists === true
              ? { withdrawn: false, currentVersion: 2, identityPersisted: true }
              : options.localFact;
          return localFact === undefined || localFact === null
            ? new Map()
            : new Map([
                [
                  RECORD_UUID,
                  {
                    resourceType: 'MAINTENANCE_REPORT',
                    recordUuid: RECORD_UUID,
                    recordId: 12,
                    ownerOrganizationId: 9,
                    currentVersion: localFact.currentVersion,
                    versionTrusted: true,
                    materialApplicable: true,
                    relatedAccountIds: [900101],
                    authorizationSubjectAccountId: 900101,
                    withdrawn: localFact.withdrawn,
                    identityPersisted: localFact.identityPersisted,
                    contentState: { withdrawn: false, frozen: false, closed: false },
                  },
                ],
              ]);
        })(),
        scanComplete: true,
      }),
    } as never,
    { assertCompanyWritable } as never,
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
    facts,
    readImportFacts,
    evaluatePackage,
    claimImportRun,
    finalizeImport,
    finalizeFrozenImport,
    writeItemResult,
    markItemCheckRejected,
    findReceipt,
    recordImportedVersion,
    stage,
    release,
    assertCompanyWritable,
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
    /** 模拟 writer 事务内抛出的错误（如真实 writer 的恢复冻结） */
    writeError?: Error;
    supportedResourceTypes?: string[];
  } = {},
) {
  return {
    supportedResourceTypes: options.supportedResourceTypes ?? ['MAINTENANCE_REPORT'],
    verifySourceIdentity: jest
      .fn()
      .mockResolvedValue(options.identity ?? { allowed: true, sourceAccountId: 900101 }),
    write: jest
      .fn()
      .mockImplementation(() =>
        options.writeError === undefined
          ? Promise.resolve(options.write ?? { status: 'CREATED', localRecordId: 42, reason: null })
          : Promise.reject(options.writeError),
      ),
  };
}

const WRITER_OK = buildWriterMock();

describe('记录包导入编排（S3.2）', () => {
  it('未通过预检不导入', async () => {
    const { usecase, claimImportRun } = buildUsecase({ checkStatus: 'REJECTED' });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED });
    expect(claimImportRun).not.toHaveBeenCalled();
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

  it('一级管理员（全局授权范围）可导入本公司范围的包：不被"公司 id ≠ null"恒定拒绝', async () => {
    const { usecase, finalizeImport } = buildUsecase();
    // 一级管理员没有业务所属公司（scope.organizationId = null）
    (
      usecase as unknown as { scopeResolver: { resolve: jest.Mock } }
    ).scopeResolver.resolve.mockResolvedValue({ organizationId: null, role: 'ADMIN_LEVEL_1' });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(finalizeImport).toHaveBeenCalled();
  });

  it('确认绑定的清单摘要与检查结论不一致时旧确认作废', async () => {
    const { usecase, claimImportRun } = buildUsecase({ evaluationChecksum: 'b'.repeat(64) });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED });
    expect(claimImportRun).not.toHaveBeenCalled();
  });

  it('P1：批次归属公司与包的目标公司不一致时拒绝导入（不写批次、不写条目）', async () => {
    const { usecase, claimImportRun, writeItemResult, finalizeImport } = buildUsecase({
      writer: WRITER_OK,
      // 批次属于 9 号公司，但本次包按可信映射确定的目标公司是 4 号公司
      evaluationTargetOrganizationId: 4,
    });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.FOREIGN_COMPANY });

    expect(claimImportRun).not.toHaveBeenCalled();
    expect(writeItemResult).not.toHaveBeenCalled();
    expect(finalizeImport).not.toHaveBeenCalled();
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
      CHECKSUM,
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
      CHECKSUM,
      expect.anything(),
    );
  });

  it('P4｜异公司：公司身份裁决委托来源域（编排侧不按数字 id 猜公司）', async () => {
    // 本地 mock：避免与共享 mock 的调用计数互相干扰
    const writer = buildWriterMock();
    const { usecase } = buildUsecase({
      writer,
      manifestOwnerOrganizationId: 10,
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    // 公司归属核对在**来源域**（按公司业务编码），编排侧只把事实传过去
    expect(writer.verifySourceIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerOrganizationId: 10,
        portableSourceIdentity: expect.objectContaining({
          sourceOrganizationCode: 'ORG-9',
        }),
      }),
    );
  });

  it('P4｜来源域判定身份不可核验（异公司／不可信来源）时该条拒绝且不写入', async () => {
    // 本地 mock：避免与共享 mock 的调用计数互相干扰
    const writer = buildWriterMock({
      identity: { allowed: false, reason: '包内来源公司与导入目标公司不一致，该条未导入' },
    });
    const { usecase, writeItemResult } = buildUsecase({ writer });

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

  it('P1-01｜无回执本机同版本＋原件不可证明：CONFLICT，不补回执/不写业务', async () => {
    const writer = buildWriterMock();
    const { usecase, writeItemResult, recordImportedVersion, stage, assertCompanyWritable } =
      buildUsecase({
        writer,
        localFact: { withdrawn: false, currentVersion: 2, identityPersisted: true },
        manifestFiles: [{ relative_path: 'changed.pdf', sha256: 'f'.repeat(64), byte_size: 123 }],
      });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({
        result: 'CONFLICT',
        errorMessage: expect.stringContaining('无同键回执可证明'),
      }),
      expect.anything(),
    );
    expect(recordImportedVersion).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.verifySourceIdentity).not.toHaveBeenCalled();
    // 占用前冻结预检仍执行；该条在逐条冻结复核前已被受控冲突关闭。
    expect(assertCompanyWritable).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
  });

  it('P1-01｜无回执同版本即使用户权限撤销：仍受控冲突，不进入权限/冻结/写入', async () => {
    const writer = buildWriterMock({
      identity: { allowed: false, reason: '当前权限已撤销' },
    });
    const { usecase, writeItemResult, recordImportedVersion, assertCompanyWritable } = buildUsecase(
      {
        writer,
        localFact: { withdrawn: false, currentVersion: 2, identityPersisted: true },
      },
    );

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'CONFLICT' }),
      expect.anything(),
    );
    expect(writer.verifySourceIdentity).not.toHaveBeenCalled();
    expect(assertCompanyWritable).toHaveBeenCalledTimes(1);
    expect(recordImportedVersion).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('P1-01｜新增条目权限撤销：冻结与身份核验先于写入，零回执/零暂存', async () => {
    const writer = buildWriterMock({
      identity: { allowed: false, reason: '当前权限已撤销' },
    });
    const { usecase, writeItemResult, recordImportedVersion, stage, assertCompanyWritable } =
      buildUsecase({ writer });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    // 占用前一次 + 实际写入前一次；两者都在身份核验之前。
    expect(assertCompanyWritable).toHaveBeenCalledTimes(2);
    expect(writer.verifySourceIdentity).toHaveBeenCalledTimes(1);
    expect(assertCompanyWritable.mock.invocationCallOrder[0]).toBeLessThan(
      writer.verifySourceIdentity.mock.invocationCallOrder[0],
    );
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ result: 'FAILED', errorMessage: '当前权限已撤销' }),
      expect.anything(),
    );
    expect(stage).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(recordImportedVersion).not.toHaveBeenCalled();
  });

  it('P1-01｜恢复期冻结拒绝新增条目：零身份核验/零写入/零回执', async () => {
    const writer = buildWriterMock();
    const { usecase, recordImportedVersion, stage, assertCompanyWritable } = buildUsecase({
      writer,
      writableError: new Error('恢复期冻结'),
    });

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toThrow('恢复期冻结');

    expect(assertCompanyWritable).toHaveBeenCalledTimes(1);
    expect(writer.verifySourceIdentity).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(recordImportedVersion).not.toHaveBeenCalled();
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

  // 去重规则：整包摘要只证明"同一份包"，不冒充单条正文/原件内容摘要。
  describe('记录级去重与回执时序（正式入口）', () => {
    it('同包同摘要 + 同键回执：SKIPPED 且不重复写回执', async () => {
      const { usecase, writeItemResult, recordImportedVersion } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        receiptChecksum: CHECKSUM,
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ result: 'SKIPPED', receiptId: 'receipt-1' }),
        expect.anything(),
      );
      expect(recordImportedVersion).not.toHaveBeenCalled();
    });

    it('检查通过后回执晚到：同包同源且本机权威版本可证，仍只跳过不覆盖', async () => {
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

    it('不同包同记录同版本：即使本机同版本，来源包不可证仍 CONFLICT', async () => {
      const { usecase, writeItemResult, recordImportedVersion } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        receiptChecksum: 'b'.repeat(64),
      });

      await usecase.execute({
        session: SESSION,
        packageId: 'new-package-id',
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'CONFLICT',
          errorMessage: expect.stringContaining('不同来源包'),
        }),
        expect.anything(),
      );
      expect(recordImportedVersion).not.toHaveBeenCalled();
    });

    it('摘要相同但回执来源安装不同：CONFLICT，不按整包摘要证明单条相同', async () => {
      const { usecase, writeItemResult } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        receiptInstallationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'CONFLICT',
          errorMessage: expect.stringContaining('不同来源包'),
        }),
        expect.anything(),
      );
    });

    it('旧回执摘要不可判定（null）：保守判 CONFLICT，不当内容相同放行', async () => {
      const { usecase, writeItemResult } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        receiptChecksum: null,
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'CONFLICT',
          errorMessage: expect.stringContaining('不可判定'),
        }),
        expect.anything(),
      );
    });

    it('同包同源但本机权威版本不可核验：CONFLICT，不按回执跳过', async () => {
      const { usecase, writeItemResult } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        localFact: null,
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'CONFLICT',
          errorMessage: expect.stringContaining('本机权威版本'),
        }),
        expect.anything(),
      );
    });

    it('同包同源但本机已下架：FAILED，不复活已删除下架内容', async () => {
      const { usecase, writeItemResult } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        localFact: { withdrawn: true, currentVersion: 2, identityPersisted: true },
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'FAILED',
          errorMessage: expect.stringContaining('下架'),
        }),
        expect.anything(),
      );
    });

    it('同包同源但当前权限已撤销：FAILED，不写业务也不写新回执', async () => {
      const writer = buildWriterMock({
        identity: { allowed: false, reason: '当前权限已撤销' },
      });
      const { usecase, writeItemResult, recordImportedVersion } = buildUsecase({
        writer,
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
        expect.objectContaining({ result: 'FAILED', errorMessage: '当前权限已撤销' }),
        expect.anything(),
      );
      expect(recordImportedVersion).not.toHaveBeenCalled();
    });

    it('无回执且本机无新近写入事实：按正式入口继续导入并写新回执', async () => {
      const { usecase, writeItemResult, recordImportedVersion } = buildUsecase({
        writer: WRITER_OK,
        receiptExists: false,
      });

      await usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ result: 'SUCCEEDED', receiptId: 'receipt-new' }),
        expect.anything(),
      );
      expect(recordImportedVersion).toHaveBeenCalledTimes(1);
    });
  });

  it('F4 混合资源：同 UUID 不同资源/版本不得按 UUID 错配，精确匹配失败即拒绝', async () => {
    const writer = buildWriterMock();
    const { usecase, writeItemResult } = buildUsecase({
      writer,
      items: [
        {
          itemId: 'item-mixed',
          recordUuid: RECORD_UUID,
          resourceType: 'REPAIR_REQUEST',
          versionNo: 1,
          receiptId: null,
          checkResult: 'PASSED',
          result: null,
          errorMessage: null,
          createdAt: new Date(),
        } as never,
      ],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).toHaveBeenCalledWith(
      'item-mixed',
      expect.objectContaining({
        result: 'FAILED',
        errorMessage: expect.stringContaining('精确匹配'),
      }),
      expect.anything(),
    );
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('零可执行条目：批次如实记 FAILED，不伪报 SUCCEEDED', async () => {
    const { usecase, finalizeImport } = buildUsecase({ writer: WRITER_OK, items: [] });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'FAILED', succeeded: 0, failed: 0 },
      CHECKSUM,
      expect.anything(),
    );
  });

  it('混合检查范围：合格条目成功但硬阻断条目未执行，批次记 PARTIAL', async () => {
    const { usecase, finalizeImport, writeItemResult } = buildUsecase({
      writer: WRITER_OK,
      items: [
        makeItem({ itemId: 'item-blocked', checkResult: 'REJECTED' }),
        makeItem({ itemId: 'item-eligible' }),
      ],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(writeItemResult).not.toHaveBeenCalledWith(
      'item-blocked',
      expect.anything(),
      expect.anything(),
    );
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'PARTIAL', succeeded: 1, failed: 0 },
      CHECKSUM,
      expect.anything(),
    );
  });

  describe('B 复审 P2：冻结与占用状态机', () => {
    const heldError = () =>
      new DomainError(SYNC_ERROR.WRITE_HELD, '恢复期冻结', {
        reasonCode: 'WRITE_HELD_FOR_RESTORE',
      });

    it('占用前已冻结：零占用、零写入，错误原样抛出', async () => {
      const writer = buildWriterMock();
      const {
        usecase,
        claimImportRun,
        finalizeImport,
        finalizeFrozenImport,
        assertCompanyWritable,
        stage,
      } = buildUsecase({ writer, writableErrors: [heldError()] });

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.WRITE_HELD });

      expect(assertCompanyWritable).toHaveBeenCalledTimes(1);
      expect(claimImportRun).not.toHaveBeenCalled();
      expect(finalizeImport).not.toHaveBeenCalled();
      expect(finalizeFrozenImport).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    });

    it('占用后首条写入前冻结：零写入收敛 FAILED，解冻后同包可重试', async () => {
      const writer = buildWriterMock();
      const {
        usecase,
        finalizeImport,
        finalizeFrozenImport,
        writeItemResult,
        assertCompanyWritable,
        stage,
        recordImportedVersion,
      } = buildUsecase({ writer, writableErrors: [null, heldError(), null, null] });

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.WRITE_HELD });

      expect(finalizeFrozenImport).toHaveBeenCalledWith({
        packageId: PACKAGE_ID,
        organizationId: 9,
        manifestChecksum: CHECKSUM,
        transactionContext: expect.anything(),
      });
      expect(finalizeImport).not.toHaveBeenCalled();
      expect(writeItemResult).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(recordImportedVersion).not.toHaveBeenCalled();

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).resolves.toMatchObject({ outcome: 'imported' });

      expect(assertCompanyWritable).toHaveBeenCalledTimes(4);
      expect(finalizeImport).toHaveBeenCalledWith(
        PACKAGE_ID,
        { status: 'SUCCEEDED', succeeded: 1, failed: 0 },
        CHECKSUM,
        expect.anything(),
      );
      expect(writer.write).toHaveBeenCalledTimes(1);
      expect(recordImportedVersion).toHaveBeenCalledTimes(1);
    });

    it('已处理部分条目后冻结：保留已提交事实并按 PARTIAL 收敛', async () => {
      const otherUuid = '55555555-6666-4777-8555-999999999999';
      const first = makeItem({ itemId: 'item-first', recordUuid: RECORD_UUID, versionNo: 1 });
      const second = makeItem({ itemId: 'item-second', recordUuid: otherUuid, versionNo: 1 });
      const harness = buildUsecase({
        writer: WRITER_OK,
        items: [first, second],
        manifestItems: [
          {
            record_uuid: RECORD_UUID,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 1,
            content_snapshot: { schema_version: 1, payload: { title: 'first' } },
            files: [],
            source_account_id: 5,
            owner_organization_id: 9,
          },
          {
            record_uuid: otherUuid,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 1,
            content_snapshot: { schema_version: 1, payload: { title: 'second' } },
            files: [],
            source_account_id: 5,
            owner_organization_id: 9,
          },
        ],
        writableErrors: [null, null, heldError()],
      });
      harness.readImportFacts.mockImplementationOnce(() => Promise.resolve(harness.facts));
      harness.readImportFacts.mockImplementationOnce(() =>
        Promise.resolve({
          ...harness.facts,
          items: [{ ...first, result: 'SUCCEEDED' }, second],
        }),
      );

      await expect(
        harness.usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.WRITE_HELD });

      expect(harness.writeItemResult).toHaveBeenCalledWith(
        'item-first',
        expect.objectContaining({ result: 'SUCCEEDED' }),
        expect.anything(),
      );
      expect(harness.recordImportedVersion).toHaveBeenCalledTimes(1);
      expect(harness.finalizeFrozenImport).toHaveBeenCalledWith({
        packageId: PACKAGE_ID,
        organizationId: 9,
        manifestChecksum: CHECKSUM,
        transactionContext: expect.anything(),
      });
      expect(harness.finalizeImport).not.toHaveBeenCalled();
    });

    it('writer 事务内冻结：补偿暂存后透传冻结并按零写入收敛', async () => {
      const writer = buildWriterMock({ writeError: heldError() });
      const {
        usecase,
        finalizeImport,
        finalizeFrozenImport,
        writeItemResult,
        release,
        recordImportedVersion,
        stage,
      } = buildUsecase({
        writer,
        manifestFiles: [{ relative_path: 'a.bin', sha256: 'f'.repeat(64), byte_size: 1 }],
      });

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).rejects.toMatchObject({ code: SYNC_ERROR.WRITE_HELD });

      expect(stage).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(writeItemResult).not.toHaveBeenCalled();
      expect(recordImportedVersion).not.toHaveBeenCalled();
      expect(finalizeFrozenImport).toHaveBeenCalledWith({
        packageId: PACKAGE_ID,
        organizationId: 9,
        manifestChecksum: CHECKSUM,
        transactionContext: expect.anything(),
      });
      expect(finalizeImport).not.toHaveBeenCalled();
    });

    it.each([
      { count: 1, affected: 0 },
      { count: 2, affected: 1 },
    ])(
      'writer 冻结时释放 $count 个附件仅命中 $affected：保留批次并报告双重原因',
      async ({ count, affected }) => {
        const writer = buildWriterMock({ writeError: heldError() });
        const harness = buildUsecase({
          writer,
          manifestFiles: [{ relative_path: 'a.bin', sha256: 'f'.repeat(64), byte_size: 1 }],
        });
        const file = {
          fileId: 'file-1',
          uploadContextId: 'upload-1',
          originalFilename: 'a.bin',
          mimeType: 'application/octet-stream',
          byteSize: 1,
          checksumSha256: 'f'.repeat(64),
        };
        harness.stage.mockResolvedValue(
          count === 1 ? [file] : [file, { ...file, fileId: 'file-2' }],
        );
        harness.release.mockResolvedValue(affected);
        let caught: unknown;
        try {
          await harness.usecase.execute({
            session: SESSION,
            packageId: PACKAGE_ID,
            packagePath: '/mnt/usb/pkg',
            manifestChecksum: CHECKSUM,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        const errors = (caught as AggregateError).errors as unknown[];
        expect(errors[0]).toMatchObject({ code: SYNC_ERROR.WRITE_HELD });
        expect(String(errors[1])).toContain(`预期释放 ${count}，实际释放 ${affected}`);
        expect(String(errors[1])).toContain('file-1');
        if (count === 2) expect(String(errors[1])).toContain('file-2');
        expect(harness.finalizeFrozenImport).not.toHaveBeenCalled();
        expect(harness.finalizeImport).not.toHaveBeenCalled();
        expect(harness.writeItemResult).not.toHaveBeenCalled();
        expect(harness.recordImportedVersion).not.toHaveBeenCalled();
      },
    );

    it('writer 冻结且补偿失败：不收敛、不释放为可重试，双错误均保留', async () => {
      const writer = buildWriterMock({ writeError: heldError() });
      const { usecase, finalizeImport, finalizeFrozenImport, release, recordImportedVersion } =
        buildUsecase({
          writer,
          manifestFiles: [{ relative_path: 'a.bin', sha256: 'f'.repeat(64), byte_size: 1 }],
          releaseError: new Error('暂存补偿失败'),
        });

      let caught: unknown = null;
      try {
        await usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toHaveLength(2);
      expect(String((caught as AggregateError).message)).toContain('补偿失败');
      expect(release).toHaveBeenCalledTimes(1);
      expect(recordImportedVersion).not.toHaveBeenCalled();
      expect(finalizeImport).not.toHaveBeenCalled();
      expect(finalizeFrozenImport).not.toHaveBeenCalled();
    });

    it('冻结收敛自身失败：原始 WRITE_HELD 与收敛错误均保留', async () => {
      const writer = buildWriterMock({ writeError: heldError() });
      const { usecase, finalizeImport, finalizeFrozenImport } = buildUsecase({
        writer,
        finalizeFrozenError: new Error('冻结收敛失败'),
      });

      let caught: unknown = null;
      try {
        await usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((error) => String((error as Error).message))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('恢复期冻结'),
          expect.stringContaining('冻结收敛失败'),
        ]),
      );
      expect(finalizeFrozenImport).toHaveBeenCalledTimes(1);
      expect(finalizeImport).not.toHaveBeenCalled();
    });

    it('非冻结写入异常：如实记 FAILED、不冻结收敛、不自动重试', async () => {
      const writer = buildWriterMock({ writeError: new Error('受控写入失败') });
      const { usecase, finalizeImport, finalizeFrozenImport, writeItemResult } = buildUsecase({
        writer,
      });

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).resolves.toMatchObject({ outcome: 'imported' });

      expect(writeItemResult).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          result: 'FAILED',
          errorMessage: expect.stringContaining('受控写入失败'),
        }),
        expect.anything(),
      );
      expect(finalizeImport).toHaveBeenCalledWith(
        PACKAGE_ID,
        { status: 'FAILED', succeeded: 0, failed: 1 },
        CHECKSUM,
        expect.anything(),
      );
      expect(finalizeFrozenImport).not.toHaveBeenCalled();
      expect(writer.write).toHaveBeenCalledTimes(1);
    });

    it('占用前冻结解冻后同包可重试：不残留失败占用', async () => {
      const writer = buildWriterMock();
      const { usecase, claimImportRun, finalizeImport, finalizeFrozenImport } = buildUsecase({
        writer,
        writableErrors: [heldError()],
      });
      const command = {
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      };

      await expect(usecase.execute(command)).rejects.toMatchObject({
        code: SYNC_ERROR.WRITE_HELD,
      });
      expect(claimImportRun).not.toHaveBeenCalled();

      await expect(usecase.execute(command)).resolves.toMatchObject({ outcome: 'imported' });
      expect(claimImportRun).toHaveBeenCalledTimes(1);
      expect(finalizeFrozenImport).not.toHaveBeenCalled();
      expect(finalizeImport).toHaveBeenCalledWith(
        PACKAGE_ID,
        { status: 'SUCCEEDED', succeeded: 1, failed: 0 },
        CHECKSUM,
        expect.anything(),
      );
    });

    it('冻结收敛后同包重试成为新尝试：旧执行只终态一次，新尝试独立 claim/终态', async () => {
      const writer = buildWriterMock({ writeError: heldError() });
      const { usecase, claimImportRun, finalizeImport, finalizeFrozenImport } = buildUsecase({
        writer,
      });
      const command = {
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      };

      await expect(usecase.execute(command)).rejects.toMatchObject({
        code: SYNC_ERROR.WRITE_HELD,
      });
      expect(claimImportRun).toHaveBeenCalledTimes(1);
      expect(finalizeFrozenImport).toHaveBeenCalledTimes(1);
      expect(finalizeImport).not.toHaveBeenCalled();

      // 解冻后同一份包再次确认：旧执行不会“复活”，新请求重新 claim 并正常终态。
      writer.write.mockResolvedValue({ status: 'CREATED', localRecordId: 42, reason: null });
      await expect(usecase.execute(command)).resolves.toMatchObject({ outcome: 'imported' });
      expect(claimImportRun).toHaveBeenCalledTimes(2);
      expect(finalizeFrozenImport).toHaveBeenCalledTimes(1);
      expect(finalizeImport).toHaveBeenCalledTimes(1);
    });

    it('同账号 RUNNING 仍受控拒绝，不触发冻结收敛接管', async () => {
      const writer = buildWriterMock();
      const { usecase, claimImportRun, finalizeImport, finalizeFrozenImport } = buildUsecase({
        writer,
      });
      claimImportRun.mockRejectedValueOnce(
        new DomainError(RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS, '记录包正在导入中，未自动接管'),
      );

      await expect(
        usecase.execute({
          session: SESSION,
          packageId: PACKAGE_ID,
          packagePath: '/mnt/usb/pkg',
          manifestChecksum: CHECKSUM,
        }),
      ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });

      expect(finalizeImport).not.toHaveBeenCalled();
      expect(finalizeFrozenImport).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
    });
  });

  it('P2-02｜确认时原件变化：该条标检查未通过未执行，其他条目正常导入且批次 PARTIAL', async () => {
    const otherUuid = '22222222-3333-4444-8555-666666666666';
    const { usecase, finalizeImport, writeItemResult, markItemCheckRejected, findReceipt } =
      buildUsecase({
        writer: WRITER_OK,
        items: [
          makeItem({ itemId: 'item-tampered', recordUuid: RECORD_UUID, versionNo: 1 }),
          makeItem({ itemId: 'item-clean', recordUuid: otherUuid, versionNo: 1 }),
        ],
        manifestItems: [
          {
            record_uuid: RECORD_UUID,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 1,
            content_snapshot: { schema_version: 1, payload: { title: 'x' } },
            files: [{ relative_path: 'changed.bin', sha256: 'f'.repeat(64), byte_size: 1 }],
          },
          {
            record_uuid: otherUuid,
            resource_type: 'MAINTENANCE_REPORT',
            version_no: 1,
            content_snapshot: { schema_version: 1, payload: { title: 'y' } },
            files: [],
          },
        ],
        freshOutcomes: [
          {
            resourceType: 'MAINTENANCE_REPORT',
            recordUuid: RECORD_UUID,
            versionNo: 1,
            passed: false,
            rejection: 'FILE_CHECKSUM_MISMATCH',
            message: 'SHA-256 不符：changed.bin',
          },
          {
            resourceType: 'MAINTENANCE_REPORT',
            recordUuid: otherUuid,
            versionNo: 1,
            passed: true,
            rejection: null,
            message: null,
          },
        ],
      });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(markItemCheckRejected).toHaveBeenCalledWith(
      'item-tampered',
      'SHA-256 不符：changed.bin',
    );
    expect(writeItemResult).not.toHaveBeenCalledWith(
      'item-tampered',
      expect.anything(),
      expect.anything(),
    );
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-clean',
      expect.objectContaining({ result: 'SUCCEEDED' }),
      expect.anything(),
    );
    expect(findReceipt).toHaveBeenCalledTimes(1);
    expect(finalizeImport).toHaveBeenCalledWith(
      PACKAGE_ID,
      { status: 'PARTIAL', succeeded: 1, failed: 0 },
      CHECKSUM,
      expect.anything(),
    );
  });

  it('P2-02｜确认时已有回执条目新鲜检查失败：不进入回执去重，不报 SKIPPED', async () => {
    const { usecase, writeItemResult, markItemCheckRejected, findReceipt, recordImportedVersion } =
      buildUsecase({
        writer: WRITER_OK,
        receiptExists: true,
        freshOutcomes: [
          {
            resourceType: 'MAINTENANCE_REPORT',
            recordUuid: RECORD_UUID,
            versionNo: 2,
            passed: false,
            rejection: 'FILE_CHECKSUM_MISMATCH',
            message: '确认时原件摘要变化',
          },
        ],
      });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(markItemCheckRejected).toHaveBeenCalledWith('item-1', '确认时原件摘要变化');
    expect(findReceipt).not.toHaveBeenCalled();
    expect(writeItemResult).not.toHaveBeenCalled();
    expect(recordImportedVersion).not.toHaveBeenCalled();
  });

  it('P2-02｜确认时无回执同版本条目新鲜检查失败：不触发补回执或业务写入', async () => {
    const writer = buildWriterMock();
    const { usecase, markItemCheckRejected, recordImportedVersion, assertCompanyWritable, stage } =
      buildUsecase({
        writer,
        localFact: { withdrawn: false, currentVersion: 2, identityPersisted: true },
        freshOutcomes: [
          {
            resourceType: 'MAINTENANCE_REPORT',
            recordUuid: RECORD_UUID,
            versionNo: 2,
            passed: false,
            rejection: 'FILE_MISSING',
            message: '缺少原件文件',
          },
        ],
      });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(markItemCheckRejected).toHaveBeenCalledWith('item-1', '缺少原件文件');
    expect(recordImportedVersion).not.toHaveBeenCalled();
    expect(assertCompanyWritable).toHaveBeenCalledTimes(1);
    expect(writer.verifySourceIdentity).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('P2-02｜同 UUID 不同资源/版本按完整键映射，不误用 UUID 单键', async () => {
    const otherUuid = '33333333-4444-4555-8666-777777777777';
    const { usecase, writeItemResult } = buildUsecase({
      writer: buildWriterMock({
        supportedResourceTypes: ['MAINTENANCE_REPORT', 'REPAIR_REQUEST'],
      }),
      items: [
        makeItem({
          itemId: 'item-uuid-report',
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: RECORD_UUID,
          versionNo: 1,
        }),
        makeItem({
          itemId: 'item-uuid-request',
          resourceType: 'REPAIR_REQUEST',
          recordUuid: RECORD_UUID,
          versionNo: 1,
        }),
        makeItem({
          itemId: 'item-other-version',
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: otherUuid,
          versionNo: 2,
        }),
      ],
      manifestItems: [
        {
          record_uuid: RECORD_UUID,
          resource_type: 'MAINTENANCE_REPORT',
          version_no: 1,
          content_snapshot: { schema_version: 1, payload: { title: 'report' } },
          files: [],
          source_account_id: 5,
          owner_organization_id: 9,
        },
        {
          record_uuid: RECORD_UUID,
          resource_type: 'REPAIR_REQUEST',
          version_no: 1,
          content_snapshot: { schema_version: 1, payload: { title: 'request' } },
          files: [],
          source_account_id: 5,
          owner_organization_id: 9,
        },
        {
          record_uuid: otherUuid,
          resource_type: 'MAINTENANCE_REPORT',
          version_no: 2,
          content_snapshot: { schema_version: 1, payload: { title: 'other' } },
          files: [],
          source_account_id: 5,
          owner_organization_id: 9,
        },
      ],
      freshOutcomes: [
        {
          resourceType: 'REPAIR_REQUEST',
          recordUuid: RECORD_UUID,
          versionNo: 1,
          passed: true,
          rejection: null,
          message: null,
        },
        {
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: otherUuid,
          versionNo: 2,
          passed: true,
          rejection: null,
          message: null,
        },
        {
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: RECORD_UUID,
          versionNo: 1,
          passed: true,
          rejection: null,
          message: null,
        },
      ],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    for (const itemId of ['item-uuid-report', 'item-uuid-request', 'item-other-version']) {
      expect(writeItemResult).toHaveBeenCalledWith(
        itemId,
        expect.objectContaining({ result: 'SUCCEEDED' }),
        expect.anything(),
      );
    }
  });

  it('P2-02｜不同键乱序返回时确认期文件失败仍落到正确条目', async () => {
    const otherUuid = '44444444-5555-4666-8777-888888888888';
    const { usecase, writeItemResult, markItemCheckRejected } = buildUsecase({
      writer: WRITER_OK,
      items: [
        makeItem({ itemId: 'item-changed', recordUuid: RECORD_UUID, versionNo: 1 }),
        makeItem({ itemId: 'item-ok', recordUuid: otherUuid, versionNo: 3 }),
      ],
      manifestItems: [
        {
          record_uuid: RECORD_UUID,
          resource_type: 'MAINTENANCE_REPORT',
          version_no: 1,
          content_snapshot: { schema_version: 1, payload: { title: 'changed' } },
          files: [],
          source_account_id: 5,
          owner_organization_id: 9,
        },
        {
          record_uuid: otherUuid,
          resource_type: 'MAINTENANCE_REPORT',
          version_no: 3,
          content_snapshot: { schema_version: 1, payload: { title: 'ok' } },
          files: [],
          source_account_id: 5,
          owner_organization_id: 9,
        },
      ],
      freshOutcomes: [
        {
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: otherUuid,
          versionNo: 3,
          passed: true,
          rejection: null,
          message: null,
        },
        {
          resourceType: 'MAINTENANCE_REPORT',
          recordUuid: RECORD_UUID,
          versionNo: 1,
          passed: false,
          rejection: 'FILE_CHECKSUM_MISMATCH',
          message: '确认时 SHA-256 不符',
        },
      ],
    });

    await usecase.execute({
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    });

    expect(markItemCheckRejected).toHaveBeenCalledWith('item-changed', '确认时 SHA-256 不符');
    expect(writeItemResult).toHaveBeenCalledWith(
      'item-ok',
      expect.objectContaining({ result: 'SUCCEEDED' }),
      expect.anything(),
    );
    expect(writeItemResult).not.toHaveBeenCalledWith(
      'item-changed',
      expect.anything(),
      expect.anything(),
    );
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
      CHECKSUM,
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

  // ── 复验 P1：导入确认与占用必须绑定到同一批次版本（时序反例） ────────────────
  /**
   * 复现"B 先完成换包重检（V2）、A 再占用"的交错：
   * - A 读到并确认旧摘要 V1、旧 items；
   * - B 用同公司同编号的不同摘要 V2 重检并提交（批次与 items 被替换）；
   * - A 继续占用并执行。
   *
   * 这里用**带状态的受控替身**模拟数据库的"当前读"语义（不是真库证据）：
   * 替身保存批次的当前版本，占用时按**当前**摘要核对。
   */
  it('复验 P1｜换包重检（V2）先提交时：旧确认的导入必须受控拒绝，零业务写入、零终态更新', async () => {
    const writer = buildWriterMock();
    const v1Items = [makeItem({ itemId: 'item-v1' })];
    const v2Items = [makeItem({ itemId: 'item-v2' })];
    const state = {
      import: {
        packageId: PACKAGE_ID,
        organizationId: 9,
        importedByAccountId: 900101,
        manifestJson: JSON.stringify({
          schema_version: 1,
          package_id: PACKAGE_ID,
          organization_id: 9,
          organization_code: 'ORG-9',
          installation_id: '88888888-9999-4aaa-8bbb-cccccccccccc',
          created_at: '2026-11-22T00:00:00.000Z',
          items: [
            {
              record_uuid: RECORD_UUID,
              resource_type: 'MAINTENANCE_REPORT',
              version_no: 2,
              content_snapshot: { schema_version: 1, payload: { title: 'x' } },
              files: [],
              source_account_id: 900101,
              owner_organization_id: 9,
            },
          ],
        }),
        manifestChecksum: CHECKSUM,
        status: 'PENDING',
        checkStatus: 'PASSED',
        itemTotal: 1,
        itemSucceeded: 0,
        itemFailed: 0,
        createdAt: new Date(),
        completedAt: null,
      },
      items: v1Items,
    };

    const readImportFacts = jest.fn(() =>
      Promise.resolve({
        import: { ...state.import },
        items: [...state.items],
      }),
    );
    // A 读盘评估期间：B 完成换包重检（V2）并提交 —— 批次与逐条事实被替换。
    const evaluatePackage = jest.fn(() => {
      state.import = { ...state.import, manifestChecksum: 'b'.repeat(64), status: 'PENDING' };
      state.items = v2Items;
      return Promise.resolve({
        manifestChecksum: CHECKSUM,
        manifest: {},
        manifestRaw: '{}',
        outcomes: [],
        targetOrganizationId: 9,
      });
    });
    // 占用：按**当前**数据库事实核对版本（旧确认失效 ⇒ 受控拒绝）。
    const claimImportRun = jest.fn((input: { manifestChecksum: string }) => {
      if (state.import.manifestChecksum !== input.manifestChecksum) {
        return Promise.reject(
          new DomainError(
            RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
            '记录包内容已变更，本次确认已失效，请重新检查并确认',
          ),
        );
      }
      state.import = { ...state.import, status: 'RUNNING' };
      return Promise.resolve({ import: { ...state.import }, items: [...state.items] });
    });
    const writeItemResult = jest.fn().mockResolvedValue(undefined);
    const finalizeImport = jest.fn().mockResolvedValue(undefined);

    const usecase = new ImportRecordPackageUsecase(
      { resolve: jest.fn().mockResolvedValue({ organizationId: 9, role: 'ENGINEER' }) } as never,
      {
        readImportFacts,
        evaluatePackage,
        claimImportRun,
        finalizeImport,
        writeItemResult,
        findReceipt: jest.fn().mockResolvedValue(null),
      } as never,
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-9' }),
      } as never,
      { recordImportedVersion: jest.fn().mockResolvedValue('receipt-new') } as never,
      { stage: jest.fn().mockResolvedValue([]), release: jest.fn().mockResolvedValue(0) } as never,
      {
        listFacts: jest.fn().mockResolvedValue({ facts: new Map(), scanComplete: true }),
      } as never,
      { assertCompanyWritable: jest.fn().mockResolvedValue(undefined) } as never,
      { get: jest.fn(() => writer) } as never,
      { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
    );

    await expect(
      usecase.execute({
        session: SESSION,
        packageId: PACKAGE_ID,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED });

    // 零业务写入、零旧条目更新、零批次终态更新
    expect(writer.write).not.toHaveBeenCalled();
    expect(writeItemResult).not.toHaveBeenCalled();
    expect(finalizeImport).not.toHaveBeenCalled();
    // V2 逐项不变：摘要、条目与状态都没被 A 的旧确认改动
    expect(state.import.manifestChecksum).toBe('b'.repeat(64));
    expect(state.import.status).toBe('PENDING');
    expect(state.items).toEqual(v2Items);
  });

  // ── 同账号并发（正式用例＋可控屏障，复验 P1） ────────────────────────────────
  it('同账号并发：A 在业务写入前暂停时，B 的同一请求受控拒绝且业务写入/暂存/回执/条目/终态全为零', async () => {
    const writer = buildWriterMock();
    const gate = { release: () => undefined as void };
    const barrier = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    // A 停在"业务写入前"：已进入受控写入替身，但尚未产生任何结果。
    writer.write.mockImplementation(() =>
      barrier.then(() => ({ status: 'CREATED', localRecordId: 42, reason: null })),
    );

    const {
      usecase,
      claimImportRun,
      finalizeImport,
      writeItemResult,
      recordImportedVersion,
      stage,
      release,
    } = buildUsecase({ writer });
    const originalClaim = claimImportRun.getMockImplementation();
    if (originalClaim === undefined) {
      throw new Error('测试夹具缺少占用替身');
    }
    // 占用替身按真实服务的失败关闭语义：批次 RUNNING 后，任何人（含同账号）都拒绝。
    let running = false;
    claimImportRun.mockImplementation((input: { importedByAccountId: number }) => {
      if (running) {
        return Promise.reject(
          new DomainError(
            RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
            '记录包正在导入中；若执行进程已中断，请用新编号重新导出后导入',
          ),
        );
      }
      running = true;
      return originalClaim(input);
    });

    const request = {
      session: SESSION,
      packageId: PACKAGE_ID,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: CHECKSUM,
    };
    const aPromise = usecase.execute(request);
    // 等 A 真正停在屏障上（而不是靠固定 sleep 猜时序）
    for (let attempt = 0; attempt < 100 && writer.write.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(writer.write).toHaveBeenCalledTimes(1);

    // B：同账号、同包、同摘要
    await expect(usecase.execute(request)).rejects.toMatchObject({
      code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
    });

    // B 的副作用全为零（A 仍停在屏障，下列替身都不应被调用）
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recordImportedVersion).not.toHaveBeenCalled();
    expect(writeItemResult).not.toHaveBeenCalled();
    expect(finalizeImport).not.toHaveBeenCalled();

    // A 恢复后只产生一份结果
    gate.release();
    await expect(aPromise).resolves.toMatchObject({ outcome: 'imported' });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(finalizeImport).toHaveBeenCalledTimes(1);
  });
});
