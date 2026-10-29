// src/usecases/repair-request/create-repair-request.usecase.ts

import { randomInt } from 'node:crypto';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  DomainError,
  isDomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import { normalizeRequiredText } from '@core/common/input-normalize/input-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import { EquipmentModelDetailSnapshot } from '@src/modules/lithography/lithography.types';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  CreateRepairRequestCommand,
  CreateRepairRequestResult,
} from './create-repair-request.types';

/** 错误码长度上限（与 equipment_model / repair_request 表列长一致） */
const ERROR_CODE_MAX_LENGTH = 100;

/** 故障描述长度上限（与 GraphQL DTO 一致；长度语义由 Usecase 判定，避免其他 adapter 绕过 DTO 后丢失约束） */
const FAULT_DESCRIPTION_MAX_LENGTH = 5000;

/** 申请编号重试上限（预检查与落库撞号重试共用） */
const REQUEST_NO_RETRY_LIMIT = 3;

/**
 * 创建维修申请用例
 *
 * 业务流程：
 * 1. 角色决策：仅 CUSTOMER 可提交（ENGINEER / SUPER_ADMIN 拒绝，兜底守卫误放）
 * 2. 输入决策：错误码、故障描述空白即拒绝；错误码、故障描述超长拒绝
 * 3. 事务内校验设备型号存在且启用（排他锁读，防并发停用）
 * 4. 事务内生成唯一申请编号，组装 contentMd 并落库；
 *    唯一索引撞号（预检查无法感知的并发写入）时重新生成编号重试整段流程
 *
 * customerAccountId 仅取自会话（JWT），客户端不可传入
 */
@Injectable()
export class CreateRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行创建维修申请流程
   *
   * @param command 创建命令（含会话身份快照）
   * @returns 写入完成后的维修申请快照
   */
  async execute(command: CreateRepairRequestCommand): Promise<CreateRepairRequestResult> {
    this.assertCustomerRole(command.session.accessGroup);

    if (!Number.isInteger(command.equipmentModelId) || command.equipmentModelId <= 0) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '设备型号 ID 无效', {
        equipmentModelId: command.equipmentModelId,
      });
    }

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

    return this.transactionRunner.run((transactionContext) =>
      this.doCreate(command, errorCode, faultDescription, transactionContext),
    );
  }

  /**
   * 事务内执行：型号校验 → 编号生成 → 内容组装 → 落库
   */
  private async doCreate(
    command: CreateRepairRequestCommand,
    errorCode: string,
    faultDescription: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<CreateRepairRequestResult> {
    const model = await this.equipmentModelQueryService.findModelById({
      id: command.equipmentModelId,
      transactionContext,
    });
    if (!model) {
      throw new DomainError(REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND, '设备型号不存在', {
        equipmentModelId: command.equipmentModelId,
      });
    }
    if (!model.enabled) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED,
        '设备型号已停用，无法提交维修申请',
        { equipmentModelId: model.id, modelCode: model.modelCode },
      );
    }

    // 组织归属：自注册客户可能无有效组织，此时保持 NULL（仅本人可见的存量兼容语义），
    // 不按 company_name/厂家猜测；有可信成员关系时必须写入真实组织。
    const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });

    let conflict: DomainError | undefined;
    for (let attempt = 0; attempt < REQUEST_NO_RETRY_LIMIT; attempt += 1) {
      const requestNo = await this.generateUniqueRequestNo(transactionContext);
      const contentMd = buildRepairRequestContentMd({
        requestNo,
        model,
        errorCode,
        faultDescription,
      });
      try {
        return await this.repairRequestService.insertRequest(
          {
            requestNo,
            customerAccountId: command.session.accountId,
            equipmentModelId: model.id,
            errorCode,
            faultDescription,
            contentMd,
            ownerOrganizationId: organizationFact?.organizationId ?? null,
          },
          transactionContext,
        );
      } catch (error) {
        // 预检查通过但撞唯一索引（并发写入同号）：重新生成编号重试整段流程；
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
   * 角色兜底决策：仅客户可提交
   * 守卫层已按 @Roles 拦截，此处兜底防止守卫被绕过或角色数据漂移；
   * 角色匹配口径与 RolesGuard 对齐（仅小写归一，不手写 trim，JWT 角色串不携带首尾空白）
   */
  private assertCustomerRole(accessGroup: readonly string[]): void {
    const requiredRole = IdentityTypeEnum.CUSTOMER.toLowerCase();
    const isCustomer = accessGroup.some(
      (role) => typeof role === 'string' && role.toLowerCase() === requiredRole,
    );
    if (!isCustomer) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅客户账号可以提交维修申请',
        { accessGroup: [...accessGroup] },
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
