// src/usecases/maintenance-report/record-package-item-writer.spec.ts
/// <reference types="jest" />

/**
 * 记录包受控写入（维修报告域）的定向测试（任务 09 S3.2）。
 *
 * 守住三条边界：不支持的类型失败关闭、带原件失败关闭（不静默丢原件）、
 * 工单总结来源不可由记录包导入；正常路径必须走来源域受控入口。
 */

import { MaintenanceReportRecordPackageItemWriter } from './record-package-item-writer';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ENGINEER',
  roles: ['ENGINEER'],
  identityType: 'ENGINEER',
  adminLevel: null,
} as never;

function buildWriter(createResult: { reportId: number } | Error) {
  const execute = jest.fn((_command: unknown) => {
    if (createResult instanceof Error) {
      return Promise.reject(createResult);
    }
    return Promise.resolve(createResult);
  });
  return {
    execute,
    writer: new MaintenanceReportRecordPackageItemWriter({ execute } as never),
  };
}

const REQUEST = {
  resourceType: 'MAINTENANCE_REPORT' as const,
  recordUuid: '11111111-2222-4333-8444-555555555555',
  versionNo: 2,
  organizationId: 9,
  body: {
    schema_version: 1,
    payload: {
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      title: '历史案例报告',
      customerFactoryName: '某工厂',
      equipmentModelId: null,
      equipmentModelText: '某机型',
      maintenanceDate: '2026-11-01',
      alarms: [],
      steps: [{ stepNo: 1, stepCode: 'S1', phaseCode: 'P1', actionText: '检查' }],
      faults: [],
    },
  },
  originals: [],
  manifestChecksum: 'a'.repeat(64),
};

describe('记录包受控写入（维修报告域）', () => {
  it('正常路径：走来源域受控入口并返回新建结论', async () => {
    const { writer, execute } = buildWriter({ reportId: 42 });

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('CREATED');
    expect(outcome.localRecordId).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0][0] as { sourceType: string; draft: { title: string } };
    expect(command.sourceType).toBe('HISTORICAL_CASE');
    expect(command.draft.title).toBe('历史案例报告');
  });

  it('带原件的条目失败关闭（不静默丢弃原件）', async () => {
    const { writer, execute } = buildWriter({ reportId: 42 });

    const outcome = await writer.write(
      {
        ...REQUEST,
        originals: [{ relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1 }],
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('原件');
    expect(execute).not.toHaveBeenCalled();
  });

  it('工单总结来源的报告不可由记录包导入', async () => {
    const { writer, execute } = buildWriter({ reportId: 42 });

    const outcome = await writer.write(
      {
        ...REQUEST,
        body: {
          ...REQUEST.body,
          payload: { ...(REQUEST.body.payload as object), sourceType: 'WORK_ORDER_SUMMARY' },
        },
      },
      SESSION,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('工单总结');
    expect(execute).not.toHaveBeenCalled();
  });

  it('非维修报告类型失败关闭', async () => {
    const { writer, execute } = buildWriter({ reportId: 42 });

    const outcome = await writer.write({ ...REQUEST, resourceType: 'REFERENCE_DOCUMENT' }, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('受控入口拒绝时如实带回失败原因', async () => {
    const { writer } = buildWriter(new Error('机型不存在'));

    const outcome = await writer.write(REQUEST, SESSION);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('机型不存在');
  });
});
