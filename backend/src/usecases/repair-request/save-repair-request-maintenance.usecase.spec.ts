// src/usecases/repair-request/save-repair-request-maintenance.usecase.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import type { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { RepairRequestMaintenanceService } from '@src/modules/lithography/repair-request-maintenance.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { SaveRepairRequestMaintenanceUsecase } from './save-repair-request-maintenance.usecase';

const engineerSession = (accountId = 900001): UsecaseSession =>
  ({
    accountId,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
  }) as unknown as UsecaseSession;

const target = (overrides: Record<string, unknown> = {}) => ({
  id: 102,
  intakeId: 501,
  serviceOrganizationId: 100,
  isAccepted: true,
  acceptedByEngineerAccountId: 900001,
  deprecated: false,
  handlingStatus: null,
  closureStatus: 'OPEN',
  maintenanceAttachmentFileId: null,
  maintenanceVersionNo: 3,
  ...overrides,
});

const command = (overrides: Record<string, unknown> = {}) => ({
  session: engineerSession(),
  requestId: 102,
  expectedVersion: 3,
  maintenanceDate: '2026-11-18',
  engineerName: '张工',
  resetResult: null,
  supplementaryNote: null,
  steps: [{ stepNo: 1, actionText: '清洁镜头', resultCode: 'RESOLVED' }],
  panels: [],
  ...overrides,
});

const makeUsecase = (
  options: {
    target?: ReturnType<typeof target> | null;
    bind?: jest.Mock;
    save?: jest.Mock;
  } = {},
) => {
  const maintenanceService = {
    findTarget: jest.fn().mockResolvedValue(options.target ?? target()),
    findTargetForUpdate: jest.fn().mockResolvedValue(options.target ?? target()),
    attachMaintenanceFile: jest.fn().mockResolvedValue(undefined),
    saveMaintenance: options.save ?? jest.fn().mockResolvedValue(undefined),
  };
  const maintenanceQueryService = {
    findRecord: jest.fn().mockResolvedValue({ versionNo: 4 }),
    listSteps: jest.fn().mockResolvedValue([]),
    listFaultPanels: jest.fn().mockResolvedValue([]),
  };
  const trustedOrganizationContext = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 100 }),
  };
  const bindOriginalUsecase = {
    executeInTransaction: options.bind ?? jest.fn().mockResolvedValue({}),
  };
  const transactionRunner: TransactionRunner = {
    run: async (callback) => callback({} as never),
  };
  return {
    usecase: new SaveRepairRequestMaintenanceUsecase(
      maintenanceService as unknown as RepairRequestMaintenanceService,
      maintenanceQueryService as unknown as RepairRequestMaintenanceQueryService,
      trustedOrganizationContext as unknown as TrustedOrganizationContextQueryService,
      bindOriginalUsecase as unknown as BindRepairProcessOriginalUsecase,
      transactionRunner,
    ),
    maintenanceService,
    maintenanceQueryService,
    bindOriginalUsecase,
  };
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('SaveRepairRequestMaintenanceUsecase', () => {
  it('非接单工程师直写被拒', async () => {
    const { usecase, maintenanceService } = makeUsecase({
      target: target({ acceptedByEngineerAccountId: 900002 }),
    });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.NOT_ACCEPTED);
    expect(maintenanceService.saveMaintenance).not.toHaveBeenCalled();
  });

  it('外公司工程师被拒（按可信服务公司，不回退其他公司事实）', async () => {
    const { usecase } = makeUsecase({ target: target({ serviceOrganizationId: 999 }) });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('缺少原稿关联的旧工单被拒（可信服务公司为空）', async () => {
    // 服务层在缺少原稿关联时把可信服务公司解析为 null（这里直接模拟该事实）
    const { usecase } = makeUsecase({
      target: target({ intakeId: null, serviceOrganizationId: null }),
    });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.NOT_FOUND);
  });

  it('旧版本写入被拒', async () => {
    const { usecase, maintenanceService } = makeUsecase({
      target: target({ maintenanceVersionNo: 4 }),
    });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.PROCESS_VERSION_CONFLICT);
    expect(maintenanceService.saveMaintenance).not.toHaveBeenCalled();
  });

  it('结单后只读', async () => {
    const { usecase } = makeUsecase({ target: target({ closureStatus: 'CLOSED' }) });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT);
  });

  it('中断记录后仍处理中（IN_PROGRESS）可继续保存', async () => {
    const { usecase, maintenanceService } = makeUsecase({
      target: target({ handlingStatus: 'IN_PROGRESS', closureStatus: null }),
    });
    await usecase.execute(command());
    expect(maintenanceService.saveMaintenance).toHaveBeenCalledTimes(1);
  });

  it('处理已终结（UNRESOLVED）后只读', async () => {
    const { usecase } = makeUsecase({ target: target({ handlingStatus: 'UNRESOLVED' }) });
    await expectCode(usecase.execute(command()), REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT);
  });

  it('保存成功：按 expectedVersion 原子写入并返回最新记录', async () => {
    const { usecase, maintenanceService, maintenanceQueryService } = makeUsecase();
    const result = await usecase.execute(command());
    expect(maintenanceService.saveMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 102, expectedVersion: 3 }),
      expect.anything(),
    );
    expect(maintenanceQueryService.findRecord).toHaveBeenCalledWith(102);
    expect(result.record).toEqual({ versionNo: 4 });
  });

  it('提供原件时先在事务内绑定，再保存维修记录', async () => {
    const { usecase, bindOriginalUsecase, maintenanceService } = makeUsecase();
    await usecase.execute(
      command({
        attachment: { fileId: '11111111-1111-4111-8111-111111111111', uploadContextId: 'ctx' },
      }),
    );
    expect(bindOriginalUsecase.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(maintenanceService.attachMaintenanceFile).toHaveBeenCalledWith(
      102,
      '11111111-1111-4111-8111-111111111111',
      3,
      expect.anything(),
    );
  });

  it('已绑定过维修原件时拒绝替换，且不消费新原件', async () => {
    const { usecase, bindOriginalUsecase } = makeUsecase({
      target: target({ maintenanceAttachmentFileId: 'existing-file' }),
    });
    await expectCode(
      usecase.execute(
        command({
          attachment: { fileId: 'new-file', uploadContextId: 'ctx' },
        }),
      ),
      REPAIR_REQUEST_ERROR.PROCESS_ORIGINAL_IMMUTABLE,
    );
    expect(bindOriginalUsecase.executeInTransaction).not.toHaveBeenCalled();
  });

  it('非工程师身份直接拒绝', async () => {
    const { usecase } = makeUsecase();
    await expect(
      usecase.execute(
        command({
          session: { accountId: 1, roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
        }),
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
