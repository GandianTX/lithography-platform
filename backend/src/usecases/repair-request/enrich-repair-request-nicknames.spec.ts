/// <reference types="jest" />
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { RepairRequestDetailQueryResult } from '@src/modules/lithography/lithography.types';
import { enrichRepairRequestDetailNicknames } from './enrich-repair-request-nicknames';

const accountQueryService = {
  findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
} as unknown as AccountQueryService;

const internalResult = (): RepairRequestDetailQueryResult =>
  ({
    id: 401,
    requestNo: 'RR-401',
    equipmentModel: { id: 1, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
    errorCode: 'E-401',
    faultDescription: '无法曝光',
    contentMd: '# 申请正文',
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    isAccepted: true,
    acceptedAt: new Date('2026-09-04T01:00:00.000Z'),
    latestResolutionStatus: null,
    customerAccountId: 900001,
    acceptedByEngineerAccountId: 42,
    responses: [],
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: null,
    processEntries: [
      {
        id: 11,
        content: '内部维修记录',
        file: null,
        recordedAt: new Date('2026-09-04T02:00:00.000Z'),
      },
    ],
    maintenance: {
      maintenanceDate: '2026-09-04',
      engineerName: '张工',
      resetResult: 'NORMAL',
      supplementaryNote: '内部补充',
      versionNo: 2,
      attachment: {
        fileId: 'file-1',
        originalFilename: 'internal.pdf',
        mimeType: 'application/pdf',
        byteSize: 100,
        checksumSha256: 'x',
      },
    },
    maintenanceSteps: [
      {
        id: 'step-1',
        stepNo: 1,
        errorCode: 'E-1',
        partName: '镜头',
        actionText: '清洁',
        resultCode: 'RESOLVED',
      },
    ],
    maintenanceFaultPanels: [],
    intake: {
      intakeId: 7,
      faultDescription: '客户原始报修',
      customerFile: null,
      analysis: {
        status: 'SUCCEEDED',
        generation: 1,
        outputText: 'AI 原文',
        failureReason: null,
        finishedAt: new Date('2026-09-04T00:30:00.000Z'),
      },
    },
    canEditMaintenance: false,
  }) as unknown as RepairRequestDetailQueryResult;

describe('enrichRepairRequestDetailNicknames 客户视图隔离', () => {
  it('客户视图不暴露内部维修记录、维修原件、AI 原文与归属账号 ID', async () => {
    const view = await enrichRepairRequestDetailNicknames(accountQueryService, internalResult());

    expect(view.processEntries).toEqual([]);
    expect(view.maintenance).toBeNull();
    expect(view.maintenanceSteps).toEqual([]);
    expect(view.maintenanceFaultPanels).toEqual([]);
    expect(view.intake).toBeNull();
    expect(view.canEditMaintenance).toBe(false);
    expect(view).not.toHaveProperty('customerAccountId');
    expect(view).not.toHaveProperty('acceptedByEngineerAccountId');
  });
});
