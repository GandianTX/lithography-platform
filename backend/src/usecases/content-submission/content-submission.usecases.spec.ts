// src/usecases/content-submission/content-submission.usecases.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { CreateContentSubmissionDraftUsecase } from './create-content-submission-draft.usecase';
import { GetMyContentSubmissionUsecase } from './get-my-content-submission.usecase';
import { ListMyContentSubmissionsUsecase } from './list-my-content-submissions.usecase';
import { UpdateContentSubmissionDraftUsecase } from './update-content-submission-draft.usecase';

const makeWriteService = () => ({
  insertSubmission: jest.fn().mockResolvedValue({ submissionId: 970001 }),
  lockSubmissionForWrite: jest.fn().mockResolvedValue(null),
  updateMaterialSubmissionDetail: jest.fn().mockResolvedValue(undefined),
  updateFaultCaseSubmissionDetail: jest.fn().mockResolvedValue(undefined),
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  status: 'DRAFT',
  updatedAt: new Date('2026-02-01T10:00:00.000Z'),
  ...overrides,
});

const makeQueryService = () => ({
  listMine: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10 }),
  findMineDetail: jest.fn(),
  readStatusSnapshot: jest.fn().mockResolvedValue(snapshot()),
  readMaterialDetailForWrite: jest.fn(),
  readFaultCaseDetailForWrite: jest.fn(),
});

const makeModelQueryService = () => ({
  findModelById: jest.fn().mockResolvedValue({ id: 930001, modelCode: 'M', modelName: '型号' }),
});

/** 可信组织上下文替身：缺省解析到甲方默认组织（与 Seed 口径一致） */
const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId: 910001,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'ENGINEER',
  }),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb({ transaction: 'mock' })),
  }) as unknown as TransactionRunner;

const session = (roles: string[]): UsecaseSession =>
  ({ accountId: 900001, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const transactionContext = { transaction: 'mock' };

/** 行锁快照替身（默认本人 + 本组织 + DRAFT 普通资料） */
const materialLock = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  ownerOrganizationId: 910001,
  submittedByAccountId: 900001,
  status: 'DRAFT',
  currentRevisionNo: 0,
  ...overrides,
});

const faultCaseLock = (overrides: Record<string, unknown> = {}) =>
  materialLock({ submissionKind: 'FAULT_CASE', ...overrides });

/** 普通资料明细当前值替身（读取用于补丁合并） */
const materialCurrent = (overrides: Record<string, unknown> = {}) => ({
  title: '操作手册',
  documentType: 'MANUAL',
  equipmentModelId: null,
  equipmentModelText: null,
  description: null,
  contentText: '内容',
  ...overrides,
});

/** 故障案例明细当前值替身 */
const faultCaseCurrent = (overrides: Record<string, unknown> = {}) => ({
  title: '曝光异常',
  equipmentModelId: null,
  equipmentModelText: null,
  errorCode: null,
  phenomenon: '现象',
  conditionText: null,
  reproductionSteps: null,
  diagnosis: null,
  actionTaken: null,
  handlingStatus: 'UNRESOLVED',
  resolution: null,
  ...overrides,
});

describe('CreateContentSubmissionDraftUsecase', () => {
  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      modelQueryService?: ReturnType<typeof makeModelQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const modelQueryService = overrides.modelQueryService ?? makeModelQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    return {
      usecase: new CreateContentSubmissionDraftUsecase(
        writeService as unknown as ContentSubmissionService,
        queryService as unknown as ContentSubmissionQueryService,
        modelQueryService as unknown as EquipmentModelQueryService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
        makeTransactionRunner(),
      ),
      writeService,
      queryService,
      modelQueryService,
      organizationContextService,
    };
  };

  it('工程师创建普通资料草稿：组织/创建人取自可信来源，空白折叠后落库并回读真实快照', async () => {
    const { usecase, writeService, queryService, organizationContextService } = makeUsecase();

    const result = await usecase.execute({
      session: engineer,
      kind: 'MATERIAL',
      fields: {
        title: '  操作手册  ',
        documentType: 'MANUAL',
        description: '   ',
        contentText: '正文',
      },
    });

    expect(organizationContextService.resolveForAccount).toHaveBeenCalledWith({
      accountId: 900001,
      transactionContext,
    });
    expect(writeService.insertSubmission).toHaveBeenCalledWith(
      {
        submissionKind: 'MATERIAL',
        ownerOrganizationId: 910001,
        submittedByAccountId: 900001,
        material: {
          title: '操作手册',
          documentType: 'MANUAL',
          equipmentModelId: null,
          equipmentModelText: null,
          description: null,
          contentText: '正文',
        },
        faultCase: null,
      },
      transactionContext,
    );
    expect(queryService.readStatusSnapshot).toHaveBeenCalledWith({
      submissionId: 970001,
      transactionContext,
    });
    expect(result).toEqual(snapshot());
  });

  it('创建故障案例草稿：错误码保留大小写与内部符号，处理状态按受控值域精确匹配', async () => {
    const { usecase, writeService, queryService } = makeUsecase();
    queryService.readStatusSnapshot.mockResolvedValue(snapshot({ submissionKind: 'FAULT_CASE' }));

    await usecase.execute({
      session: engineer,
      kind: 'FAULT_CASE',
      fields: {
        title: '曝光异常',
        errorCode: 'E-12a/Sub',
        phenomenon: '现象',
        reproductionSteps: '步骤一\n步骤二',
        handlingStatus: 'IN_PROGRESS',
      },
    });

    expect(writeService.insertSubmission).toHaveBeenCalledWith(
      {
        submissionKind: 'FAULT_CASE',
        ownerOrganizationId: 910001,
        submittedByAccountId: 900001,
        material: null,
        faultCase: {
          title: '曝光异常',
          equipmentModelId: null,
          equipmentModelText: null,
          errorCode: 'E-12a/Sub',
          phenomenon: '现象',
          conditionText: null,
          reproductionSteps: '步骤一\n步骤二',
          diagnosis: null,
          actionTaken: null,
          handlingStatus: 'IN_PROGRESS',
          resolution: null,
        },
      },
      transactionContext,
    );

    // 值域外处理状态拒绝（不做大小写折叠）
    await expect(
      usecase.execute({
        session: engineer,
        kind: 'FAULT_CASE',
        fields: { title: 'x', handlingStatus: 'in_progress' },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });
    expect(writeService.insertSubmission).toHaveBeenCalledTimes(1);
  });

  it('草稿「已填写」口径：只有机型 ID / 处理状态等默认项不算已填写（DRAFT_EMPTY）', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { equipmentModelId: 930001 },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'FAULT_CASE',
        fields: { handlingStatus: 'UNRESOLVED' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('类别与字段匹配：不属于该类别的字段出现非空值拒绝，null/undefined 占位视为未提供', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', phenomenon: '案例字段' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'FAULT_CASE',
        fields: { title: 'x', documentType: 'MANUAL' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();

    // null 占位不视为「提供」
    await usecase.execute({
      session: engineer,
      kind: 'MATERIAL',
      fields: { title: 'x', phenomenon: null, description: '说明' },
    });
    expect(writeService.insertSubmission).toHaveBeenCalledTimes(1);
  });

  it('机型 ID 与机型文字互斥（与数据库 CHECK 口径一致）', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', equipmentModelId: 930001, equipmentModelText: 'ZX-1' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('资料类型不能是 FAULT_CASE（大小写变体同样拒绝，对齐 ci 校验）', async () => {
    const { usecase, writeService } = makeUsecase();

    for (const documentType of ['FAULT_CASE', 'fault_case', 'Fault_Case']) {
      await expect(
        usecase.execute({
          session: engineer,
          kind: 'MATERIAL',
          fields: { title: 'x', documentType },
        }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    }
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('v1 扩展位：任何未定义键拒绝，空集与缺省忽略', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', extension: { customField: 1 } },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();

    await usecase.execute({
      session: engineer,
      kind: 'MATERIAL',
      fields: { title: 'x', extension: {} },
    });
    expect(writeService.insertSubmission).toHaveBeenCalledTimes(1);
  });

  it('RESOLVED 状态必须有处理结果（草稿期即强制，与数据库 CHECK 一致）', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'FAULT_CASE',
        fields: { title: 'x', phenomenon: 'y', handlingStatus: 'RESOLVED' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();

    await usecase.execute({
      session: engineer,
      kind: 'FAULT_CASE',
      fields: { title: 'x', phenomenon: 'y', handlingStatus: 'RESOLVED', resolution: '已修复' },
    });
    expect(writeService.insertSubmission).toHaveBeenCalledTimes(1);
  });

  it('文本长度上限：标题 255 / 说明 2,000 / 正文 200,000 超长拒绝', async () => {
    const { usecase, writeService } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'a'.repeat(256) },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', description: 'a'.repeat(2001) },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', contentText: 'a'.repeat(200_001) },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('非法机型：非正整数在预检拒绝，型号不存在拒绝（EQUIPMENT_MODEL_NOT_FOUND）', async () => {
    const modelQueryService = makeModelQueryService();
    modelQueryService.findModelById.mockResolvedValue(null);
    const { usecase, writeService } = makeUsecase({ modelQueryService });

    for (const invalidId of [0, -1, 1.5]) {
      await expect(
        usecase.execute({
          session: engineer,
          kind: 'MATERIAL',
          fields: { title: 'x', equipmentModelId: invalidId },
        }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    }
    expect(modelQueryService.findModelById).not.toHaveBeenCalled();

    await expect(
      usecase.execute({
        session: engineer,
        kind: 'MATERIAL',
        fields: { title: 'x', equipmentModelId: 930099 },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('非投稿人角色拒绝：管理员 activeRole 不自动继承、客户拒绝、activeRole 缺失失败关闭', async () => {
    const { usecase, writeService } = makeUsecase();
    const baseCommand = { kind: 'MATERIAL', fields: { title: 'x' } };

    await expect(
      usecase.execute({ session: session(['SUPER_ADMIN']), ...baseCommand }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    await expect(
      usecase.execute({ session: session(['CUSTOMER']), ...baseCommand }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    await expect(
      usecase.execute({
        session: { accountId: 900001, roles: ['ENGINEER'] },
        ...baseCommand,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });

  it('无有效组织成员关系拒绝（ORGANIZATION_NO_ACTIVE_MEMBERSHIP），不进入写入', async () => {
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValue(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织成员关系'),
    );
    const { usecase, writeService } = makeUsecase({ organizationContextService });

    await expect(
      usecase.execute({ session: engineer, kind: 'MATERIAL', fields: { title: 'x' } }),
    ).rejects.toMatchObject({ code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP });
    expect(writeService.insertSubmission).not.toHaveBeenCalled();
  });
});

describe('UpdateContentSubmissionDraftUsecase', () => {
  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      modelQueryService?: ReturnType<typeof makeModelQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const modelQueryService = overrides.modelQueryService ?? makeModelQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    return {
      usecase: new UpdateContentSubmissionDraftUsecase(
        writeService as unknown as ContentSubmissionService,
        queryService as unknown as ContentSubmissionQueryService,
        modelQueryService as unknown as EquipmentModelQueryService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
        makeTransactionRunner(),
      ),
      writeService,
      queryService,
      modelQueryService,
      organizationContextService,
    };
  };

  it('字段合并：undefined 保持、null/空白清空、新值覆盖；全量覆盖更新并回读真实状态', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(materialLock());
    const queryService = makeQueryService();
    queryService.readMaterialDetailForWrite.mockResolvedValue(
      materialCurrent({ description: '旧说明' }),
    );
    const { usecase } = makeUsecase({ writeService, queryService });

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      patch: { title: '  新标题  ', description: '   ' },
    });

    expect(writeService.updateMaterialSubmissionDetail).toHaveBeenCalledWith({
      submissionId: 970001,
      detail: {
        title: '新标题',
        documentType: 'MANUAL',
        equipmentModelId: null,
        equipmentModelText: null,
        description: null,
        contentText: '内容',
      },
      transactionContext,
    });
    expect(result).toEqual(snapshot());
  });

  it('RETURNED 状态可编辑（退回重提前修改当前稿）；PENDING_REVIEW 只读拒绝', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(materialLock({ status: 'RETURNED' }));
    const queryService = makeQueryService();
    queryService.readMaterialDetailForWrite.mockResolvedValue(materialCurrent());
    const { usecase } = makeUsecase({ writeService, queryService });

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      patch: { title: '退回后修改' },
    });
    expect(writeService.updateMaterialSubmissionDetail).toHaveBeenCalledTimes(1);

    writeService.lockSubmissionForWrite.mockResolvedValue(
      materialLock({ status: 'PENDING_REVIEW' }),
    );
    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, patch: { title: 'x' } }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.updateMaterialSubmissionDetail).toHaveBeenCalledTimes(1);
    expect(queryService.readMaterialDetailForWrite).toHaveBeenCalledTimes(1);
  });

  it('他人投稿 / 跨组织 / 不存在统一 NOT_FOUND（不泄露存在性），不读取明细', async () => {
    const writeService = makeWriteService();
    const queryService = makeQueryService();
    const { usecase } = makeUsecase({ writeService, queryService });
    const command = { session: engineer, submissionId: 970001, patch: { title: 'x' } };

    for (const lock of [
      null,
      materialLock({ submittedByAccountId: 900002 }),
      materialLock({ ownerOrganizationId: 910002 }),
    ]) {
      writeService.lockSubmissionForWrite.mockResolvedValue(lock);
      await expect(usecase.execute(command)).rejects.toMatchObject({
        code: CONTENT_SUBMISSION_ERROR.NOT_FOUND,
      });
    }
    expect(queryService.readMaterialDetailForWrite).not.toHaveBeenCalled();
  });

  it('空补丁拒绝（全 undefined），行锁读取前即在事务外失败关闭', async () => {
    const writeService = makeWriteService();
    const { usecase } = makeUsecase({ writeService });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, patch: {} }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.lockSubmissionForWrite).not.toHaveBeenCalled();
  });

  it('合并后清空到空草稿拒绝（DRAFT_EMPTY）：唯一已填字段被清空不合法', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(materialLock());
    const queryService = makeQueryService();
    queryService.readMaterialDetailForWrite.mockResolvedValue(
      materialCurrent({
        title: '唯一字段',
        documentType: null,
        description: null,
        contentText: null,
      }),
    );
    const { usecase } = makeUsecase({ writeService, queryService });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, patch: { title: null } }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY });
    expect(writeService.updateMaterialSubmissionDetail).not.toHaveBeenCalled();
  });

  it('机型替换：同一补丁内清空机型文字 + 设置机型 ID 允许；仅设置 ID 而保留文字拒绝', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(materialLock());
    const queryService = makeQueryService();
    queryService.readMaterialDetailForWrite.mockResolvedValue(
      materialCurrent({ equipmentModelText: 'ZX-1' }),
    );
    const { usecase } = makeUsecase({ writeService, queryService });

    await expect(
      usecase.execute({
        session: engineer,
        submissionId: 970001,
        patch: { equipmentModelId: 930001 },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.updateMaterialSubmissionDetail).not.toHaveBeenCalled();

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      patch: { equipmentModelId: 930001, equipmentModelText: null },
    });
    expect(writeService.updateMaterialSubmissionDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          equipmentModelId: 930001,
          equipmentModelText: null,
        }),
      }),
    );
  });

  it('机型 ID 未变化不重复查型号；变更时校验存在性（不存在拒绝）', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(materialLock());
    const queryService = makeQueryService();
    queryService.readMaterialDetailForWrite.mockResolvedValue(
      materialCurrent({ equipmentModelId: 930001 }),
    );
    const modelQueryService = makeModelQueryService();
    const { usecase } = makeUsecase({ writeService, queryService, modelQueryService });

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      patch: { equipmentModelId: 930001 },
    });
    expect(modelQueryService.findModelById).not.toHaveBeenCalled();

    modelQueryService.findModelById.mockResolvedValue(null);
    await expect(
      usecase.execute({
        session: engineer,
        submissionId: 970001,
        patch: { equipmentModelId: 930099 },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.EQUIPMENT_MODEL_NOT_FOUND });
  });

  it('案例合并：保持 RESOLVED 时清空结果拒绝；类别不变（案例携带资料专属字段拒绝）', async () => {
    const writeService = makeWriteService();
    writeService.lockSubmissionForWrite.mockResolvedValue(faultCaseLock());
    const queryService = makeQueryService();
    queryService.readFaultCaseDetailForWrite.mockResolvedValue(
      faultCaseCurrent({ handlingStatus: 'RESOLVED', resolution: '已修复', title: '案例标题' }),
    );
    const { usecase } = makeUsecase({ writeService, queryService });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, patch: { resolution: null } }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });

    await expect(
      usecase.execute({
        session: engineer,
        submissionId: 970001,
        patch: { documentType: 'MANUAL' },
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.updateFaultCaseSubmissionDetail).not.toHaveBeenCalled();

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      patch: { handlingStatus: 'UNRESOLVED', resolution: null },
    });
    expect(writeService.updateFaultCaseSubmissionDetail).toHaveBeenCalledTimes(1);
  });

  it('non-ENGINEER 角色拒绝；投稿 ID 非法拒绝（行锁前失败）', async () => {
    const writeService = makeWriteService();
    const { usecase } = makeUsecase({ writeService });

    await expect(
      usecase.execute({
        session: session(['SUPER_ADMIN']),
        submissionId: 970001,
        patch: { title: 'x' },
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    await expect(
      usecase.execute({ session: engineer, submissionId: 0, patch: { title: 'x' } }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(writeService.lockSubmissionForWrite).not.toHaveBeenCalled();
  });
});

describe('ListMyContentSubmissionsUsecase', () => {
  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    return {
      usecase: new ListMyContentSubmissionsUsecase(
        queryService as unknown as ContentSubmissionQueryService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
      ),
      queryService,
      organizationContextService,
    };
  };

  it('工程师本人列表：投稿人+组织双过滤透传，筛选与分页规范化透传', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute({
      session: engineer,
      pagination: { mode: 'OFFSET', page: 2, pageSize: 5 },
      filter: { title: '手册', submissionKind: 'MATERIAL', status: 'DRAFT' },
    });

    expect(queryService.listMine).toHaveBeenCalledWith({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
      filter: { title: '手册', submissionKind: 'MATERIAL', status: 'DRAFT' },
      pagination: { page: 2, pageSize: 5, withTotal: false },
    });
  });

  it('空白筛选词视为无筛选；非法枚举筛选拒绝', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute({
      session: engineer,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
      filter: { title: '  ', submissionKind: ' ', status: 'DRAFT' },
    });
    expect(queryService.listMine).toHaveBeenCalledWith({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
      filter: { title: undefined, submissionKind: undefined, status: 'DRAFT' },
      pagination: { page: 1, pageSize: 20, withTotal: false },
    });

    await expect(
      usecase.execute({
        session: engineer,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
        filter: { status: 'UNKNOWN' },
      }),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });
    expect(queryService.listMine).toHaveBeenCalledTimes(1);
  });

  it('页大小超上限钳制为 100；CURSOR 分页拒绝', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute({
      session: engineer,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 500 },
      filter: {},
    });
    expect(queryService.listMine).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { page: 1, pageSize: 100, withTotal: false } }),
    );

    await expect(
      usecase.execute({
        session: engineer,
        pagination: { mode: 'CURSOR', limit: 10 },
        filter: {},
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
  });

  it('CUSTOMER 拒绝且不查询；无有效组织成员关系拒绝', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute({
        session: session(['CUSTOMER']),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
        filter: {},
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.listMine).not.toHaveBeenCalled();
  });
});

describe('GetMyContentSubmissionUsecase', () => {
  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    return {
      usecase: new GetMyContentSubmissionUsecase(
        queryService as unknown as ContentSubmissionQueryService,
        organizationContextService as unknown as TrustedOrganizationContextQueryService,
      ),
      queryService,
      organizationContextService,
    };
  };

  it('本人详情：投稿人+组织双过滤透传，返回 QueryService 视图', async () => {
    const queryService = makeQueryService();
    const detail = { id: 970001, submissionKind: 'MATERIAL', status: 'DRAFT' };
    queryService.findMineDetail.mockResolvedValue(detail);
    const { usecase } = makeUsecase({ queryService });

    const result = await usecase.execute({ session: engineer, submissionId: 970001 });

    expect(queryService.findMineDetail).toHaveBeenCalledWith({
      submissionId: 970001,
      submittedByAccountId: 900001,
      ownerOrganizationId: 910001,
    });
    expect(result).toEqual(detail);
  });

  it('ID 非法拒绝；CUSTOMER 拒绝且不查询', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(usecase.execute({ session: engineer, submissionId: -1 })).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
    });
    await expect(
      usecase.execute({ session: session(['CUSTOMER']), submissionId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findMineDetail).not.toHaveBeenCalled();
  });
});
