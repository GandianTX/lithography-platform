/// <reference types="jest" />
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { In, type Repository } from 'typeorm';
import { RepairRequestDiagnosticStepEntity } from './entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from './entities/repair-request-fault-panel.entity';
import { RepairRequestMaintenanceService } from './repair-request-maintenance.service';

type StepRow = {
  id: string;
  requestId: number;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

type PanelRow = {
  id: string;
  requestId: number;
  panelType: string;
  stepId: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

const requestId = 101;

const makeStep = (overrides: Partial<StepRow> = {}): StepRow => ({
  id: '1',
  requestId,
  stepNo: 1,
  errorCode: null,
  partName: null,
  actionText: '动作',
  resultCode: 'UNRESOLVED',
  ...overrides,
});

const makePanel = (overrides: Partial<PanelRow> = {}): PanelRow => ({
  id: 'p1',
  requestId,
  panelType: 'STEP_NEW_FAULT',
  stepId: '1',
  phaseCode: 'PHASE_01',
  mainError: null,
  unitError: null,
  source: null,
  errorType: null,
  gpibStatus: null,
  faultStatus: null,
  description: '新故障',
  action: null,
  ...overrides,
});

/** 内存步骤仓储：update/insert/delete 会真实改变状态，find 返回当前顺序 */
function makeStepRepository(initial: StepRow[]) {
  const rows = initial.map((row) => ({ ...row }));
  const repository = {
    find: jest.fn(() =>
      [...rows].sort(
        (left, right) => left.stepNo - right.stepNo || left.id.localeCompare(right.id),
      ),
    ),
    update: jest.fn((where: { id: string }, values: Partial<StepRow>) => {
      const row = rows.find((item) => item.id === where.id);
      if (!row) return { affected: 0 };
      Object.assign(row, values);
      return { affected: 1 };
    }),
    insert: jest.fn((values: Omit<StepRow, 'id'> & { id?: string }) => {
      rows.push({ ...values, id: values.id ?? `new-${rows.length + 1}` });
      return { identifiers: [] };
    }),
    delete: jest.fn((criteria: { id: ReturnType<typeof In> }) => {
      const ids = (criteria.id as unknown as Record<string, string[]>)['_value'];
      for (const id of ids) {
        const index = rows.findIndex((item) => item.id === id);
        if (index >= 0) rows.splice(index, 1);
      }
      return { affected: ids.length };
    }),
    createQueryBuilder: jest.fn(() => ({
      update: () => ({
        set: () => ({
          where: () => ({
            execute: () => ({ affected: rows.length }),
          }),
        }),
      }),
    })),
  };
  return { repository, rows };
}

function makePanelRepository(initial: PanelRow[]) {
  const rows = initial.map((row) => ({ ...row }));
  const repository = {
    find: jest.fn(() => rows.map((row) => ({ ...row }))),
    update: jest.fn((where: { id: string }, values: Partial<PanelRow>) => {
      const row = rows.find((item) => item.id === where.id);
      if (!row) return { affected: 0 };
      Object.assign(row, values);
      return { affected: 1 };
    }),
    insert: jest.fn((values: Omit<PanelRow, 'id'>) => {
      rows.push({ ...values, id: `new-panel-${rows.length + 1}` });
      return { identifiers: [] };
    }),
    delete: jest.fn((criteria: { id: ReturnType<typeof In> }) => {
      const ids = (criteria.id as unknown as Record<string, string[]>)['_value'];
      for (const id of ids) {
        const index = rows.findIndex((item) => item.id === id);
        if (index >= 0) rows.splice(index, 1);
      }
      return { affected: ids.length };
    }),
  };
  return { repository, rows };
}

function makeRequestRepository(affected = 1) {
  const andWhere = jest.fn();
  const set = jest.fn();
  const queryBuilder = {} as {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  queryBuilder.update = jest.fn(() => queryBuilder);
  queryBuilder.set = jest.fn((values: Record<string, unknown>) => {
    set(values);
    return queryBuilder;
  });
  queryBuilder.where = jest.fn(() => queryBuilder);
  queryBuilder.andWhere = jest.fn((sql: string, params: Record<string, unknown>) => {
    andWhere(sql, params);
    return queryBuilder;
  });
  queryBuilder.execute = jest.fn(() => ({ affected }));
  return {
    repository: { createQueryBuilder: jest.fn(() => queryBuilder) },
    queryBuilder,
    set,
    andWhere,
  };
}

const baseData = {
  requestId,
  expectedVersion: 2,
  attachmentFileId: null,
  maintenanceDate: '2026-09-10',
  engineerName: '张工',
  resetResult: 'NORMAL',
  supplementaryNote: null,
};

describe('RepairRequestMaintenanceService.saveMaintenance', () => {
  it('步骤调序保留主键，面板仍绑定原步骤（按最终顺序号解析真实 ID）', async () => {
    const steps = makeStepRepository([
      makeStep({ id: '1', stepNo: 1, actionText: '动作一' }),
      makeStep({ id: '2', stepNo: 2, actionText: '动作二' }),
    ]);
    const panels = makePanelRepository([makePanel({ id: 'p1', stepId: '2' })]);
    const requests = makeRequestRepository(1);
    const service = new RepairRequestMaintenanceService(
      requests.repository as unknown as Repository<RepairRequestEntity>,
      steps.repository as unknown as Repository<RepairRequestDiagnosticStepEntity>,
      panels.repository as unknown as Repository<RepairRequestFaultPanelEntity>,
    );

    await service.saveMaintenance(
      {
        ...baseData,
        steps: [
          {
            id: '2',
            stepNo: 1,
            errorCode: null,
            partName: null,
            actionText: '动作二',
            resultCode: 'NEW_FAULT',
          },
          {
            id: '1',
            stepNo: 2,
            errorCode: null,
            partName: null,
            actionText: '动作一',
            resultCode: 'RESOLVED',
          },
        ],
        panels: [
          {
            id: 'p1',
            panelType: 'STEP_NEW_FAULT',
            stepNo: 1,
            phaseCode: 'PHASE_03',
            mainError: null,
            unitError: null,
            source: null,
            errorType: null,
            gpibStatus: null,
            faultStatus: null,
            description: '新故障',
            action: null,
          },
        ],
      },
      undefined as never,
    );

    // 已存在的步骤按 id 更新，主键不变
    expect(steps.repository.update).toHaveBeenCalledWith(
      { id: '2', requestId },
      expect.objectContaining({ stepNo: 1 }),
    );
    expect(steps.repository.update).toHaveBeenCalledWith(
      { id: '1', requestId },
      expect.objectContaining({ stepNo: 2 }),
    );
    // 面板提交的是顺序号 1，落库时解析为当前第 1 位的步骤 ID（原步骤 2）
    expect(panels.repository.update).toHaveBeenCalledWith(
      { id: 'p1', requestId },
      expect.objectContaining({ stepId: '2', phaseCode: 'PHASE_03' }),
    );
  });

  it('删除步骤时同步删除其关联面板，避免孤儿与 RESTRICT 冲突', async () => {
    const steps = makeStepRepository([
      makeStep({ id: '1', stepNo: 1 }),
      makeStep({ id: '2', stepNo: 2 }),
    ]);
    const panels = makePanelRepository([makePanel({ id: 'p1', stepId: '2' })]);
    const requests = makeRequestRepository(1);
    const service = new RepairRequestMaintenanceService(
      requests.repository as unknown as Repository<RepairRequestEntity>,
      steps.repository as unknown as Repository<RepairRequestDiagnosticStepEntity>,
      panels.repository as unknown as Repository<RepairRequestFaultPanelEntity>,
    );

    await service.saveMaintenance(
      {
        ...baseData,
        steps: [
          {
            id: '1',
            stepNo: 1,
            errorCode: null,
            partName: null,
            actionText: '动作一',
            resultCode: 'RESOLVED',
          },
        ],
        panels: [],
      },
      undefined as never,
    );

    expect(panels.repository.delete).toHaveBeenCalledWith({
      requestId,
      id: In(['p1']),
    });
    expect(steps.repository.delete).toHaveBeenCalledWith({
      requestId,
      id: In(['2']),
    });
  });

  it('版本条件未命中时抛 PROCESS_VERSION_CONFLICT，不改写其他工单事实', async () => {
    const steps = makeStepRepository([makeStep()]);
    const panels = makePanelRepository([]);
    const requests = makeRequestRepository(0);
    const service = new RepairRequestMaintenanceService(
      requests.repository as unknown as Repository<RepairRequestEntity>,
      steps.repository as unknown as Repository<RepairRequestDiagnosticStepEntity>,
      panels.repository as unknown as Repository<RepairRequestFaultPanelEntity>,
    );

    await expect(
      service.saveMaintenance({ ...baseData, steps: [], panels: [] }, undefined as never),
    ).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT,
    });
    expect(requests.andWhere).toHaveBeenCalledWith('maintenance_version_no = :expectedVersion', {
      expectedVersion: 2,
    });
    expect(requests.set).toHaveBeenCalledWith(
      expect.objectContaining({ maintenanceVersionNo: expect.any(Function) }),
    );
  });

  it('提交不属于当前工单的步骤 ID 时拒绝（防跨工单改写）', async () => {
    const steps = makeStepRepository([makeStep({ id: '1' })]);
    const panels = makePanelRepository([]);
    const requests = makeRequestRepository(1);
    const service = new RepairRequestMaintenanceService(
      requests.repository as unknown as Repository<RepairRequestEntity>,
      steps.repository as unknown as Repository<RepairRequestDiagnosticStepEntity>,
      panels.repository as unknown as Repository<RepairRequestFaultPanelEntity>,
    );

    await expect(
      service.saveMaintenance(
        {
          ...baseData,
          steps: [
            {
              id: 'other',
              stepNo: 1,
              errorCode: null,
              partName: null,
              actionText: '动作',
              resultCode: 'RESOLVED',
            },
          ],
          panels: [],
        },
        undefined as never,
      ),
    ).rejects.toBeInstanceOf(DomainError);
    expect(steps.repository.update).not.toHaveBeenCalled();
    expect(requests.queryBuilder.execute).not.toHaveBeenCalled();
  });
});
