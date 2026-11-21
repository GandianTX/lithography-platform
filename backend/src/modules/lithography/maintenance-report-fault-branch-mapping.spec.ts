// 维修报告故障分支「领域枚举 ↔ DB CHECK 值」双向映射回归。
//
// 背景（2026-11-21 实库验收发现）：数据库 CHECK `chk_maintenance_report_fault_branch`
// 只允许 `INITIAL_PANEL / NEW_FAULT_BRANCH / STEP_NEW_FAULT`，而领域枚举
// `MaintenanceReportFaultBranchKind` 为 `INITIAL / RESET_NEW_FAULT / STEP_NEW_FAULT`。
// 写入与读取都必须在模块层显式双向转换，保持已接受迁移与 CHECK 不变。

/// <reference types="jest" />
import { MAINTENANCE_REPORT_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  MaintenanceReportFaultBranchKind,
  MaintenancePhaseCode,
} from '@app-types/models/maintenance-report.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import type { EntityManager } from 'typeorm';
import { MaintenanceReportService } from './maintenance-report.service';
import {
  faultBranchKindFromDb,
  faultBranchKindToDb,
  toMaintenanceReportFaultSnapshot,
} from './maintenance-report.mapper';
import type { MaintenanceReportFaultWriteData } from './maintenance-report.types';

describe('维修报告故障分支：领域值 ↔ DB CHECK 值双向映射', () => {
  it('写入方向：领域枚举映射为 DB CHECK 允许值', () => {
    expect(faultBranchKindToDb(MaintenanceReportFaultBranchKind.INITIAL)).toBe('INITIAL_PANEL');
    expect(faultBranchKindToDb(MaintenanceReportFaultBranchKind.RESET_NEW_FAULT)).toBe(
      'NEW_FAULT_BRANCH',
    );
    expect(faultBranchKindToDb(MaintenanceReportFaultBranchKind.STEP_NEW_FAULT)).toBe(
      'STEP_NEW_FAULT',
    );
  });

  it('读取方向：DB 值映射回领域枚举（快照）', () => {
    const buildEntity = (branchKind: string) =>
      ({
        id: '1',
        reportId: 31,
        faultUuid: 'f-1',
        branchKind,
        stepCode: null,
        phaseCode: MaintenancePhaseCode.PHASE_02,
        mainError: 'DEV-E-5101',
        unitError: 'ALM-501',
        source: 'MAIN',
        errorType: 'EQUIPMENT',
        gpibStatus: 'NORMAL',
        status: 'OPEN',
        faultDescription: '镜片污染导致曝光异常。',
        handlingAction: '清洁镜片并复测。',
      }) as never;

    expect(toMaintenanceReportFaultSnapshot(buildEntity('INITIAL_PANEL')).branchKind).toBe(
      MaintenanceReportFaultBranchKind.INITIAL,
    );
    expect(toMaintenanceReportFaultSnapshot(buildEntity('NEW_FAULT_BRANCH')).branchKind).toBe(
      MaintenanceReportFaultBranchKind.RESET_NEW_FAULT,
    );
    expect(toMaintenanceReportFaultSnapshot(buildEntity('STEP_NEW_FAULT')).branchKind).toBe(
      MaintenanceReportFaultBranchKind.STEP_NEW_FAULT,
    );
  });

  it('未知 DB 值失败关闭（不静默透传）', () => {
    expect(() => faultBranchKindFromDb('INITIAL')).toThrow(DomainError);
    try {
      faultBranchKindFromDb('INITIAL');
    } catch (error) {
      expect((error as DomainError).code).toBe(MAINTENANCE_REPORT_ERROR.DATA_INCONSISTENT);
    }
    expect(() => faultBranchKindFromDb('RESET_NEW_FAULT')).toThrow(DomainError);
  });

  it('replaceFaults 落库为 DB CHECK 允许值并保留步骤关联', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const faultRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn((data: Record<string, unknown>) => data),
      insert: jest.fn((rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return { identifiers: [], generatedMaps: [], raw: [] };
      }),
    };
    const manager = {
      getRepository: jest.fn(() => faultRepository),
    } as unknown as EntityManager;
    const transactionContext = createTypeOrmPersistenceTransactionContext(manager);
    const service = new MaintenanceReportService(
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
      faultRepository as never,
    );

    const faults: MaintenanceReportFaultWriteData[] = [
      {
        branchKind: MaintenanceReportFaultBranchKind.INITIAL,
        stepCode: null,
        phaseCode: MaintenancePhaseCode.PHASE_03,
        mainError: 'DEV-E-5101',
        unitError: 'ALM-501',
        source: 'MAIN',
        errorType: 'EQUIPMENT',
        gpibStatus: 'NORMAL',
        faultStatus: 'ACTIVE',
        description: '镜片污染导致曝光异常。',
        action: '清洁镜片并复测。',
      },
      {
        branchKind: MaintenanceReportFaultBranchKind.RESET_NEW_FAULT,
        stepCode: null,
        phaseCode: MaintenancePhaseCode.PHASE_07,
        mainError: 'DEV-E-5103',
        unitError: 'ALM-507',
        source: 'UNIT',
        errorType: 'EQUIPMENT',
        gpibStatus: 'ABNORMAL',
        faultStatus: 'ACTIVE',
        description: '复位后出现新的对准报警。',
        action: '记录新故障并安排下一次上门。',
      },
      {
        branchKind: MaintenanceReportFaultBranchKind.STEP_NEW_FAULT,
        stepCode: 'STEP-01',
        phaseCode: MaintenancePhaseCode.PHASE_04,
        mainError: 'DEV-E-4102',
        unitError: 'ALM-410',
        source: 'UNIT',
        errorType: 'EQUIPMENT',
        gpibStatus: 'ABNORMAL',
        faultStatus: 'ACTIVE',
        description: '真空压力持续偏低。',
        action: '等待备件后更换密封件。',
      },
    ];

    await service.replaceFaults(31, faults, transactionContext);

    expect(inserted.map((row) => row.branchKind)).toEqual([
      'INITIAL_PANEL',
      'NEW_FAULT_BRANCH',
      'STEP_NEW_FAULT',
    ]);
    expect(inserted[2]?.stepCode).toBe('STEP-01');
    expect(inserted[0]?.stepCode).toBeNull();
    expect(inserted[1]?.stepCode).toBeNull();
  });
});
