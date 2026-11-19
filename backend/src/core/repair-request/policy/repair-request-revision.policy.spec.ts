// src/core/repair-request/policy/repair-request-revision.policy.spec.ts

/// <reference types="jest" />
import {
  REPAIR_REQUEST_REVISION_SCHEMA_VERSION,
  buildRepairRequestRevisionSnapshot,
  parseRepairRequestRevisionSnapshot,
} from './repair-request-revision.policy';

const request = {
  requestId: 102,
  requestNo: 'WX-102',
  customerAccountId: 1,
  intakeId: 501,
  equipmentModelId: 2,
  isAccepted: true,
  ownerOrganizationId: 100,
  serviceOrganizationId: 100,
  errorCode: 'E01',
  faultDescription: '原报修',
  contentMd: '正文',
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  acceptedByEngineerAccountId: 900001,
  acceptedAt: new Date('2026-11-02T00:00:00.000Z'),
  handlingResult: 'REPAIRED' as const,
  handlingStatus: 'COMPLETED' as const,
  handlingRecordedAt: null,
  handlingRecordedByAccountId: null,
  handlingEndedAt: null,
  closureStatus: 'CLOSED',
  closedAt: null,
  closureReason: null,
  currentRevisionNo: 1,
  maintenanceDate: '2026-11-18',
  maintenanceEngineerName: '张工',
  resetResult: 'NORMAL',
  supplementaryNote: '备注',
  maintenanceVersionNo: 2,
  maintenanceAttachmentFileId: 'file-1',
};

describe('repair-request-revision.policy', () => {
  it('v2 快照包含结构化维修记录、步骤与面板', () => {
    const snapshot = buildRepairRequestRevisionSnapshot({
      request,
      processEntries: [],
      responses: [],
      maintenanceSteps: [
        {
          id: '31',
          stepNo: 1,
          errorCode: 'E01',
          partName: '激光头',
          actionText: '清洁镜头',
          resultCode: 'RESOLVED',
        },
      ],
      maintenanceFaultPanels: [
        {
          id: '41',
          panelType: 'INITIAL',
          stepId: null,
          phaseCode: 'PHASE_01',
          mainError: 'M1',
          unitError: null,
          source: null,
          errorType: null,
          gpibStatus: null,
          faultStatus: null,
          description: '初始故障',
          action: null,
        },
      ],
    });

    expect(snapshot.schema_version).toBe(REPAIR_REQUEST_REVISION_SCHEMA_VERSION);
    expect(snapshot.diagnostic_steps).toHaveLength(1);
    expect(snapshot.fault_panels).toHaveLength(1);
    expect((snapshot.request as Record<string, unknown>).maintenance_version_no).toBe(2);
  });

  it('v2 快照可回读，且维修区块可比', () => {
    const snapshot = buildRepairRequestRevisionSnapshot({
      request,
      processEntries: [],
      responses: [],
      maintenanceSteps: [],
      maintenanceFaultPanels: [],
    });
    const parsed = parseRepairRequestRevisionSnapshot(JSON.stringify(snapshot));
    expect(parsed).not.toBeNull();
    expect(parsed?.hasMaintenanceData).toBe(true);
    expect(parsed?.maintenance.maintenanceDate).toBe('2026-11-18');
    expect(parsed?.maintenance.versionNo).toBe(2);
  });

  it('v1 旧快照可读但无维修区块（对比时须提示不可比）', () => {
    const legacy = {
      schema_version: 1,
      request: {
        request_id: 102,
        request_no: 'WX-102',
        content_md: '旧正文',
        handling_result: null,
        handling_status: null,
        closure_reason: null,
      },
      process_entries: [],
      responses: [],
    };
    const parsed = parseRepairRequestRevisionSnapshot(JSON.stringify(legacy));
    expect(parsed).not.toBeNull();
    expect(parsed?.hasMaintenanceData).toBe(false);
    expect(parsed?.steps).toEqual([]);
    expect(parsed?.panels).toEqual([]);
    expect(parsed?.maintenance.maintenanceDate).toBeNull();
  });

  it('损坏快照返回 null，不用当前工单补齐', () => {
    expect(parseRepairRequestRevisionSnapshot('not-json')).toBeNull();
    expect(parseRepairRequestRevisionSnapshot(JSON.stringify({ schema_version: 2 }))).toBeNull();
  });
});
