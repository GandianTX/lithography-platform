// src/usecases/repair-request/enrich-repair-request-nicknames.spec.ts

/// <reference types="jest" />
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { RepairRequestDetailQueryResult } from '@src/modules/lithography/lithography.types';
import { RepairRequestHandlingStatus } from '@app-types/models/repair-request.types';

import { enrichEngineerRepairRequestDetail } from './enrich-repair-request-nicknames';

const ACCEPTED_ENGINEER_ACCOUNT_ID = 900001;
const VIEWER_ACCOUNT_ID = ACCEPTED_ENGINEER_ACCOUNT_ID;

function buildDetail(
  overrides: Partial<RepairRequestDetailQueryResult> = {},
): RepairRequestDetailQueryResult {
  return {
    id: 102,
    requestNo: 'RR-20261118-001',
    equipmentModel: { id: 1, modelCode: 'LITHO-100', modelName: '样例光刻机' },
    errorCode: 'E-0001',
    faultDescription: '对准模块异常',
    contentMd: '',
    createdAt: new Date('2026-11-18T01:00:00.000Z'),
    isAccepted: true,
    acceptedAt: new Date('2026-11-18T02:00:00.000Z'),
    latestResolutionStatus: null,
    responses: [],
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    handlingResult: null,
    handlingStatus: RepairRequestHandlingStatus.IN_PROGRESS,
    processEntries: [],
    maintenance: {
      maintenanceDate: null,
      engineerName: null,
      resetResult: null,
      supplementaryNote: null,
      versionNo: 0,
      attachment: null,
    },
    maintenanceSteps: [],
    maintenanceFaultPanels: [],
    intake: null,
    canEditMaintenance: true,
    customerAccountId: 800001,
    acceptedByEngineerAccountId: ACCEPTED_ENGINEER_ACCOUNT_ID,
    ...overrides,
  };
}

function makeAccountQueryService(realName: string | null) {
  return {
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
    findAccountDisplayProfilesByAccountIds: jest.fn().mockResolvedValue(new Map()),
    findRealNameByAccountId: jest.fn().mockResolvedValue(realName),
  };
}

describe('enrichEngineerRepairRequestDetail（v0 可信姓名）', () => {
  it('v0 无姓名快照：用接单人可信资料回填只读姓名', async () => {
    const accountQueryService = makeAccountQueryService('李工');

    const view = await enrichEngineerRepairRequestDetail(
      accountQueryService as unknown as AccountQueryService,
      buildDetail(),
      VIEWER_ACCOUNT_ID,
    );

    expect(accountQueryService.findRealNameByAccountId).toHaveBeenCalledWith({
      accountId: ACCEPTED_ENGINEER_ACCOUNT_ID,
    });
    expect(view.maintenance).toMatchObject({ versionNo: 0, engineerName: '李工' });
  });

  it('已有姓名快照：保持快照，不再读取接单人资料覆盖历史事实', async () => {
    const accountQueryService = makeAccountQueryService('新资料姓名');

    const view = await enrichEngineerRepairRequestDetail(
      accountQueryService as unknown as AccountQueryService,
      buildDetail({
        maintenance: {
          maintenanceDate: '2026-11-18',
          engineerName: '快照姓名',
          resetResult: null,
          supplementaryNote: null,
          versionNo: 1,
          attachment: null,
        },
      }),
      VIEWER_ACCOUNT_ID,
    );

    expect(accountQueryService.findRealNameByAccountId).not.toHaveBeenCalled();
    expect(view.maintenance?.engineerName).toBe('快照姓名');
  });

  it('接单人资料缺失：不伪造姓名，保持为空', async () => {
    const accountQueryService = makeAccountQueryService(null);

    const view = await enrichEngineerRepairRequestDetail(
      accountQueryService as unknown as AccountQueryService,
      buildDetail(),
      VIEWER_ACCOUNT_ID,
    );

    expect(view.maintenance?.engineerName).toBeNull();
  });

  it('非工程师入口不返回维修记录：不读取姓名，也不向无权视角暴露', async () => {
    const accountQueryService = makeAccountQueryService('李工');

    const view = await enrichEngineerRepairRequestDetail(
      accountQueryService as unknown as AccountQueryService,
      buildDetail({ maintenance: null }),
      999999,
    );

    expect(accountQueryService.findRealNameByAccountId).not.toHaveBeenCalled();
    expect(view.maintenance).toBeNull();
  });
});
