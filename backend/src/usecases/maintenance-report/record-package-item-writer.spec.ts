// src/usecases/maintenance-report/record-package-item-writer.spec.ts
/// <reference types="jest" />

/**
 * 记录包受控写入（维修报告域）的定向测试（任务 09 S3 补丁 P2／P4）。
 *
 * 守住补丁要求的关键行为：
 * - 按包内事实落库：**保持 record_uuid、原作者、公司、版本与业务状态**，
 *   并写入同版本冻结版本行（不是"新建一个无关草稿"）；
 * - 缺来源账号／缺来源状态／带原件／工单总结来源 → 失败关闭，不静默降级、不冒用账号。
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
  ownerOrganizationId: 9,
  sourceStatus: 'SUBMITTED',
};

function buildWriter(options: { insertError?: Error } = {}) {
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
  const writer = new MaintenanceReportRecordPackageItemWriter(
    {
      insertReport,
      insertVersion,
      insertVersionAttachments,
    } as never,
    {} as never,
    {} as never,
    { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
  );
  return { writer, insertReport, insertVersion, insertVersionAttachments };
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

  it('工单总结来源：关联工单事实规则未确认前拒绝', async () => {
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

  it('P4｜原账号恰为当前导入账号：导入前后作者事实相同（都写来源账号）', async () => {
    const { writer, insertReport } = buildWriter();

    await writer.write(REQUEST, { ...(SESSION as object), accountId: 900101 } as never);

    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    // 导入会话账号恰好就是包内来源账号 → 写入的作者与来源账号一致
    expect(insertData.createdByAccountId).toBe(900101);
    expect(insertData.updatedByAccountId).toBe(900101);
  });

  it('P4｜伪造包内账号：库层拒绝即该条失败，不静默改成导入人', async () => {
    const { writer, insertReport } = buildWriter({ insertError: new Error('外键约束失败') });

    const outcome = await writer.write({ ...REQUEST, sourceAccountId: 999999999 }, {
      ...(SESSION as object),
      accountId: 900101,
    } as never);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('受控写入被拒绝');
    // 关键：失败路径不得回退成"用导入人当作者"——写入参数里作者恒为包内来源账号
    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.createdByAccountId).toBe(999999999);
  });

  it('P4｜同公司他人：作者恒为包内来源账号，导入者不被写入业务行', async () => {
    const { writer, insertReport } = buildWriter();

    await writer.write({ ...REQUEST, sourceAccountId: 900202 }, SESSION);

    const insertData = insertReport.mock.calls[0][0] as Record<string, unknown>;
    expect(insertData.createdByAccountId).toBe(900202);
    expect(insertData.updatedByAccountId).toBe(900202);
    // 导入会话账号（900101）不得出现在作者字段
    expect(insertData.createdByAccountId).not.toBe(900101);
  });

  it('受控写入被库层拒绝时如实带回失败原因', async () => {
    const { writer } = buildWriter({ insertError: new Error('外键约束失败') });

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('外键约束失败');
  });
});
