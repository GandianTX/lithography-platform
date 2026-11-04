/// <reference types="jest" />
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { MaintenanceReportSourceType } from '@app-types/models/maintenance-report.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { MaintenanceReportService } from './maintenance-report.service';
import type { MaintenanceReportInsertData } from './maintenance-report.types';

/**
 * 报告根唯一键冲突的业务映射：
 * - 关联工单且命中 `uk_maintenance_report_request` → 业务冲突（CONFLICT），而非系统错误；
 * - 未关联工单（历史案例）仍按创建失败处理。
 */
describe('MaintenanceReportService.insertReport 唯一键冲突映射', () => {
  const insertData: MaintenanceReportInsertData = {
    ownerOrganizationId: 930001,
    sourceType: MaintenanceReportSourceType.WORK_ORDER_SUMMARY,
    repairRequestId: 955001,
    title: '维修总结',
    customerFactoryName: '甲方工厂',
    equipmentModelId: 930002,
    equipmentModelText: 'XX-100',
    maintenanceDate: '2026-10-01',
    maintenanceEngineerAccountId: 930003,
    maintenanceEngineerNameSnapshot: '工程师',
    phaseFlowVersion: 1,
    createdByAccountId: 930003,
    updatedByAccountId: 930003,
  };

  const duplicateKeyError = (): QueryFailedError => {
    const driverError = new Error('duplicate entry') as Error & { code: string };
    driverError.code = 'ER_DUP_ENTRY';
    return new QueryFailedError('INSERT', [], driverError);
  };

  const createService = (save: jest.Mock) => {
    const repository = {
      create: jest.fn((data: Record<string, unknown>) => data),
      save,
    };
    const manager = {
      getRepository: jest.fn(() => repository),
    } as unknown as EntityManager;
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);
    const service = new MaintenanceReportService(
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
      repository as unknown as never,
    );
    return { service, transactionContext };
  };

  it('关联工单命中唯一键冲突时返回 WORK_ORDER_ALREADY_SUMMARIZED', async () => {
    const save = jest.fn().mockRejectedValue(duplicateKeyError());
    const { service, transactionContext } = createService(save);

    await expect(service.insertReport(insertData, transactionContext)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
      details: { repairRequestId: insertData.repairRequestId },
    });
  });

  it('未关联工单的唯一键冲突仍按 CREATION_FAILED 上报', async () => {
    const save = jest.fn().mockRejectedValue(duplicateKeyError());
    const { service, transactionContext } = createService(save);

    await expect(
      service.insertReport({ ...insertData, repairRequestId: null }, transactionContext),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.CREATION_FAILED });
  });

  it('非唯一键错误按 CREATION_FAILED 上报并保留原始错误为 cause', async () => {
    const failure = new Error('connection reset');
    const save = jest.fn().mockRejectedValue(failure);
    const { service, transactionContext } = createService(save);

    await expect(service.insertReport(insertData, transactionContext)).rejects.toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.CREATION_FAILED,
      cause: failure,
    });
  });
});
