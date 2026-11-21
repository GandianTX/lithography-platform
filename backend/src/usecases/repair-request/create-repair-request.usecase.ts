// src/usecases/repair-request/create-repair-request.usecase.ts

import { randomInt, randomUUID } from 'node:crypto';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
  INTAKE_ANALYSIS_JOB_NAME,
  INTAKE_ANALYSIS_MAX_ATTEMPTS,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import {
  DomainError,
  isDomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import {
  normalizeOptionalText,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  EquipmentModelDetailSnapshot,
  RepairRequestIntakeSnapshot,
} from '@src/modules/lithography/lithography.types';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import { EquipmentModelService } from '@src/modules/lithography/equipment-model.service';
import { RepairRequestIntakeService } from '@src/modules/lithography/repair-request-intake.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import { DeliverIntakeAnalysisUsecase } from './deliver-intake-analysis.usecase';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { BindRepairRequestOriginalUsecase } from './bind-repair-request-original.usecase';
import {
  CreateRepairRequestAttachmentInput,
  CreateRepairRequestCommand,
  CreateRepairRequestResult,
} from './create-repair-request.types';

/** 错误码长度上限（与 equipment_model / repair_request 表列长一致） */
const ERROR_CODE_MAX_LENGTH = 100;

/** 故障描述长度上限（与 GraphQL DTO 一致；长度语义由 Usecase 判定，避免其他 adapter 绕过 DTO 后丢失约束） */
const FAULT_DESCRIPTION_MAX_LENGTH = 5000;

/** 申请编号重试上限（预检查与落库撞号重试共用） */
const REQUEST_NO_RETRY_LIMIT = 3;

/** 手填机型文本长度上限（与 equipment_model.model_code 列长 50 一致；编码与名称同源） */
const MANUAL_MODEL_TEXT_MAX_LENGTH = 50;

/** 稳定提交标识：36 位 UUID（与 repair_request_intake.record_uuid char(36) 一致） */
const RECORD_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 归一后的机型选择（已有机型 / 手填新机型 严格二选一） */
type NormalizedModelSelection =
  { kind: 'EXISTING'; equipmentModelId: number } | { kind: 'MANUAL'; modelText: string };

/** 归一后的提交内容：同标识重放按这些字段逐项比对落库事实 */
type NormalizedSubmission = {
  recordUuid: string;
  serviceOrganizationId: number;
  modelSelection: NormalizedModelSelection;
  errorCode: string;
  faultDescription: string;
  attachment: CreateRepairRequestAttachmentInput | null;
};

/**
 * 创建维修申请用例（任务 03「提交即出单」）
 *
 * 业务流程：
 * 1. 角色决策：仅 CUSTOMER 可提交（ENGINEER / SUPER_ADMIN 拒绝，兜底守卫误放）
 * 2. 输入决策：提交标识格式、维修厂家、机型二选一、错误码 / 故障描述空白与长度、
 *    附件成对关系；全部在开事务前判定，失败零落库
 * 3. 同标识快路径：已存在原稿则直接核对内容后返回原工单（不建机型、不写任何行）
 * 4. 事务内：客户公司（可信事实）→ 维修厂家资格复核 → 机型复核或登记 → 原稿落库
 *    → 原件绑定 → 唯一工单落库 → 原稿回写工单关联
 * 5. 并发同标识：原稿唯一索引先提交时事务回滚，事务外重读胜出方并核对内容后返回原工单；
 *    内容/归属不一致则 CONFLICT，且不返回原记录任何字段
 *
 * customerAccountId 仅取自会话（JWT），客户公司仅取自 `base_user_info`，客户端均不可传
 */
@Injectable()
export class CreateRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly repairRequestIntakeService: RepairRequestIntakeService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly equipmentModelService: EquipmentModelService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly bindRepairRequestOriginalUsecase: BindRepairRequestOriginalUsecase,
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    private readonly deliverIntakeAnalysisUsecase: DeliverIntakeAnalysisUsecase,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行创建维修申请流程
   *
   * @param command 创建命令（含会话身份快照）
   * @returns 唯一工单快照 + 报修原稿与首析执行意图
   */
  async execute(command: CreateRepairRequestCommand): Promise<CreateRepairRequestResult> {
    this.assertCustomerRole(command.session);
    const submission = this.normalizeSubmission(command);

    // 快路径：同一提交标识已落库（双击、成功响应丢失后重发）直接返回原记录，零写入
    const existing = await this.repairRequestIntakeService.findByRecordUuid(submission.recordUuid);
    if (existing) {
      return this.replaySubmission(command.session, submission, existing);
    }

    try {
      const result = await this.transactionRunner.run((transactionContext) =>
        this.doCreate(command.session, submission, transactionContext),
      );
      // 事务已提交（原稿、工单、账本行一起生效）；入队失败不视为业务失败，
      // 账本行保持 queued，由 housekeeping 凭首析持久任务标识补投
      if (result.analysisTraceId) {
        const delivery = await this.deliverIntakeAnalysisUsecase.execute({
          intakeId: result.intake.intakeId,
          generationNo: result.intake.analysisGeneration,
          traceId: result.analysisTraceId,
        });
        result.analysisDelivery = { traceId: delivery.traceId, delivered: delivery.delivered };
      }
      return result;
    } catch (error) {
      // 并发同标识：另一个事务先提交了原稿（唯一索引是最终裁决）。
      // 本事务已整体回滚（含机型登记、工单与绑定），事务外重读胜出方后按同一套内容核对。
      if (isDomainError(error) && error.code === REPAIR_REQUEST_ERROR.SUBMISSION_DUPLICATE) {
        const winner = await this.repairRequestIntakeService.findByRecordUuid(
          submission.recordUuid,
        );
        if (!winner) {
          throw new DomainError(
            REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT,
            '提交标识冲突，请重新提交',
            undefined,
            error,
          );
        }
        return this.replaySubmission(command.session, submission, winner);
      }
      throw error;
    }
  }

  /**
   * 事务内执行：资格复核 → 机型复核/登记 → 原稿 → 原件 → 工单 → 双向关联
   */
  private async doCreate(
    session: UsecaseSession,
    submission: NormalizedSubmission,
    transactionContext: PersistenceTransactionContext,
  ): Promise<CreateRepairRequestResult> {
    // 客户公司归属：只认 `base_user_info.customer_organization_id`（注册 / 补录写入的
    // 唯一真源），缺归属 → 引导先补录；归属组织已停用 → 归属不可用。
    const customerOrganizationId = await this.accountQueryService.findCustomerOrganizationId({
      accountId: session.accountId,
      transactionContext,
    });
    if (customerOrganizationId === null) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED,
        '请先在账号设置中补充公司信息后再提交维修申请',
        { accountId: session.accountId },
      );
    }
    const ownerOrganization = await this.organizationQueryService.findActiveOrganizationForWrite({
      organizationId: customerOrganizationId,
      transactionContext,
    });
    if (!ownerOrganization) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_UNAVAILABLE,
        '所属公司当前不可用，请联系管理员处理后再提交维修申请',
        { accountId: session.accountId, organizationId: customerOrganizationId },
      );
    }

    // 选定维修厂家：写前复核「启用 + 具备维修服务资格」，与停用/撤销资格写入串行
    const serviceOrganization =
      await this.organizationQueryService.findActiveServiceProviderForWrite({
        organizationId: submission.serviceOrganizationId,
        transactionContext,
      });
    if (!serviceOrganization) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.SERVICE_ORGANIZATION_NOT_AVAILABLE,
        '所选维修厂家当前不可用，请重新选择',
        { serviceOrganizationId: submission.serviceOrganizationId },
      );
    }

    // 机型：选择已有项按 ID 复核启用；手填按编码查重后在同一事务内登记。
    // 机型写入发生在原稿插入之前，任何后续失败都会随事务整体回滚（不留新机型）。
    const model = await this.resolveModel(submission.modelSelection, transactionContext);

    const intake = await this.repairRequestIntakeService.insertIntake(
      {
        recordUuid: submission.recordUuid,
        customerAccountId: session.accountId,
        customerOrganizationId,
        serviceOrganizationId: serviceOrganization.id,
        equipmentModelId: model.id,
        errorCode: submission.errorCode,
        faultDescription: submission.faultDescription,
        fileId: submission.attachment?.fileId ?? null,
      },
      transactionContext,
    );

    if (submission.attachment) {
      await this.bindRepairRequestOriginalUsecase.executeInTransaction(
        {
          session,
          intakeId: intake.id,
          fileId: submission.attachment.fileId,
          uploadContextId: submission.attachment.uploadContextId,
        },
        transactionContext,
      );
    }

    let conflict: DomainError | undefined;
    for (let attempt = 0; attempt < REQUEST_NO_RETRY_LIMIT; attempt += 1) {
      const requestNo = await this.generateUniqueRequestNo(transactionContext);
      const contentMd = buildRepairRequestContentMd({
        requestNo,
        model,
        errorCode: submission.errorCode,
        faultDescription: submission.faultDescription,
      });
      try {
        const request = await this.repairRequestService.insertRequest(
          {
            requestNo,
            customerAccountId: session.accountId,
            equipmentModelId: model.id,
            errorCode: submission.errorCode,
            faultDescription: submission.faultDescription,
            contentMd,
            ownerOrganizationId: ownerOrganization.id,
            intakeId: intake.id,
            customerOrganizationId,
            serviceOrganizationId: serviceOrganization.id,
          },
          transactionContext,
        );
        await this.repairRequestIntakeService.markConverted(
          { intakeId: intake.id, requestId: request.id },
          transactionContext,
        );

        // 首析投递意图与原稿/工单同事务登记：确定性 jobId（含代次）是
        // housekeeping 唯一的补投扫描锚点，回滚时三者一起回滚
        const analysisTraceId = randomUUID();
        await this.asyncTaskRecordService.recordEnqueued({
          data: {
            queueName: INTAKE_ANALYSIS_QUEUE_NAME,
            jobName: INTAKE_ANALYSIS_JOB_NAME,
            jobId: buildIntakeAnalysisJobId({
              intakeId: intake.id,
              generationNo: intake.analysisGeneration,
            }),
            traceId: analysisTraceId,
            actorAccountId: session.accountId,
            actorActiveRole: session.activeRole ?? undefined,
            bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
            bizKey: analysisTraceId,
            source: 'user_action',
            reason: 'enqueue_accepted',
            maxAttempts: INTAKE_ANALYSIS_MAX_ATTEMPTS,
          },
          transactionContext,
        });

        return {
          request,
          intake: {
            intakeId: intake.id,
            analysisStatus: intake.analysisStatus,
            analysisGeneration: intake.analysisGeneration,
          },
          replayed: false,
          analysisTraceId,
          analysisDelivery: null,
        };
      } catch (error) {
        // 预检查通过但撞唯一索引（并发写入同号）：重新生成编号重试；
        // 其他错误（落库故障等）不属于可重试情形，直接上抛
        if (!isDomainError(error) || error.code !== REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT) {
          throw error;
        }
        conflict = error;
      }
    }
    throw new DomainError(
      REPAIR_REQUEST_ERROR.CREATION_FAILED,
      '维修申请编号反复冲突，创建失败',
      { retryLimit: REQUEST_NO_RETRY_LIMIT },
      conflict,
    );
  }

  /**
   * 同标识重放：只核对、只读，不写任何行（含机型登记）。
   *
   * 核对项：归属账号、客户公司（由当前会话事实重读）、维修厂家、机型、错误码、
   * 故障描述、附件。任何一项不一致都按 CONFLICT 拒绝，且不返回原记录字段，
   * 避免借提交标识探测他人报修内容。
   *
   * 状态核验（PR #27 复审）：内容一致仍不直接返回原工单——在只读事务内按
   * 「工单行 → 原稿行」排他锁读核验两侧仍未删除且双向关联一致。删除与重放并发时，
   * 行锁使核验结论取自单一提交点：删除先提交则本读看到删除态（ORIGINAL_DELETED），
   * 本核验先提交则删除等待其结束，不靠非原子一致性读得出虚假成功。
   */
  private async replaySubmission(
    session: UsecaseSession,
    submission: NormalizedSubmission,
    existing: RepairRequestIntakeSnapshot,
  ): Promise<CreateRepairRequestResult> {
    if (existing.customerAccountId !== session.accountId) {
      throw new DomainError(REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT, '提交标识冲突，请重新提交');
    }

    const customerOrganizationId = await this.accountQueryService.findCustomerOrganizationId({
      accountId: session.accountId,
    });
    const modelMatches = await this.matchesExistingModel(submission.modelSelection, existing);
    const attachmentFileId = submission.attachment?.fileId ?? null;
    const contentMatches =
      customerOrganizationId !== null &&
      existing.customerOrganizationId === customerOrganizationId &&
      existing.serviceOrganizationId === submission.serviceOrganizationId &&
      existing.errorCode === submission.errorCode &&
      existing.faultDescription === submission.faultDescription &&
      existing.fileId === attachmentFileId &&
      modelMatches;

    if (!contentMatches) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.SUBMISSION_CONFLICT,
        '同一提交标识的内容与已提交记录不一致，请重新提交',
      );
    }

    if (existing.convertedRequestId === null) {
      // 原稿存在但唯一工单缺失（异常半态）：失败关闭，不返回拼接出来的工单
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修记录状态异常，请联系管理员处理',
        { recordUuid: existing.recordUuid },
      );
    }
    const convertedRequestId = existing.convertedRequestId;

    await this.transactionRunner.run((transactionContext) =>
      this.assertReplayStateValid(session, existing, convertedRequestId, transactionContext),
    );

    const request = await this.repairRequestService.findSnapshotById(convertedRequestId);
    if (!request || request.customerAccountId !== session.accountId) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修记录状态异常，请联系管理员处理',
        { recordUuid: existing.recordUuid },
      );
    }

    return {
      request,
      intake: {
        intakeId: existing.id,
        analysisStatus: existing.analysisStatus,
        analysisGeneration: existing.analysisGeneration,
      },
      replayed: true,
      // 同标识重放只读：不产生新投递意图（原投递由其自身账本行与 housekeeping 负责）
      analysisTraceId: null,
      analysisDelivery: null,
    };
  }

  /**
   * 重放状态核验（只读事务，无任何写入）。
   *
   * 锁顺序「工单行 → 原稿行」与删除链路（软删工单 → 软删原稿）一致，避免反向锁等待。
   * 任一核验失败都整体抛错结束重放：
   * - 工单或原稿已删除 → SUBMISSION_ORIGINAL_DELETED（客户端引导重新发起，不恢复旧工单、
   *   不重新登记机型、不重复投递首析）；
   * - 双向关联不一致（工单未指向本原稿 / 原稿转换列与工单侧不一致）或归属异常 →
   *   失败关闭 CREATION_FAILED，不返回任何原记录字段。
   */
  private async assertReplayStateValid(
    session: UsecaseSession,
    existing: RepairRequestIntakeSnapshot,
    convertedRequestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    const requestState = await this.repairRequestService.findReplayRequestStateForUpdate(
      convertedRequestId,
      transactionContext,
    );
    if (
      !requestState ||
      requestState.customerAccountId !== session.accountId ||
      requestState.intakeId !== existing.id
    ) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修记录状态异常，请联系管理员处理',
        { recordUuid: existing.recordUuid },
      );
    }
    if (requestState.deprecated) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.SUBMISSION_ORIGINAL_DELETED,
        '原申请已删除，请重新发起维修申请',
        { recordUuid: existing.recordUuid },
      );
    }

    const intakeState = await this.repairRequestIntakeService.findReplayIntakeStateForUpdate(
      existing.recordUuid,
      transactionContext,
    );
    if (
      !intakeState ||
      intakeState.customerAccountId !== session.accountId ||
      intakeState.convertedRequestId !== existing.convertedRequestId
    ) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.CREATION_FAILED,
        '报修记录状态异常，请联系管理员处理',
        { recordUuid: existing.recordUuid },
      );
    }
    if (intakeState.deleted) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.SUBMISSION_ORIGINAL_DELETED,
        '原申请已删除，请重新发起维修申请',
        { recordUuid: existing.recordUuid },
      );
    }
  }

  /** 重放核对：机型选择是否与落库机型一致（手填文本按编码只读比对，不登记） */
  private async matchesExistingModel(
    selection: NormalizedModelSelection,
    existing: RepairRequestIntakeSnapshot,
  ): Promise<boolean> {
    if (selection.kind === 'EXISTING') {
      return existing.equipmentModelId === selection.equipmentModelId;
    }
    const model = await this.equipmentModelQueryService.findModelByCode({
      modelCode: selection.modelText,
    });
    return model !== null && model.id === existing.equipmentModelId;
  }

  /**
   * 机型决策：已有项复核启用；手填按编码查重（含停用行）后登记。
   *
   * 并发登记同一编码时唯一索引先提交，本事务的插入撞唯一键后在同一事务内
   * 重读胜出方（排他锁读能看到最新已提交版本），不重复登记。
   */
  private async resolveModel(
    selection: NormalizedModelSelection,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EquipmentModelDetailSnapshot> {
    if (selection.kind === 'EXISTING') {
      const model = await this.equipmentModelQueryService.findModelById({
        id: selection.equipmentModelId,
        transactionContext,
      });
      if (!model) {
        throw new DomainError(REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND, '设备型号不存在', {
          equipmentModelId: selection.equipmentModelId,
        });
      }
      if (!model.enabled) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED,
          '设备型号已停用，无法提交维修申请',
          { equipmentModelId: model.id, modelCode: model.modelCode },
        );
      }
      return model;
    }

    const modelCode = selection.modelText;
    const existing = await this.equipmentModelService.findForWriteByModelCode({
      modelCode,
      transactionContext,
    });
    if (existing) {
      if (!existing.enabled) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED,
          '该机型已停用，无法提交维修申请，请联系管理员',
          { modelCode: existing.modelCode },
        );
      }
      return existing;
    }

    try {
      return await this.equipmentModelService.insertModel(
        { modelCode, modelName: modelCode },
        transactionContext,
      );
    } catch (error) {
      if (
        !isDomainError(error) ||
        error.code !== REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_REGISTRATION_CONFLICT
      ) {
        throw error;
      }
      const winner = await this.equipmentModelService.findForWriteByModelCode({
        modelCode,
        transactionContext,
      });
      if (!winner) {
        throw error;
      }
      if (!winner.enabled) {
        throw new DomainError(
          REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED,
          '该机型已停用，无法提交维修申请，请联系管理员',
          { modelCode: winner.modelCode },
        );
      }
      return winner;
    }
  }

  /**
   * 输入归一：全部判定在开事务前完成，失败零落库。
   *
   * 机型二选一：同时给或都不给都拒绝，避免「选了已有项又用手填文本绕过校验」；
   * 附件：fileId 与 uploadContextId 必须成对出现，否则拒绝。
   */
  private normalizeSubmission(command: CreateRepairRequestCommand): NormalizedSubmission {
    const recordUuid = normalizeRecordUuid(command.recordUuid);
    const serviceOrganizationId = normalizePositiveId(
      command.serviceOrganizationId,
      '维修厂家',
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
    );
    const modelSelection = normalizeModelSelection(command);
    const errorCode = normalizeRequiredText(command.errorCode, { fieldName: '错误码' });
    if (errorCode.length > ERROR_CODE_MAX_LENGTH) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.INVALID_PARAMS,
        `错误码不能超过 ${ERROR_CODE_MAX_LENGTH} 个字符`,
        { errorCodeLength: errorCode.length },
      );
    }

    const faultDescription = normalizeRequiredText(command.faultDescription, {
      fieldName: '故障描述',
    });
    if (faultDescription.length > FAULT_DESCRIPTION_MAX_LENGTH) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.INVALID_PARAMS,
        `故障描述不能超过 ${FAULT_DESCRIPTION_MAX_LENGTH} 个字符`,
        { faultDescriptionLength: faultDescription.length },
      );
    }

    return {
      recordUuid,
      serviceOrganizationId,
      modelSelection,
      errorCode,
      faultDescription,
      attachment: normalizeAttachment(command.attachment),
    };
  }

  /**
   * 角色兜底决策：仅客户可提交
   * 守卫层已按 @Roles 拦截，此处兜底防止守卫被绕过或角色数据漂移；
   * 角色集合来自可信 JWT（`mapJwtToUsecaseSession` 已大写归一），不读客户端声明。
   */
  private assertCustomerRole(session: UsecaseSession): void {
    if (!session.roles.includes(IdentityTypeEnum.CUSTOMER)) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅客户账号可以提交维修申请',
        { roles: session.roles },
      );
    }
  }

  /**
   * 生成唯一申请编号：撞号时重新生成，超过重试上限视为系统异常
   */
  private async generateUniqueRequestNo(
    transactionContext: PersistenceTransactionContext,
  ): Promise<string> {
    for (let attempt = 0; attempt < REQUEST_NO_RETRY_LIMIT; attempt += 1) {
      const candidate = generateRequestNo(new Date());
      const exists = await this.repairRequestService.requestNoExists(candidate, transactionContext);
      if (!exists) {
        return candidate;
      }
    }
    throw new DomainError(REPAIR_REQUEST_ERROR.CREATION_FAILED, '维修申请编号生成失败', {
      retryLimit: REQUEST_NO_RETRY_LIMIT,
    });
  }
}

/** 提交标识归一：小写 UUID（与 char(36) 列一致，大小写不影响幂等语义） */
function normalizeRecordUuid(input: unknown): string {
  const trimmed = normalizeOptionalText(input, 'to_null', { fieldName: '提交标识' });
  if (trimmed === null || trimmed === undefined) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.SUBMISSION_KEY_INVALID,
      '提交标识缺失，请重新打开报修页后提交',
    );
  }
  const normalized = trimmed.toLowerCase();
  if (!RECORD_UUID_PATTERN.test(normalized)) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.SUBMISSION_KEY_INVALID,
      '提交标识格式不合法，请重新打开报修页后提交',
    );
  }
  return normalized;
}

function normalizePositiveId(input: unknown, fieldName: string, errorCode: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new DomainError(errorCode, `${fieldName} ID 无效`);
  }
  return input;
}

/**
 * 机型二选一归一：手填文本做空白折叠（去首尾、连续空白收为单空格），
 * 折叠后为空或超长一律拒绝；选择已有项时忽略手填文本的空白差异但不接受两者并存。
 */
function normalizeModelSelection(command: CreateRepairRequestCommand): NormalizedModelSelection {
  const rawModelId = command.equipmentModelId;
  const hasModelId = rawModelId !== undefined && rawModelId !== null;
  const rawText = command.equipmentModelText;
  const hasModelText = normalizeOptionalText(rawText, 'to_null', { fieldName: '设备型号' }) != null;

  if (hasModelId === hasModelText) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID,
      '请选择已有设备型号或填写新机型，二者必须且只能填一项',
    );
  }

  if (hasModelId) {
    return {
      kind: 'EXISTING',
      equipmentModelId: normalizePositiveId(
        rawModelId,
        '设备型号',
        REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID,
      ),
    };
  }

  // 连续空白折叠为单空格：先按统一 policy 去首尾空格，再折叠内部空白
  const modelText = (normalizeOptionalText(rawText, 'to_null') ?? '').replace(/\s+/g, ' ');
  if (modelText.length > MANUAL_MODEL_TEXT_MAX_LENGTH) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_INPUT_INVALID,
      `手填机型不能超过 ${MANUAL_MODEL_TEXT_MAX_LENGTH} 个字符`,
      { modelTextLength: modelText.length },
    );
  }
  return { kind: 'MANUAL', modelText };
}

/** 附件归一：文件编号与上传上下文必须成对出现，格式非法按输入错误拒绝 */
function normalizeAttachment(
  input: CreateRepairRequestAttachmentInput | null | undefined,
): CreateRepairRequestAttachmentInput | null {
  if (input === undefined || input === null) {
    return null;
  }
  const fileId = normalizeStoredFileId(input.fileId);
  const uploadContextId = normalizeUploadContextId(input.uploadContextId);
  if (!fileId || !uploadContextId) {
    throw new DomainError(
      REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      '原件引用不完整或格式不合法，请重新上传',
    );
  }
  return { fileId, uploadContextId };
}

/**
 * 生成申请编号：RR + 年月日时分秒 + 6 位随机后缀（总长远小于表列长 50）
 * 随机后缀使用加密随机源（非 Math.random），降低同秒高并发下的撞号概率
 */
function generateRequestNo(now: Date): string {
  const datePart = [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds()),
  ].join('');
  const randomPart = randomInt(36 ** 6)
    .toString(36)
    .padStart(6, '0')
    .toUpperCase();
  return `RR${datePart}${randomPart}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 组装维修申请的结构化内容（后端生成，客户端不可传入）
 */
function buildRepairRequestContentMd(params: {
  requestNo: string;
  model: EquipmentModelDetailSnapshot;
  errorCode: string;
  faultDescription: string;
}): string {
  return [
    '# 设备维修申请',
    '',
    `- 申请编号：${params.requestNo}`,
    `- 设备型号：${params.model.modelCode}（${params.model.modelName}）`,
    `- 错误码：${params.errorCode}`,
    '',
    '## 故障描述',
    '',
    params.faultDescription,
    '',
  ].join('\n');
}
