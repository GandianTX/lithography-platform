// src/usecases/maintenance-report/record-package-item-writer.spec.ts
/// <reference types="jest" />

/**
 * 记录包受控写入（维修报告域）的定向测试（任务 09 S3 补丁 P2／P4）。
 *
 * 守住补丁要求的关键行为：
 * - 按包内事实落库：**保持 record_uuid、原作者、公司、版本与业务状态**，
 *   并写入同版本冻结版本行（不是"新建一个无关草稿"）；
 * - 缺来源账号／缺来源状态／带原件／工单总结来源 → 失败关闭，不静默降级、不冒用账号；
 * - **来源身份不可信时（P4）→ 写业务之前就拒绝**：包内自报的来源账号不是授权真源，
 *   账号不存在／已停用／归属已变更／导入者对它没有当前权限都必须拒绝该条。
 */

import { MaintenanceReportRecordPackageItemWriter } from './record-package-item-writer';

const bindStagedAttachmentToReport = jest.fn((_params?: unknown) =>
  Promise.resolve({ id: 5, sortOrder: 1, description: null }),
);

jest.mock('./maintenance-report-attachment-binding.helpers', () => ({
  bindStagedAttachmentToReport: (params?: unknown) => bindStagedAttachmentToReport(params),
}));

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ENGINEER',
  roles: ['ENGINEER'],
  identityType: 'ENGINEER',
  adminLevel: null,
} as never;

const REQUEST = {
  resourceType: 'MAINTENANCE_REPORT' as const,
  recordUuid: '11111111-2222-4333-8444-555555555555',
  versionNo: 2,
  organizationId: 9,
  sourceEquipmentModelCode: null,
  body: {
    schema_version: 1,
    record_id: 12,
    report_version_no: 2,
    change_kind: 'SUBMIT',
    submitted_at: '2026-11-01T00:00:00.000Z',
    payload: {
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      title: '历史案例报告',
      customerFactoryName: '某工厂',
      equipmentModelId: null,
      equipmentModelText: '某机型',
      maintenanceDate: '2026-11-01',
      maintenanceEngineerAccountId: 900101,
      maintenanceEngineerName: '某工程师',
      phaseFlowVersion: 1,
      alarms: [],
      steps: [],
      faults: [],
    },
  },
  originals: [],
  manifestChecksum: 'a'.repeat(64),
  sourceAccountId: 900101,
  portableSourceIdentity: {
    sourceAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sourceAccountLoginName: 'engineer-1',
    sourceAccountName: '某工程师',
    sourceOrganizationCode: 'ORG-9',
  },
  ownerOrganizationId: 9,
  relatedRecordUuid: null,
  relatedRecordType: null,
  sourceStatus: 'SUBMITTED',
};

/**
 * 默认核验替身：按端口契约的口径拒绝"缺来源账号"，其余放行并带回来源账号。
 * 具体裁决逻辑（账号状态／归属公司／导入者权限）由 core 策略与其单测负责。
 */
function buildVerifier(override?: {
  verify: (params: {
    sourceAccountId: number | null;
    portableSourceIdentity: {
      sourceAccountUuid: string | null;
      sourceAccountLoginName: string | null;
      sourceAccountName: string | null;
      sourceOrganizationCode: string | null;
    };
    ownerOrganizationId: number | null;
    targetOrganizationId: number;
    importerAccountId: number;
  }) => Promise<{ allowed: true; sourceAccountId: number } | { allowed: false; reason: string }>;
}) {
  return {
    verify: jest.fn(
      override?.verify ??
        ((params: { sourceAccountId: number | null }) =>
          Promise.resolve(
            params.sourceAccountId === null
              ? {
                  allowed: false as const,
                  reason: '包内未携带来源账号，原作者不可核验（不以导入人冒充原作者），该条未导入',
                }
              : { allowed: true as const, sourceAccountId: params.sourceAccountId },
          )),
    ),
  };
}

function buildWriter(
  options: {
    insertError?: Error;
    verifier?: ReturnType<typeof buildVerifier>;
    /** 来源域只读事实（工单定位）替身 */
    sourceFacts?: { listFacts: jest.Mock };
    /** 机型查询替身 */
    equipmentModel?: { findModelByCode: jest.Mock };
  } = {},
) {
  const insertReport = jest.fn((_data?: Record<string, unknown>) => {
    if (options.insertError !== undefined) {
      return Promise.reject(options.insertError);
    }
    return Promise.resolve({ id: 42 });
  });
  const insertVersion = jest.fn((_data?: Record<string, unknown>) =>
    Promise.resolve({ versionId: 7 }),
  );
  const insertVersionAttachments = jest.fn(
    (_versionId?: unknown, _reportId?: unknown, _rows?: unknown) => Promise.resolve(undefined),
  );
  const verifier = options.verifier ?? buildVerifier();
  const writer = new MaintenanceReportRecordPackageItemWriter(
    {
      insertReport,
      insertVersion,
      insertVersionAttachments,
    } as never,
    {} as never, // maintenanceReportQueryService
    (options.sourceFacts ?? {
      listFacts: jest.fn().mockResolvedValue({ facts: new Map(), scanComplete: true }),
    }) as never, // syncSourceRecordQueryService
    (options.equipmentModel ?? {
      findModelByCode: jest.fn().mockResolvedValue(null),
    }) as never, // equipmentModelQueryService
    {} as never, // storedFileService
    verifier as never, // sourceIdentityVerifier
    { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
    {
      assertCompanyWritableInTransaction: () => Promise.resolve(),
    } as never, // localWriteHoldService
  );
  return { writer, insertReport, insertVersion, insertVersionAttachments, verifier };
}

describe('记录包受控写入（维修报告域，S3 补丁 P2/P4）', () => {
  it('正常路径：保持包内身份、原作者、公司、版本与状态，并写入同版本冻结版本行', async () => {
    const { writer, insertReport, insertVersion } = buildWriter();

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('CREATED');
    expect(outcome.localRecordId).toBe(42);
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.recordUuid).toBe(REQUEST.recordUuid);
    expect(insertData.createdByAccountId).toBe(REQUEST.sourceAccountId);
    expect(insertData.ownerOrganizationId).toBe(9);
    expect(insertData.currentVersionNo).toBe(2);
    expect(insertData.status).toBe('SUBMITTED');
    expect(insertData.title).toBe('历史案例报告');
    const versionData = insertVersion.mock.calls[0][0] as Record<string, unknown>;
    expect(versionData.versionNo).toBe(2);
    expect(versionData.submittedByAccountId).toBe(REQUEST.sourceAccountId);
  });

  it('包内缺来源账号：失败关闭（不以导入人冒充原作者）', async () => {
    const { writer, insertReport } = buildWriter();

    const outcome = await writer.write({ ...REQUEST, sourceAccountId: null }, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('来源账号');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('包内缺来源状态：失败关闭（不把正式事实降级成草稿）', async () => {
    const { writer, insertReport } = buildWriter();

    const outcome = await writer.write({ ...REQUEST, sourceStatus: null }, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('业务状态');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('来源状态为已通过结单：按原状态导入，不降级', async () => {
    const { writer, insertReport } = buildWriter();

    await writer.write({ ...REQUEST, sourceStatus: 'APPROVED' }, SESSION);

    expect((insertReport.mock.calls[0][0] as Record<string, unknown>).status).toBe('APPROVED');
  });

  it('原件超出报告附件上限（1 份）时失败关闭（不静默丢弃原件）', async () => {
    const { writer, insertReport } = buildWriter();

    const outcome = await writer.write(
      {
        ...REQUEST,
        originals: [
          {
            fileId: 'f1',
            uploadContextId: 'u1',
            originalFilename: 'a.pdf',
            mimeType: 'application/pdf',
            byteSize: 1,
            checksumSha256: 'b'.repeat(64),
          },
          {
            fileId: 'f2',
            uploadContextId: 'u2',
            originalFilename: 'b.pdf',
            mimeType: 'application/pdf',
            byteSize: 1,
            checksumSha256: 'c'.repeat(64),
          },
        ],
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('上限');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('已暂存原件：在同一事务内绑定到报告根并登记版本附件行', async () => {
    const { writer, insertVersionAttachments } = buildWriter();

    const outcome = await writer.write(
      {
        ...REQUEST,
        originals: [
          {
            fileId: 'f1',
            uploadContextId: 'u1',
            originalFilename: 'a.pdf',
            mimeType: 'application/pdf',
            byteSize: 1,
            checksumSha256: 'b'.repeat(64),
          },
        ],
      },
      SESSION,
    );

    expect(outcome.status).toBe('CREATED');
    expect(bindStagedAttachmentToReport).toHaveBeenCalledTimes(1);
    expect(insertVersionAttachments).toHaveBeenCalledTimes(1);
    const versionRows = insertVersionAttachments.mock.calls[0][2] as {
      attachmentId: number;
    }[];
    expect(versionRows[0].attachmentId).toBe(5);
  });

  it('工单总结来源：包内未携带关联工单的跨端稳定编号时拒绝（不猜工单）', async () => {
    const { writer, insertReport } = buildWriter();

    const outcome = await writer.write(
      {
        ...REQUEST,
        body: {
          ...REQUEST.body,
          payload: { ...REQUEST.body.payload, sourceType: 'WORK_ORDER_SUMMARY' },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('工单总结');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('工单总结来源：按工单跨端稳定编号定位本机工单并写入本机工单 id', async () => {
    const listFacts = jest.fn().mockResolvedValue({
      facts: new Map([
        [
          'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          { recordId: 77, withdrawn: false, currentVersion: 3, identityPersisted: true },
        ],
      ]),
      scanComplete: true,
    });
    const { writer, insertReport, insertVersion } = buildWriter({
      sourceFacts: { listFacts },
    });

    const outcome = await writer.write(
      {
        ...REQUEST,
        relatedRecordType: 'REPAIR_REQUEST',
        relatedRecordUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        body: {
          ...REQUEST.body,
          payload: {
            ...REQUEST.body.payload,
            sourceType: 'WORK_ORDER_SUMMARY',
            repairRequestId: 999,
          },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('CREATED');
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    // 写入的是**本机**工单 id，不是包内的源机数字外键
    expect(insertData.repairRequestId).toBe(77);
    // 冻结载荷里的工单引用同步本地化，避免落库后指向另一张工单
    const versionData = insertVersion.mock.calls[0][0] as Record<string, unknown>;
    const snapshot = versionData.payloadSnapshot as { repairRequestId: number | null };
    expect(snapshot.repairRequestId).toBe(77);
  });

  it('工单总结来源：本机关联工单已删除下架时拒绝（不复活已删除下架内容）', async () => {
    const listFacts = jest.fn().mockResolvedValue({
      facts: new Map([
        [
          'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          { recordId: 77, withdrawn: true, currentVersion: 3, identityPersisted: true },
        ],
      ]),
      scanComplete: true,
    });
    const { writer, insertReport } = buildWriter({ sourceFacts: { listFacts } });

    const outcome = await writer.write(
      {
        ...REQUEST,
        relatedRecordType: 'REPAIR_REQUEST',
        relatedRecordUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        body: {
          ...REQUEST.body,
          payload: { ...REQUEST.body.payload, sourceType: 'WORK_ORDER_SUMMARY' },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('已删除或下架');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('机型 id 跨机不可移植：包内未携带机型编码时拒绝（不静默改成空）', async () => {
    const { writer, insertReport } = buildWriter();

    const outcome = await writer.write(
      {
        ...REQUEST,
        sourceEquipmentModelCode: null,
        body: {
          ...REQUEST.body,
          payload: { ...REQUEST.body.payload, equipmentModelId: 5, equipmentModelText: null },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('机型编码');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('机型按编码在本机定位：写入本机机型 id，且不同时写机型文本（实体 CHECK 二选一）', async () => {
    const findModelByCode = jest
      .fn()
      .mockResolvedValue({ id: 31, modelCode: 'MOD-A', modelName: 'A 型' });
    const { writer, insertReport } = buildWriter({ equipmentModel: { findModelByCode } });

    const outcome = await writer.write(
      {
        ...REQUEST,
        sourceEquipmentModelCode: 'MOD-A',
        body: {
          ...REQUEST.body,
          payload: { ...REQUEST.body.payload, equipmentModelId: 5, equipmentModelText: null },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('CREATED');
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.equipmentModelId).toBe(31);
    expect(insertData.equipmentModelText).toBeNull();
  });

  it('机型按编码在本机定位不到时拒绝（不猜机型）', async () => {
    const findModelByCode = jest.fn().mockResolvedValue(null);
    const { writer, insertReport } = buildWriter({ equipmentModel: { findModelByCode } });

    const outcome = await writer.write(
      {
        ...REQUEST,
        sourceEquipmentModelCode: 'MOD-MISSING',
        body: {
          ...REQUEST.body,
          payload: { ...REQUEST.body.payload, equipmentModelId: 5, equipmentModelText: null },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('设备机型');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('P4｜原账号恰为当前导入账号：导入前后作者事实相同（都写来源账号）', async () => {
    const { writer, insertReport } = buildWriter();

    await writer.write(REQUEST, { ...(SESSION as object), accountId: 900101 } as never);

    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    // 导入会话账号恰好就是包内来源账号 → 写入的作者与来源账号一致
    expect(insertData.createdByAccountId).toBe(900101);
    expect(insertData.updatedByAccountId).toBe(900101);
  });

  it('P4｜伪造包内账号（本机不存在该账号）：写业务之前即拒绝该条', async () => {
    const verifier = buildVerifier({
      verify: () =>
        Promise.resolve({
          allowed: false as const,
          reason: '包内来源账号在本机不存在，原作者不可核验，该条未导入',
        }),
    });
    const { writer, insertReport } = buildWriter({ verifier });

    const outcome = await writer.write({ ...REQUEST, sourceAccountId: 999999999 }, {
      ...(SESSION as object),
      accountId: 900101,
    } as never);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('不存在');
    // 关键：不可信来源账号不得落到业务行（不写、更不回退成导入人）
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('P4｜来源账号已停用：写业务之前即拒绝该条', async () => {
    const verifier = buildVerifier({
      verify: () =>
        Promise.resolve({
          allowed: false as const,
          reason: '包内来源账号已停用（INACTIVE），该条未导入',
        }),
    });
    const { writer, insertReport } = buildWriter({ verifier });

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('已停用');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('P4｜归属变化（来源账号已离开本公司）：写业务之前即拒绝该条', async () => {
    const verifier = buildVerifier({
      verify: () =>
        Promise.resolve({
          allowed: false as const,
          reason: '包内来源账号已离开本公司，该条未导入',
        }),
    });
    const { writer, insertReport } = buildWriter({ verifier });

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('已离开本公司');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('P4｜同公司他人（工程师无当前权限）：拒绝该条，且导入者不被写入业务行', async () => {
    const verifier = buildVerifier({
      verify: () =>
        Promise.resolve({
          allowed: false as const,
          reason: '工程师只能导入本公司当前有权记录（包内来源账号为同公司他人），该条未导入',
        }),
    });
    const { writer, insertReport } = buildWriter({ verifier });

    const outcome = await writer.write({ ...REQUEST, sourceAccountId: 900202 }, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('当前有权');
    expect(insertReport).not.toHaveBeenCalled();
  });

  it('P4｜核验通过时使用**已核验**的来源账号写入作者，不使用包内原值', async () => {
    const verifier = buildVerifier({
      verify: () => Promise.resolve({ allowed: true as const, sourceAccountId: 900303 }),
    });
    const { writer, insertReport } = buildWriter({ verifier });

    const outcome = await writer.write({ ...REQUEST, sourceAccountId: 900303 }, SESSION);

    expect(outcome.status).toBe('CREATED');
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.createdByAccountId).toBe(900303);
    expect(insertData.updatedByAccountId).toBe(900303);
  });

  it('受控写入被库层拒绝时如实带回失败原因，且不回退成导入人', async () => {
    const { writer, insertReport } = buildWriter({ insertError: new Error('外键约束失败') });

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('外键约束失败');
    // 失败路径不得把作者改成导入人
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.createdByAccountId).toBe(REQUEST.sourceAccountId);
    expect(insertData.createdByAccountId).not.toBe(900202);
  });
});
