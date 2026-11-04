/// <reference types="jest" />
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  DomainError,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@src/core/common/errors/domain-error';
import type {
  EquipmentModelDetailSnapshot,
  RepairRequestSnapshot,
} from '@src/modules/lithography/lithography.types';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { CreateRepairRequestUsecase } from './create-repair-request.usecase';
import type { CreateRepairRequestCommand } from './create-repair-request.types';

type RepairRequestServiceMock = {
  readonly insertRequest: jest.Mock<Promise<RepairRequestSnapshot>>;
  readonly requestNoExists: jest.Mock<Promise<boolean>>;
};

type OrganizationContextMock = {
  readonly tryResolveForAccount: jest.Mock;
};

type EquipmentModelQueryServiceMock = {
  readonly listEnabledModels: jest.Mock;
  readonly findModelById: jest.Mock<Promise<EquipmentModelDetailSnapshot | null>>;
};

describe('CreateRepairRequestUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const createdAt = new Date('2026-08-26T10:00:00.000Z');
  const enabledModel: EquipmentModelDetailSnapshot = {
    id: 3,
    modelCode: 'LITHO-9000',
    modelName: '光刻机 9000',
    enabled: true,
  };

  let repairRequestService: RepairRequestServiceMock;
  let equipmentModelQueryService: EquipmentModelQueryServiceMock;
  let organizationContextQueryService: OrganizationContextMock;
  let transactionRunner: TransactionRunner;
  let usecase: CreateRepairRequestUsecase;

  const buildCommand = (
    overrides: Partial<CreateRepairRequestCommand> = {},
  ): CreateRepairRequestCommand => ({
    session: { accountId: 7, accessGroup: ['CUSTOMER'] },
    equipmentModelId: 3,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    ...overrides,
  });

  const buildSnapshot = (requestNo: string): RepairRequestSnapshot => ({
    id: 11,
    requestNo,
    customerAccountId: 7,
    equipmentModelId: 3,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    createdAt,
    isAccepted: false,
  });

  beforeEach(() => {
    repairRequestService = {
      insertRequest: jest.fn((data) => Promise.resolve(buildSnapshot(data.requestNo))),
      requestNoExists: jest.fn().mockResolvedValue(false),
    };
    equipmentModelQueryService = {
      listEnabledModels: jest.fn(),
      findModelById: jest.fn().mockResolvedValue(enabledModel),
    };
    // 默认：客户账号无组织归属（自注册存量路径）→ 工单不归属组织
    organizationContextQueryService = {
      tryResolveForAccount: jest.fn().mockResolvedValue(null),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new CreateRepairRequestUsecase(
      repairRequestService as unknown as RepairRequestService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      organizationContextQueryService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );
  });

  describe('成功路径', () => {
    it('CUSTOMER 提交后返回申请快照且事务内按序执行', async () => {
      const result = await usecase.execute(buildCommand());

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(equipmentModelQueryService.findModelById).toHaveBeenCalledWith({
        id: 3,
        transactionContext,
      });
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(1);
      expect(result.customerAccountId).toBe(7);
      expect(result.equipmentModelId).toBe(3);
      expect(result.isAccepted).toBe(false);
    });

    it('生成的申请编号符合 RR 前缀格式且长度受限', async () => {
      const result = await usecase.execute(buildCommand());

      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(result.requestNo.length).toBeLessThanOrEqual(50);
    });

    it('contentMd 由后端结构化生成，包含型号、错误码与故障描述', async () => {
      await usecase.execute(buildCommand());

      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.contentMd).toContain('LITHO-9000');
      expect(insertData.contentMd).toContain('光刻机 9000');
      expect(insertData.contentMd).toContain('E-100');
      expect(insertData.contentMd).toContain('设备无法启动');
    });

    it('空白输入在规范化阶段被 trim', async () => {
      await usecase.execute(
        buildCommand({ errorCode: '  E-100  ', faultDescription: '  设备无法启动  ' }),
      );

      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.errorCode).toBe('E-100');
      expect(insertData.faultDescription).toBe('设备无法启动');
    });

    it('客户归属组织只来自可信解析：写入 ownerOrganizationId，客户端自报被忽略', async () => {
      organizationContextQueryService.tryResolveForAccount.mockResolvedValue({
        membershipId: 1,
        organizationId: 77,
        organizationCode: 'CLIENT_DEFAULT',
        organizationName: '甲方默认组织',
        organizationKind: 'CLIENT',
        memberRole: 'CUSTOMER',
      });
      const smuggled = {
        ...buildCommand(),
        ownerOrganizationId: 999,
      } as unknown as CreateRepairRequestCommand;

      await usecase.execute(smuggled);

      expect(organizationContextQueryService.tryResolveForAccount).toHaveBeenCalledWith({
        accountId: 7,
        transactionContext,
      });
      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.ownerOrganizationId).toBe(77);
    });

    it('客户无有效组织归属：ownerOrganizationId 写 null，仍可创建（自注册存量兼容）', async () => {
      await usecase.execute(buildCommand());

      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.ownerOrganizationId).toBeNull();
    });
  });

  describe('角色决策', () => {
    it.each([[['ENGINEER']], [['SUPER_ADMIN']], [['ENGINEER', 'SUPER_ADMIN']], [[]]])(
      'accessGroup=%j 时拒绝提交',
      async (accessGroup) => {
        await expect(
          usecase.execute(buildCommand({ session: { accountId: 7, accessGroup } })),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
        expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
      },
    );
  });

  describe('输入决策', () => {
    it('设备型号 ID 非正整数时拒绝', async () => {
      await expect(usecase.execute(buildCommand({ equipmentModelId: 0 }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
      await expect(usecase.execute(buildCommand({ equipmentModelId: 1.5 }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
    });

    it('错误码为空白时拒绝', async () => {
      await expect(usecase.execute(buildCommand({ errorCode: '   ' }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
    });

    it('错误码超过 100 字符时拒绝', async () => {
      const longErrorCode = 'E'.repeat(101);
      await expect(
        usecase.execute(buildCommand({ errorCode: longErrorCode })),
      ).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
    });

    it('错误码恰好 100 字符时允许创建（边界值）', async () => {
      const result = await usecase.execute(buildCommand({ errorCode: 'E'.repeat(100) }));
      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(1);
    });

    it('故障描述超过 5000 字符时拒绝（直调 Usecase，绕过 DTO）', async () => {
      await expect(
        usecase.execute(buildCommand({ faultDescription: '长'.repeat(5001) })),
      ).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it('故障描述恰好 5000 字符时允许创建（边界值）', async () => {
      const result = await usecase.execute(buildCommand({ faultDescription: '长'.repeat(5000) }));
      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(1);
    });

    it('故障描述为空白时拒绝', async () => {
      await expect(
        usecase.execute(buildCommand({ faultDescription: '\n  ' })),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY });
    });
  });

  describe('设备型号校验', () => {
    it('型号不存在时拒绝且不落库', async () => {
      equipmentModelQueryService.findModelById.mockResolvedValue(null);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      });
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it('型号已停用时拒绝且不落库', async () => {
      equipmentModelQueryService.findModelById.mockResolvedValue({
        ...enabledModel,
        enabled: false,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED,
      });
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });
  });

  describe('申请编号生成', () => {
    it('撞号时重新生成直至唯一', async () => {
      repairRequestService.requestNoExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await usecase.execute(buildCommand());

      expect(repairRequestService.requestNoExists).toHaveBeenCalledTimes(2);
      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
    });

    it('重试上限内仍撞号时判定创建失败', async () => {
      repairRequestService.requestNoExists.mockResolvedValue(true);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.requestNoExists).toHaveBeenCalledTimes(3);
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it('预检查数据库异常不重试直接上抛', async () => {
      const dbError = new Error('connection lost');
      repairRequestService.requestNoExists.mockRejectedValue(dbError);

      await expect(usecase.execute(buildCommand())).rejects.toBe(dbError);
      expect(repairRequestService.requestNoExists).toHaveBeenCalledTimes(1);
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });
  });

  describe('落库撞号重试（唯一索引并发冲突）', () => {
    it('插入撞唯一索引时换新编号重试整段流程', async () => {
      repairRequestService.insertRequest
        .mockRejectedValueOnce(
          new DomainError(REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT, '维修申请编号冲突'),
        )
        .mockImplementationOnce((data) => Promise.resolve(buildSnapshot(data.requestNo)));

      const result = await usecase.execute(buildCommand());

      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(2);
      expect(result.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
    });

    it('重试上限内落库持续撞号时判定创建失败', async () => {
      repairRequestService.insertRequest.mockRejectedValue(
        new DomainError(REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT, '维修申请编号冲突'),
      );

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(3);
    });

    it('非撞号的落库失败不重试直接上抛', async () => {
      repairRequestService.insertRequest.mockRejectedValue(
        new DomainError(REPAIR_REQUEST_ERROR.CREATION_FAILED, '维修申请落库失败'),
      );

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(1);
    });
  });
});
