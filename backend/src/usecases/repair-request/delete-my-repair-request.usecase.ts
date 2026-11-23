// src/usecases/repair-request/delete-my-repair-request.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  buildIntakeAnalysisJobId,
  INTAKE_ANALYSIS_QUEUE_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import { RepairRequestIntakeService } from '@src/modules/lithography/repair-request-intake.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  DeleteMyRepairRequestCommand,
  DeleteMyRepairRequestResult,
} from './delete-my-repair-request.types';

/**
 * 删除维修申请用例（客户软删除自己的未接单申请）
 *
 * 业务流程：
 * 1. 角色决策：仅真实 CUSTOMER 可删除；SUPER_ADMIN 不能以客户身份删除
 *    （负责人 20260901 裁定 2），守卫仅放行 @Roles(CUSTOMER)，此处兜底
 * 2. 输入决策：requestId 必须为正整数
 * 3. 事务内原子条件软删除（接单/删除互斥由条件更新保证，不用「先查询再普通 update」）；
 *    条件未命中时按写服务重读的状态事实区分拒绝原因
 * 4. 结果映射（裁定 5）：不存在/非本人统一 NOT_FOUND（防探测他人申请存在性）；
 *    已接单 CONFLICT + REPAIR_REQUEST_ALREADY_ACCEPTED；本人重复删除幂等成功
 *
 * customerAccountId 仅取自会话（JWT），客户端不可传入
 */
@Injectable()
export class DeleteMyRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly repairRequestIntakeService: RepairRequestIntakeService,
    private readonly localWriteHoldService: LocalWriteHoldService,
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行删除维修申请流程
   *
   * @param command 删除命令（含会话身份快照）
   * @returns 删除完成后的申请标识（重复删除幂等成功返回同形状结果）
   */
  async execute(command: DeleteMyRepairRequestCommand): Promise<DeleteMyRepairRequestResult> {
    this.assertCustomerRole(command.session.roles);

    if (!Number.isInteger(command.requestId) || command.requestId <= 0) {
      throw new DomainError(REPAIR_REQUEST_ERROR.INVALID_PARAMS, '维修申请 ID 无效', {
        requestId: command.requestId,
      });
    }

    return this.transactionRunner.run((transactionContext) =>
      this.doDelete(command, transactionContext),
    );
  }

  /**
   * 事务内执行：原子条件软删除 → 按状态事实映射结果
   */
  private async doDelete(
    command: DeleteMyRepairRequestCommand,
    transactionContext: PersistenceTransactionContext,
  ): Promise<DeleteMyRepairRequestResult> {
    // 恢复期写入冻结：该公司数据区正在恢复时不得软删申请（写入会被整体替换掉）
    const snapshot = await this.repairRequestService.findSnapshotById(
      command.requestId,
      transactionContext,
    );
    await this.localWriteHoldService.assertBusinessWritable({
      organizationId: snapshot?.ownerOrganizationId ?? null,
    });

    const outcome = await this.repairRequestService.softDeleteRequest(
      { requestId: command.requestId, customerAccountId: command.session.accountId },
      transactionContext,
    );

    switch (outcome.kind) {
      case 'DELETED':
      case 'ALREADY_DELETED':
        // 同一事务内收尾原稿与首析投递：原稿一起进入删除态；尚未执行的
        // intake-analysis 账本行（两个代次）条件取消。迟到分析被写回侧的
        // deleted_at / REJECTED 核验拒绝，不会让已删除报修复活。
        await this.cancelIntakeDelivery(command.requestId, transactionContext);
        // 幂等成功（裁定 5）：本人重复删除返回与首次删除一致的结果
        return { id: outcome.id, requestNo: outcome.requestNo };
      case 'NOT_FOUND_OR_NOT_OWNER':
        // 不存在与非本人统一拒绝，不泄露他人申请存在性（裁定 5）
        throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可删除', {
          id: outcome.id,
        });
      case 'ALREADY_ACCEPTED':
        // 已接单与删除互斥，明确告知原因（裁定 5）
        throw new DomainError(REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED, '已接单的维修申请不能删除', {
          id: outcome.id,
          requestNo: outcome.requestNo,
        });
    }
  }

  /**
   * 删除事务内同步处理首析关联：
   * - 原稿软删（条件更新，幂等）；
   * - 取消该原稿两个代次的未执行投递账本行（仅 queued/processing 可取消）。
   * 不物理删除附件，也不改首析尝试行历史。
   */
  private async cancelIntakeDelivery(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<void> {
    await this.repairRequestIntakeService.markDeletedByRequestId({ requestId }, transactionContext);
    const request = await this.repairRequestService.findSnapshotById(requestId, transactionContext);
    const intakeId = request?.intakeId ?? null;
    if (intakeId === null) {
      // 旧工单没有原稿关联：没有首析投递需要取消
      return;
    }
    await this.asyncTaskRecordService.cancelActiveByQueueJobIds({
      queueName: INTAKE_ANALYSIS_QUEUE_NAME,
      jobIds: [0, 1].map((generationNo) => buildIntakeAnalysisJobId({ intakeId, generationNo })),
      reason: 'intake_cancelled_by_request_deletion',
      transactionContext,
    });
  }

  /**
   * 角色兜底决策：仅客户可删除，SUPER_ADMIN 不放行（裁定 2）
   * 守卫层 @Roles(CUSTOMER) 已拦截，此处兜底防止守卫被绕过或角色数据漂移；
   * session.roles 已在 adapter 边界（mapJwtToUsecaseSession）归一化为大写，
   * 此处仅做精确匹配，不重复归一化（禁止 hasRole 层级展开——超管不继承删除能力）
   */
  private assertCustomerRole(roles: readonly string[]): void {
    // String() 取枚举字面值与归一化角色串精确匹配
    const requiredRole = String(IdentityTypeEnum.CUSTOMER);
    if (!roles.includes(requiredRole)) {
      throw new DomainError(
        PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        '仅客户账号可以删除维修申请',
        { roles: [...roles] },
      );
    }
  }
}
