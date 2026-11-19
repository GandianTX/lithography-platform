// src/core/repair-request/policy/repair-request-maintenance.policy.spec.ts

/// <reference types="jest" />
import { DomainError } from '@core/common/errors/domain-error';
import {
  isMaintenanceRecordEmpty,
  normalizeMaintenanceRecord,
  type MaintenanceRecordRawInput,
} from './repair-request-maintenance.policy';

const baseInput = (): MaintenanceRecordRawInput => ({
  maintenanceDate: '2026-11-18',
  engineerName: '张工',
  resetResult: null,
  supplementaryNote: null,
  steps: [
    {
      id: '11',
      stepNo: 1,
      errorCode: 'E01',
      partName: '激光头',
      actionText: '清洁镜头',
      resultCode: 'RESOLVED',
    },
  ],
  panels: [],
});

describe('repair-request-maintenance.policy', () => {
  it('归一合法记录：日期、步骤与空面板', () => {
    const result = normalizeMaintenanceRecord(baseInput());
    expect(result.maintenanceDate).toBe('2026-11-18');
    expect(result.engineerName).toBe('张工');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ id: '11', stepNo: 1, resultCode: 'RESOLVED' });
    expect(result.panels).toEqual([]);
    expect(isMaintenanceRecordEmpty(result)).toBe(false);
  });

  it('空记录判定为 empty', () => {
    expect(
      isMaintenanceRecordEmpty({
        maintenanceDate: null,
        engineerName: null,
        resetResult: null,
        supplementaryNote: null,
        steps: [],
        panels: [],
      }),
    ).toBe(true);
  });

  it('拒绝重复步骤顺序号', () => {
    const input = baseInput();
    input.steps = [
      { stepNo: 1, actionText: 'A', resultCode: 'RESOLVED' },
      { stepNo: 1, actionText: 'B', resultCode: 'UNRESOLVED' },
    ];
    expect(() => normalizeMaintenanceRecord(input)).toThrow(DomainError);
  });

  it('拒绝空动作与非法结果', () => {
    const emptyAction = baseInput();
    emptyAction.steps = [{ stepNo: 1, actionText: '   ', resultCode: 'RESOLVED' }];
    expect(() => normalizeMaintenanceRecord(emptyAction)).toThrow(DomainError);

    const badResult = baseInput();
    badResult.steps = [{ stepNo: 1, actionText: 'A', resultCode: 'DONE' }];
    expect(() => normalizeMaintenanceRecord(badResult)).toThrow(DomainError);
  });

  it('复位新故障面板必须对应复位结果 NEW_FAULT', () => {
    const input = baseInput();
    input.resetResult = 'NORMAL';
    input.panels = [
      {
        panelType: 'RESET_NEW_FAULT',
        description: '复位后新报警',
        phaseCode: 'PHASE_03',
      },
    ];
    expect(() => normalizeMaintenanceRecord(input)).toThrow(DomainError);

    input.resetResult = 'NEW_FAULT';
    const result = normalizeMaintenanceRecord(input);
    expect(result.panels[0]).toMatchObject({ panelType: 'RESET_NEW_FAULT', stepNo: null });
  });

  it('步骤新故障面板只能关联结果为 NEW_FAULT 的步骤', () => {
    const input = baseInput();
    input.panels = [{ panelType: 'STEP_NEW_FAULT', stepNo: 1, description: '新故障' }];
    expect(() => normalizeMaintenanceRecord(input)).toThrow(DomainError);

    input.steps = [{ stepNo: 1, actionText: '更换板卡', resultCode: 'NEW_FAULT' }];
    const result = normalizeMaintenanceRecord(input);
    expect(result.panels[0].stepNo).toBe(1);
  });

  it('拒绝非步骤新故障面板携带步骤引用', () => {
    const input = baseInput();
    input.panels = [{ panelType: 'INITIAL', stepNo: 1, description: '初始故障' }];
    expect(() => normalizeMaintenanceRecord(input)).toThrow(DomainError);
  });

  it('非法日期与阶段编码被拒绝', () => {
    const badDate = baseInput();
    badDate.maintenanceDate = '2026-02-30';
    expect(() => normalizeMaintenanceRecord(badDate)).toThrow(DomainError);

    const badPhase = baseInput();
    badPhase.panels = [{ panelType: 'INITIAL', phaseCode: 'PHASE_99', description: '初始故障' }];
    expect(() => normalizeMaintenanceRecord(badPhase)).toThrow(DomainError);
  });
});
