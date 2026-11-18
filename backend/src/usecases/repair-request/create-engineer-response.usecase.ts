// src/usecases/repair-request/create-engineer-response.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { isRepairRequestEnded } from '@core/repair-request/policy/repair-process-write.policy';
import {
  normalizeEnumValue,
  normalizeRequiredText,
} from '@core/common/input-normalize/input-normalize.policy';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EngineerResponseService } from '@src/modules/lithography/engineer-response.service';
import type { EngineerResponseWriteSnapshot } from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  CreateEngineerResponseCommand,
  CreateEngineerResponseResult,
} from './create-engineer-response.types';
import { resolveEngineerNickname, toEngineerResponseView } from './enrich-repair-request-nicknames';
import { assertEngineerWritePermission } from './engineer-write-permission';
import { assertRepairRequestId } from './assert-repair-request-id';
import { assertEngineerResponseTextCapacity } from './assert-engineer-response-text-capacity';

/** 处理状态唯一值域（单一运行时真源：src/types 正式领域 enum） */
const ENGINEER_RESOLUTION_STATUSES = Object.values(EngineerResolutionStatus);

/**
 * 工程师追加处理回复用例
 *
 * 业务流程：
 * 1. 回复写权限在本用例内执行（参数校验与事务之前）：
 *    仅 roles 含 ENGINEER 且可信 JWT activeRole 精确为 ENGINEER 可回复；
 *    守卫层只做入口粗粒度准入（按 accessGroup），混合角色账号
 *    （如 SUPER_ADMIN + ENGINEER）以 activeRole=SUPER_ADMIN 进入时在此被拒绝；
 *    读权限继承不等于写权限继承；activeRole 缺失或异常值一律拒绝（失败关闭）
 * 2. 输入语义：正文经 normalizeRequiredText 收敛（trim 后为空即拒绝），
 *    处理状态经 normalizeEnumValue 按唯一值域校验（大小写不做猜测性修复）
 * 3. 事务前读取当前工程师安全昵称（缺失回落「工程师」），
 *    使昵称读取失败不会发生在回复提交之后（避免「已写入但输出失败」的不确定窗口）
 * 4. 同一事务内：pessimistic_write 锁定回复目标 → 按状态事实裁决回复资格 →
 *    追加一条回复（不更新历史回复）；目标行锁保证「资格检查」与「写入」原子
 * 5. 事务提交后仅组合事务内返回的写入快照与事务前昵称为既有稳定读视图，
 *    不再执行任何整份详情读取，杜绝「回复已提交但事务外读取失败」的额外不确定窗口
 *
 * 归属派生：engineerAccountId 仅取自可信 Session，customerAccountId 仅从目标申请派生，
 * 客户端不可传入任何归属账号 ID
 */
@Injectable()
export class CreateEngineerResponseUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly engineerResponseService: EngineerResponseService,
    private readonly accountQueryService: AccountQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行工程师追加回复流程
   *
   * @param command 回复命令（含会话身份快照与原始输入）
   * @returns 本次新建回复的稳定读视图（供 adapter 薄映射为既有回复 DTO）
   */
  async execute(command: CreateEngineerResponseCommand): Promise<CreateEngineerResponseResult> {
    // 工程师精确写权限与 ID 结构校验为接单/回复等写用例共用断言（单一实现）
    assertEngineerWritePermission(command.session, '回复');
    assertRepairRequestId(command.requestId);

    const responseText = normalizeRequiredText(command.responseText, { fieldName: '回复正文' });
    // 容量保护：MySQL TEXT 上限 65,535 UTF-8 字节，对 trim 后正文计量，
    // 超限在读昵称/查询申请/开启事务/调用写服务之前拒绝，不产生回复记录
    assertEngineerResponseTextCapacity(responseText);
    const resolutionStatus = normalizeEnumValue(
      command.resolutionStatus,
      ENGINEER_RESOLUTION_STATUSES,
      {
        fieldName: '处理状态',
      },
    );

    // 事务前读取安全昵称：昵称读取失败发生在提交之前，不会出现「已写入但输出失败」
    const engineerNickname = await resolveEngineerNickname(
      this.accountQueryService,
      command.session.accountId,
    );

    const writeSnapshot = await this.transactionRunner.run((transactionContext) =>
      this.doCreateResponse(command, responseText, resolutionStatus, transactionContext),
    );

    // 事务提交后仅组合内存数据为稳定视图，不执行任何数据库读取
    return toEngineerResponseView(writeSnapshot, engineerNickname);
  }

  /**
   * 事务内执行：锁定目标 → 资格裁决 → 追加回复
   *
   * 错误口径（与 Plan 错误语义一致）：
   * - 不存在 / 已删除 / 已由其他工程师接单：统一不可访问（NOT_FOUND），不泄露归属
   * - 存在但尚未接单：业务状态冲突（NOT_ACCEPTED → CONFLICT），提示先接单后回复
   * - 两者判断顺序：先未接单（AVAILABLE 列表可见，提示先接单无泄漏风险），
   *   再判断接单人是否本人（非本人一律不可访问，不泄露他人接单状态）
   */
  private async doCreateResponse(
    command: CreateEngineerResponseCommand,
    responseText: string,
    resolutionStatus: EngineerResolutionStatus,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EngineerResponseWriteSnapshot> {
    // 1. 组织范围：只认工单与报修 intake 一致的可信服务公司，且必须与工程师可信组织一致。
    //    intake 缺失、服务公司缺失或两处冲突一律不可访问，不按旧 owner/客户公司/接单人兜底。
    const organizationFact = await this.trustedOrganizationContext.resolveForAccount({
      accountId: command.session.accountId,
      transactionContext,
    });
    // 2. 锁定并读取回复目标最小快照（同一事务内后续写入受同一行锁保护）
    const target = await this.repairRequestService.findResponseTargetForUpdate(
      command.requestId,
      transactionContext,
    );
    // 3. 不存在、已删除或不在本人可信服务范围内：统一不可访问结果
    if (
      !target ||
      target.deprecated ||
      target.serviceOrganizationId === null ||
      target.serviceOrganizationId !== organizationFact.organizationId
    ) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可访问', {
        requestId: command.requestId,
      });
    }
    // 4. 未接单：业务状态冲突，提示先接单后回复
    if (!target.isAccepted) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_ACCEPTED, '维修申请尚未接单，请先接单后回复', {
        requestId: command.requestId,
      });
    }
    // 5. 接单工程师不是当前账号：统一不可访问结果，不泄露他人接单状态
    if (target.acceptedByEngineerAccountId !== command.session.accountId) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可访问', {
        requestId: command.requestId,
      });
    }
    // 6. 工单已结单/处理已终结：回复只读（结单与回复独立，但结单后两者均只读）
    if (isRepairRequestEnded(target)) {
      throw new DomainError(REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT, '工单已结单，回复只读', {
        requestId: command.requestId,
      });
    }
    // 6. 归属派生并追加回复：engineerAccountId 仅取自可信 Session，
    // customerAccountId 仅取自申请快照；返回事务内写入快照
    return this.engineerResponseService.insertResponse(
      {
        requestId: command.requestId,
        engineerAccountId: command.session.accountId,
        customerAccountId: target.customerAccountId,
        resolutionStatus,
        responseText,
      },
      transactionContext,
    );
  }
}
