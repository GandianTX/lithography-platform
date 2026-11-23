/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { IntakeAnalysisStatus } from '@app-types/models/repair-request.types';
import {
  DomainError,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@src/core/common/errors/domain-error';
import type {
  EquipmentModelDetailSnapshot,
  RepairRequestIntakeSnapshot,
  RepairRequestReplayIntakeState,
  RepairRequestReplayRequestState,
  RepairRequestSnapshot,
} from '@src/modules/lithography/lithography.types';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { EquipmentModelService } from '@src/modules/lithography/equipment-model.service';
import type { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type { RepairRequestIntakeService } from '@src/modules/lithography/repair-request-intake.service';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { DeliverIntakeAnalysisUsecase } from './deliver-intake-analysis.usecase';
import type { BindRepairRequestOriginalUsecase } from './bind-repair-request-original.usecase';
import { CreateRepairRequestUsecase } from './create-repair-request.usecase';
import type { CreateRepairRequestCommand } from './create-repair-request.types';

const RECORD_UUID = '6f0d1c62-2c66-4b1e-9f1e-2f1f0d1c6a11';
const FILE_ID = '9b1f4f9e-9a1e-4b6e-8a10-3f1a2b3c4d5e';
const UPLOAD_CONTEXT_ID = '0c9f6c2e-1f1a-4b0d-9a2f-d0e1c2b3a4f5';

type RepairRequestServiceMock = {
  readonly insertRequest: jest.Mock<Promise<RepairRequestSnapshot>>;
  readonly requestNoExists: jest.Mock<Promise<boolean>>;
  readonly findSnapshotById: jest.Mock<Promise<RepairRequestSnapshot | null>>;
  readonly findReplayRequestStateForUpdate: jest.Mock<
    Promise<RepairRequestReplayRequestState | null>
  >;
};

type RepairRequestIntakeServiceMock = {
  readonly findByRecordUuid: jest.Mock<Promise<RepairRequestIntakeSnapshot | null>>;
  readonly insertIntake: jest.Mock<Promise<RepairRequestIntakeSnapshot>>;
  readonly markConverted: jest.Mock<Promise<void>>;
  readonly findReplayIntakeStateForUpdate: jest.Mock<
    Promise<RepairRequestReplayIntakeState | null>
  >;
};

type AccountQueryServiceMock = {
  readonly findCustomerOrganizationId: jest.Mock;
};

type OrganizationQueryServiceMock = {
  readonly findActiveOrganizationForWrite: jest.Mock;
  readonly findActiveServiceProviderForWrite: jest.Mock;
};

type EquipmentModelQueryServiceMock = {
  readonly findModelById: jest.Mock<Promise<EquipmentModelDetailSnapshot | null>>;
  readonly findModelByCode: jest.Mock<Promise<EquipmentModelDetailSnapshot | null>>;
};

type EquipmentModelServiceMock = {
  readonly findForWriteByModelCode: jest.Mock<Promise<EquipmentModelDetailSnapshot | null>>;
  readonly insertModel: jest.Mock<Promise<EquipmentModelDetailSnapshot>>;
};

type BindOriginalMock = {
  readonly executeInTransaction: jest.Mock<Promise<unknown>>;
};

type AsyncTaskRecordServiceMock = {
  readonly recordEnqueued: jest.Mock<Promise<unknown>>;
};

type DeliverIntakeAnalysisMock = {
  readonly execute: jest.Mock<Promise<{ delivered: boolean; jobId: string; traceId: string }>>;
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
  const customerSession: UsecaseSession = {
    accountId: 7,
    roles: ['CUSTOMER'],
    activeRole: undefined,
  };

  let repairRequestService: RepairRequestServiceMock;
  let intakeService: RepairRequestIntakeServiceMock;
  let equipmentModelQueryService: EquipmentModelQueryServiceMock;
  let equipmentModelService: EquipmentModelServiceMock;
  let accountQueryService: AccountQueryServiceMock;
  let organizationQueryService: OrganizationQueryServiceMock;
  let bindOriginal: BindOriginalMock;
  let asyncTaskRecordService: AsyncTaskRecordServiceMock;
  let deliverIntakeAnalysis: DeliverIntakeAnalysisMock;
  let transactionRunner: TransactionRunner;
  let usecase: CreateRepairRequestUsecase;

  const buildCommand = (
    overrides: Partial<CreateRepairRequestCommand> = {},
  ): CreateRepairRequestCommand => ({
    session: customerSession,
    recordUuid: RECORD_UUID,
    serviceOrganizationId: 88,
    equipmentModelId: 3,
    equipmentModelText: null,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    attachment: null,
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
    deprecated: false,
    intakeId: 21,
    customerOrganizationId: 77,
    serviceOrganizationId: 88,
  });

  const buildIntake = (
    overrides: Partial<RepairRequestIntakeSnapshot> = {},
  ): RepairRequestIntakeSnapshot => ({
    id: 21,
    recordUuid: RECORD_UUID,
    customerAccountId: 7,
    customerOrganizationId: 77,
    serviceOrganizationId: 88,
    equipmentModelId: 3,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    fileId: null,
    analysisStatus: IntakeAnalysisStatus.WAITING,
    analysisGeneration: 0,
    convertedRequestId: 11,
    createdAt,
    ...overrides,
  });

  beforeEach(() => {
    repairRequestService = {
      insertRequest: jest.fn((data) => Promise.resolve(buildSnapshot(data.requestNo))),
      requestNoExists: jest.fn().mockResolvedValue(false),
      findSnapshotById: jest.fn().mockResolvedValue(buildSnapshot('RR20260826100000ABCDEF')),
      // 默认：重放核验读到有效工单（本人、双向关联成立、未删除）
      findReplayRequestStateForUpdate: jest.fn().mockResolvedValue({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: false,
      }),
    };
    intakeService = {
      findByRecordUuid: jest.fn().mockResolvedValue(null),
      insertIntake: jest.fn((data) => Promise.resolve(buildIntake(data))),
      markConverted: jest.fn().mockResolvedValue(undefined),
      // 默认：重放核验读到有效原稿（本人、转换列一致、未删除）
      findReplayIntakeStateForUpdate: jest.fn().mockResolvedValue({
        id: 21,
        customerAccountId: 7,
        convertedRequestId: 11,
        deleted: false,
      }),
    };
    equipmentModelQueryService = {
      findModelById: jest.fn().mockResolvedValue(enabledModel),
      findModelByCode: jest.fn().mockResolvedValue(null),
    };
    equipmentModelService = {
      findForWriteByModelCode: jest.fn().mockResolvedValue(null),
      insertModel: jest.fn().mockResolvedValue({
        id: 41,
        modelCode: 'NSR-S622D',
        modelName: 'NSR-S622D',
        enabled: true,
      }),
    };
    // 默认：客户已有可信公司归属（77）且组织启用；所选厂家（88）具备维修服务资格
    accountQueryService = {
      findCustomerOrganizationId: jest.fn().mockResolvedValue(77),
    };
    organizationQueryService = {
      findActiveOrganizationForWrite: jest.fn().mockResolvedValue({ id: 77, name: '甲方默认组织' }),
      findActiveServiceProviderForWrite: jest
        .fn()
        .mockResolvedValue({ id: 88, name: '乙方维修公司', shortName: '乙方' }),
    };
    bindOriginal = {
      executeInTransaction: jest.fn().mockResolvedValue({ fileId: FILE_ID }),
    };
    asyncTaskRecordService = {
      recordEnqueued: jest.fn().mockResolvedValue({ id: 1, jobId: 'job' }),
    };
    deliverIntakeAnalysis = {
      execute: jest
        .fn()
        .mockResolvedValue({ delivered: true, jobId: 'intake-analysis:21:g0', traceId: 'trace' }),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new CreateRepairRequestUsecase(
      repairRequestService as unknown as RepairRequestService,
      intakeService as unknown as RepairRequestIntakeService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      equipmentModelService as unknown as EquipmentModelService,
      accountQueryService as unknown as AccountQueryService,
      organizationQueryService as unknown as OrganizationQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      bindOriginal as unknown as BindRepairRequestOriginalUsecase,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      deliverIntakeAnalysis as unknown as DeliverIntakeAnalysisUsecase,
      transactionRunner,
    );
  });

  describe('成功路径（提交即出单）', () => {
    it('CUSTOMER 提交后返回唯一工单与首析执行意图', async () => {
      const result = await usecase.execute(buildCommand());

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(result.request.customerAccountId).toBe(7);
      expect(result.request.equipmentModelId).toBe(3);
      expect(result.request.intakeId).toBe(21);
      expect(result.request.customerOrganizationId).toBe(77);
      expect(result.request.serviceOrganizationId).toBe(88);
      expect(result.request.isAccepted).toBe(false);
      expect(result.intake).toEqual({
        intakeId: 21,
        analysisStatus: IntakeAnalysisStatus.WAITING,
        analysisGeneration: 0,
      });
      expect(result.replayed).toBe(false);
    });

    it('提交事务内登记首析投递账本行，事务提交后完成入队', async () => {
      const result = await usecase.execute(buildCommand());

      expect(asyncTaskRecordService.recordEnqueued).toHaveBeenCalledTimes(1);
      const ledgerInput = asyncTaskRecordService.recordEnqueued.mock.calls[0][0];
      expect(ledgerInput.data).toMatchObject({
        queueName: 'intake-analysis',
        jobName: 'analyze',
        jobId: 'intake-analysis:21:g0',
        bizType: 'intake_analysis',
        source: 'user_action',
        reason: 'enqueue_accepted',
        maxAttempts: 3,
      });
      expect(ledgerInput.transactionContext).toBe(transactionContext);
      expect(deliverIntakeAnalysis.execute).toHaveBeenCalledTimes(1);
      expect(deliverIntakeAnalysis.execute).toHaveBeenCalledWith({
        intakeId: 21,
        generationNo: 0,
        traceId: expect.any(String),
      });
      expect(result.analysisDelivery).toEqual({
        traceId: 'trace',
        delivered: true,
      });
    });

    it('入队失败不影响提交成功（delivered=false 交由 housekeeping 补投）', async () => {
      deliverIntakeAnalysis.execute.mockResolvedValueOnce({
        delivered: false,
        jobId: 'intake-analysis:21:g0',
        traceId: 'trace',
      });
      const result = await usecase.execute(buildCommand());
      expect(result.analysisDelivery).toEqual({ traceId: 'trace', delivered: false });
    });

    it('同标识重放不产生新投递意图', async () => {
      intakeService.findByRecordUuid.mockResolvedValueOnce(buildIntake({ analysisGeneration: 0 }));
      const result = await usecase.execute(buildCommand());
      expect(result.replayed).toBe(true);
      expect(result.analysisTraceId).toBeNull();
      expect(result.analysisDelivery).toBeNull();
      expect(asyncTaskRecordService.recordEnqueued).not.toHaveBeenCalled();
      expect(deliverIntakeAnalysis.execute).not.toHaveBeenCalled();
    });

    it('事务内按「公司 → 厂家 → 机型 → 原稿 → 工单 → 关联」顺序执行', async () => {
      await usecase.execute(buildCommand());

      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.intakeId).toBe(21);
      expect(insertData.customerOrganizationId).toBe(77);
      expect(insertData.serviceOrganizationId).toBe(88);
      expect(accountQueryService.findCustomerOrganizationId).toHaveBeenCalledWith({
        accountId: 7,
        transactionContext,
      });
      expect(organizationQueryService.findActiveServiceProviderForWrite).toHaveBeenCalledWith({
        organizationId: 88,
        transactionContext,
      });
      expect(intakeService.insertIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          recordUuid: RECORD_UUID,
          customerAccountId: 7,
          customerOrganizationId: 77,
          serviceOrganizationId: 88,
          equipmentModelId: 3,
          fileId: null,
        }),
        transactionContext,
      );
      expect(intakeService.markConverted).toHaveBeenCalledWith(
        { intakeId: 21, requestId: 11 },
        transactionContext,
      );
    });

    it('生成的申请编号符合 RR 前缀格式且长度受限', async () => {
      const result = await usecase.execute(buildCommand());

      expect(result.request.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(result.request.requestNo.length).toBeLessThanOrEqual(50);
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

    it('客户公司与厂家只来自可信事实：客户端自报组织被忽略', async () => {
      const smuggled = {
        ...buildCommand(),
        ownerOrganizationId: 999,
        customerOrganizationId: 998,
      } as unknown as CreateRepairRequestCommand;

      await usecase.execute(smuggled);

      const insertData = repairRequestService.insertRequest.mock.calls[0][0];
      expect(insertData.ownerOrganizationId).toBe(77);
      expect(insertData.customerOrganizationId).toBe(77);
      expect(insertData.serviceOrganizationId).toBe(88);
    });

    it('提交标识归一为小写 UUID 并可大写重发', async () => {
      await usecase.execute(buildCommand({ recordUuid: RECORD_UUID.toUpperCase() }));

      expect(intakeService.findByRecordUuid).toHaveBeenCalledWith(RECORD_UUID);
      expect(intakeService.insertIntake).toHaveBeenCalledWith(
        expect.objectContaining({ recordUuid: RECORD_UUID }),
        transactionContext,
      );
    });
  });

  describe('手填机型（同事务查重/登记）', () => {
    it('未命中时登记机型（编码与名称同源）并用于工单', async () => {
      await usecase.execute(
        buildCommand({ equipmentModelId: null, equipmentModelText: '  NSR-S622D  ' }),
      );

      expect(equipmentModelService.findForWriteByModelCode).toHaveBeenCalledWith({
        modelCode: 'NSR-S622D',
        transactionContext,
      });
      expect(equipmentModelService.insertModel).toHaveBeenCalledWith(
        { modelCode: 'NSR-S622D', modelName: 'NSR-S622D' },
        transactionContext,
      );
      expect(repairRequestService.insertRequest.mock.calls[0][0].equipmentModelId).toBe(41);
    });

    it('连续空白折叠为单空格后再查重', async () => {
      await usecase.execute(
        buildCommand({ equipmentModelId: null, equipmentModelText: '  Nikon   NSR-2  ' }),
      );

      expect(equipmentModelService.findForWriteByModelCode).toHaveBeenCalledWith({
        modelCode: 'Nikon NSR-2',
        transactionContext,
      });
    });

    it('命中已有启用机型时复用，不重复登记', async () => {
      equipmentModelService.findForWriteByModelCode.mockResolvedValue({
        id: 5,
        modelCode: 'NSR-S622D',
        modelName: 'NSR-S622D',
        enabled: true,
      });

      await usecase.execute(
        buildCommand({ equipmentModelId: null, equipmentModelText: 'NSR-S622D' }),
      );

      expect(equipmentModelService.insertModel).not.toHaveBeenCalled();
      expect(repairRequestService.insertRequest.mock.calls[0][0].equipmentModelId).toBe(5);
    });

    it('命中已停用机型时拒绝且不登记新机型', async () => {
      equipmentModelService.findForWriteByModelCode.mockResolvedValue({
        id: 6,
        modelCode: 'OLD-MODEL',
        modelName: 'OLD-MODEL',
        enabled: false,
      });

      await expect(
        usecase.execute(buildCommand({ equipmentModelId: null, equipmentModelText: 'OLD-MODEL' })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED });
      expect(equipmentModelService.insertModel).not.toHaveBeenCalled();
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
    });

    it('并发登记撞唯一键时在同一事务内重读胜出方', async () => {
      equipmentModelService.insertModel.mockRejectedValueOnce(
        new DomainError(
          REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_REGISTRATION_CONFLICT,
          '设备型号登记冲突',
        ),
      );
      equipmentModelService.findForWriteByModelCode
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 42,
          modelCode: 'NSR-S622D',
          modelName: 'NSR-S622D',
          enabled: true,
        });

      await usecase.execute(
        buildCommand({ equipmentModelId: null, equipmentModelText: 'NSR-S622D' }),
      );

      expect(repairRequestService.insertRequest.mock.calls[0][0].equipmentModelId).toBe(42);
    });

    it('手填机型超长时拒绝（不进入事务）', async () => {
      await expect(
        usecase.execute(
          buildCommand({ equipmentModelId: null, equipmentModelText: 'X'.repeat(51) }),
        ),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID });
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('同时提供已有机型与手填机型时拒绝（防绕过）', async () => {
      await expect(
        usecase.execute(buildCommand({ equipmentModelId: 3, equipmentModelText: 'NSR-S622D' })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID });
    });

    it('两者都不提供时拒绝', async () => {
      await expect(
        usecase.execute(buildCommand({ equipmentModelId: null, equipmentModelText: '   ' })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID });
    });
  });

  describe('同标识幂等', () => {
    it('已存在同标识且内容一致：返回原工单，零写入（仅只读核验事务）', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());

      const result = await usecase.execute(buildCommand());

      expect(result.replayed).toBe(true);
      expect(result.request.id).toBe(11);
      // PR #27 复审：重放核验在只读事务内完成（锁读工单 → 原稿），无任何写入
      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(repairRequestService.findReplayRequestStateForUpdate).toHaveBeenCalledWith(
        11,
        transactionContext,
      );
      expect(intakeService.findReplayIntakeStateForUpdate).toHaveBeenCalledWith(
        RECORD_UUID,
        transactionContext,
      );
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
      expect(equipmentModelService.insertModel).not.toHaveBeenCalled();
    });

    it('同标识但内容不同：CONFLICT 且不返回原记录字段', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());

      await expect(
        usecase.execute(buildCommand({ faultDescription: '另一段描述' })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('同标识但厂家不同：CONFLICT', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());

      await expect(
        usecase.execute(buildCommand({ serviceOrganizationId: 89 })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT });
    });

    it('同标识但附件不同：CONFLICT（异主/换文件均被拒）', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake({ fileId: null }));

      await expect(
        usecase.execute(
          buildCommand({ attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID } }),
        ),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT });
    });

    it('同标识属于其他账号：CONFLICT（不泄露原记录）', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake({ customerAccountId: 8 }));

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('同标识但手填机型指向的机型与落库不一致：CONFLICT', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      equipmentModelQueryService.findModelByCode.mockResolvedValue({
        id: 99,
        modelCode: 'NSR-S622D',
        modelName: 'NSR-S622D',
        enabled: true,
      });

      await expect(
        usecase.execute(buildCommand({ equipmentModelId: null, equipmentModelText: 'NSR-S622D' })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT });
    });

    it('并发同标识撞唯一键：事务外重读胜出方并返回原工单', async () => {
      intakeService.findByRecordUuid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildIntake());
      intakeService.insertIntake.mockRejectedValueOnce(
        new DomainError(REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE, '同一提交标识已被占用'),
      );

      const result = await usecase.execute(buildCommand());

      expect(result.replayed).toBe(true);
      // 创建事务（撞唯一键回滚）+ 重放只读核验事务
      expect(transactionRunner.run).toHaveBeenCalledTimes(2);
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it('并发撞键后仍读不到原稿：CONFLICT，不伪造成功', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(null);
      intakeService.insertIntake.mockRejectedValue(
        new DomainError(REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE, '同一提交标识已被占用'),
      );

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT,
      });
    });

    it('原稿存在但工单缺失（异常半态）：失败关闭，不返回拼接工单', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake({ convertedRequestId: null }));

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });
  });

  // PR #27 复审：同标识重试在返回成功前必须核验原稿与工单仍有效；
  // 已删除原稿 / 已删除工单 / 双向关联异常一律失败关闭，不恢复旧工单、
  // 不重新登记机型、不重复投递首析。
  describe('已删除原申请的同标识重试（PR #27 复审）', () => {
    it('工单已软删（deprecated）：SUBMISSION_ORIGINAL_DELETED，不返回创建成功', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      repairRequestService.findReplayRequestStateForUpdate.mockResolvedValue({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: true,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SUBMISSION_ORIGINAL_DELETED,
        message: expect.stringContaining('原申请已删除'),
      });
      // 不读取工单快照返回成功，也不产生任何写入
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
    });

    it('原稿已软删（工单未删）：SUBMISSION_ORIGINAL_DELETED（双向核验任一侧删除即拒绝）', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      intakeService.findReplayIntakeStateForUpdate.mockResolvedValue({
        id: 21,
        customerAccountId: 7,
        convertedRequestId: 11,
        deleted: true,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SUBMISSION_ORIGINAL_DELETED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('双向关联异常（工单未指向本原稿）：失败关闭 CREATION_FAILED，不返回原记录', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      repairRequestService.findReplayRequestStateForUpdate.mockResolvedValue({
        id: 11,
        customerAccountId: 7,
        intakeId: 999,
        deprecated: false,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('双向关联异常（原稿转换列与工单侧不一致）：失败关闭 CREATION_FAILED', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      intakeService.findReplayIntakeStateForUpdate.mockResolvedValue({
        id: 21,
        customerAccountId: 7,
        convertedRequestId: 12,
        deleted: false,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('核验锁读按「工单行 → 原稿行」顺序在事务内执行（与删除链路锁序一致）', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());

      await usecase.execute(buildCommand());

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(repairRequestService.findReplayRequestStateForUpdate).toHaveBeenCalledWith(
        11,
        transactionContext,
      );
      expect(intakeService.findReplayIntakeStateForUpdate).toHaveBeenCalledWith(
        RECORD_UUID,
        transactionContext,
      );
      // 锁序：工单行先于原稿行，避免与删除链路（软删工单 → 软删原稿）反向锁等待
      expect(
        repairRequestService.findReplayRequestStateForUpdate.mock.invocationCallOrder[0],
      ).toBeLessThan(intakeService.findReplayIntakeStateForUpdate.mock.invocationCallOrder[0]);
    });

    it('并发撞键后重读胜出方已删除：同样按 ORIGINAL_DELETED 失败关闭（并发冲突后重放入口）', async () => {
      // 入口二：并发同标识唯一键冲突 → 事务外重读胜出方 → 胜出方已被删除
      intakeService.findByRecordUuid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildIntake());
      intakeService.insertIntake.mockRejectedValueOnce(
        new DomainError(REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE, '同一提交标识已被占用'),
      );
      repairRequestService.findReplayRequestStateForUpdate.mockResolvedValue({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: true,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SUBMISSION_ORIGINAL_DELETED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });

    it('核验读到归属异常（他人工单/他人原稿）：失败关闭，不返回原记录字段', async () => {
      intakeService.findByRecordUuid.mockResolvedValue(buildIntake());
      repairRequestService.findReplayRequestStateForUpdate.mockResolvedValue({
        id: 11,
        customerAccountId: 8,
        intakeId: 21,
        deprecated: false,
      });

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CREATION_FAILED,
      });
      expect(repairRequestService.findSnapshotById).not.toHaveBeenCalled();
    });
  });

  describe('附件绑定', () => {
    it('提供原件时在同一事务内绑定到本原稿，并把 fileId 写入原稿', async () => {
      await usecase.execute(
        buildCommand({ attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID } }),
      );

      expect(bindOriginal.executeInTransaction).toHaveBeenCalledWith(
        {
          session: customerSession,
          intakeId: 21,
          fileId: FILE_ID,
          uploadContextId: UPLOAD_CONTEXT_ID,
        },
        transactionContext,
      );
      expect(intakeService.insertIntake).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: FILE_ID }),
        transactionContext,
      );
    });

    it('未提供原件时不调用绑定能力，fileId 为 null', async () => {
      await usecase.execute(buildCommand());

      expect(bindOriginal.executeInTransaction).not.toHaveBeenCalled();
      expect(intakeService.insertIntake).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: null }),
        transactionContext,
      );
    });

    it('原件引用不完整时拒绝（不进入事务）', async () => {
      await expect(
        usecase.execute(
          buildCommand({
            attachment: { fileId: FILE_ID, uploadContextId: '' },
          }),
        ),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('绑定失败时整单失败（原稿与工单不落地）', async () => {
      bindOriginal.executeInTransaction.mockRejectedValue(
        new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '原件不存在或无权绑定'),
      );

      await expect(
        usecase.execute(
          buildCommand({ attachment: { fileId: FILE_ID, uploadContextId: UPLOAD_CONTEXT_ID } }),
        ),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });
  });

  describe('资格与角色决策', () => {
    it('客户缺公司归属：拒绝提交且零落库（引导先补录）', async () => {
      accountQueryService.findCustomerOrganizationId.mockResolvedValue(null);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED,
      });
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it('归属公司已停用：拒绝提交且零落库', async () => {
      organizationQueryService.findActiveOrganizationForWrite.mockResolvedValue(null);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_UNAVAILABLE,
      });
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
    });

    it('厂家已停用或无维修服务资格：拒绝提交且零落库', async () => {
      organizationQueryService.findActiveServiceProviderForWrite.mockResolvedValue(null);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.SERVICE_ORGANIZATION_NOT_AVAILABLE,
      });
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
      expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
    });

    it.each([[['ENGINEER']], [['SUPER_ADMIN']], [['ENGINEER', 'SUPER_ADMIN']], [[]]])(
      'roles=%j 时拒绝提交',
      async (roles) => {
        await expect(
          usecase.execute(buildCommand({ session: { accountId: 7, roles } })),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
        expect(repairRequestService.insertRequest).not.toHaveBeenCalled();
      },
    );
  });

  describe('输入决策', () => {
    it('提交标识缺失或格式非法时拒绝（不进入事务）', async () => {
      for (const recordUuid of ['', 'not-a-uuid', `${RECORD_UUID}-x`]) {
        await expect(usecase.execute(buildCommand({ recordUuid }))).rejects.toMatchObject({
          code: REPAIR_REQUEST_ERROR.SUBMISSION_KEY_INVALID,
        });
      }
      expect(transactionRunner.run).not.toHaveBeenCalled();
    });

    it('维修厂家 ID 非正整数时拒绝', async () => {
      await expect(
        usecase.execute(buildCommand({ serviceOrganizationId: 0 })),
      ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });
    });

    it('设备型号 ID 非正整数时拒绝', async () => {
      await expect(usecase.execute(buildCommand({ equipmentModelId: 0 }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID,
      });
      await expect(usecase.execute(buildCommand({ equipmentModelId: 1.5 }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID,
      });
    });

    it('错误码为空白时拒绝', async () => {
      await expect(usecase.execute(buildCommand({ errorCode: '   ' }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });
    });

    it('错误码超过 100 字符时拒绝', async () => {
      await expect(
        usecase.execute(buildCommand({ errorCode: 'E'.repeat(101) })),
      ).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });
    });

    it('错误码恰好 100 字符时允许创建（边界值）', async () => {
      const result = await usecase.execute(buildCommand({ errorCode: 'E'.repeat(100) }));
      expect(result.request.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
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
      expect(result.request.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
      expect(repairRequestService.insertRequest).toHaveBeenCalledTimes(1);
    });

    it('故障描述为空白时拒绝', async () => {
      await expect(
        usecase.execute(buildCommand({ faultDescription: '\n  ' })),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY });
    });
  });

  describe('设备型号校验（选择已有）', () => {
    it('型号不存在时拒绝且不落库', async () => {
      equipmentModelQueryService.findModelById.mockResolvedValue(null);

      await expect(usecase.execute(buildCommand())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      });
      expect(intakeService.insertIntake).not.toHaveBeenCalled();
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
      expect(result.request.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
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
      expect(result.request.requestNo).toMatch(/^RR\d{14}[A-Z0-9]{6}$/);
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
