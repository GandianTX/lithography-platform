// src/usecases/repair-request/accept-repair-request.usecase.ts

import { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { RepairRequestEngineerDetailView } from '@src/modules/lithography/lithography.types';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { assertRepairRequestId } from './assert-repair-request-id';
import { GetEngineerRepairRequestDetailUsecase } from './get-engineer-repair-request-detail.usecase';
import { assertEngineerWritePermission } from './engineer-write-permission';

/**
 * 工程师接单用例
 *
 * 业务流程：
 * 1. 接单权限作为业务规则在本用例内执行（参数校验与事务之前）：
 *    仅 roles 含 ENGINEER 且可信 JWT activeRole 精确为 ENGINEER 可接单。
 *    守卫层只做入口粗粒度准入（按 accessGroup），混合角色账号
 *    （如 SUPER_ADMIN + ENGINEER）以 activeRole=SUPER_ADMIN 进入时在此被拒绝；
 *    SUPER_ADMIN 的既有读权限继承语义不受影响（读权限继承不等于写权限继承）
 * 2. 组织范围：接单要求工单具备可信组织归属且与工程师当前组织一致；
 *    无归属存量工单一律按 NOT_FOUND 处理，不因组织列缺失向全体工程师开放
 * 3. 事务内原子条件更新：未删除且未接单才可写入，竞争时仅一方成功
 * 4. 未命中（affected = 0）时按最小状态读取裁决错误类别：
 *    不存在/已删除 → NOT_FOUND；已接单 → CONFLICT
 * 5. 接单成功后复用现有工程师详情读链路返回更新后的详情
 *    （读权限判定、视角状态与客户/接单工程师昵称富集不重复实现）
 *
 * 接单人（engineerAccountId）仅取自后端 Session，接单时间（acceptedAt）
 * 仅取后端系统事件时间，两者均不接受客户端传入
 */
@Injectable()
export class AcceptRepairRequestUsecase {
  constructor(
    private readonly repairRequestService: RepairRequestService,
    private readonly getEngineerRepairRequestDetailUsecase: GetEngineerRepairRequestDetailUsecase,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行接单流程
   *
   * @param params requestId 与当前会话身份快照
   * @returns 接单成功后的工程师详情视图（与工程师详情 Query 同一稳定读模型，
   *   视角状态为 MINE，客户/接单工程师展示资料已富集）
   */
  async execute(params: {
    requestId: number;
    session: UsecaseSession;
  }): Promise<RepairRequestEngineerDetailView> {
    // 工程师精确写权限与 ID 结构校验为接单/回复等写用例共用断言（单一实现）
    assertEngineerWritePermission(params.session, '接单');
    assertRepairRequestId(params.requestId);

    await this.transactionRunner.run(async (transactionContext) => {
      // 组织范围：接单必须基于可信归属事实。已归属工单仅本组织工程师可接单；
      // 无归属存量工单不因组织列缺失而向全体工程师开放，统一按不可接单处理
      // （归入归属异常清单，由维护者显式处置，不以放宽权限掩盖归属缺失）。
      const ownerOrganizationId = await this.repairRequestService.findOwnerOrganizationId(
        params.requestId,
        transactionContext,
      );
      if (ownerOrganizationId === undefined || ownerOrganizationId === null) {
        throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可接单', {
          requestId: params.requestId,
        });
      }
      const organizationFact = await this.organizationContextQueryService.tryResolveForAccount({
        accountId: params.session.accountId,
        transactionContext,
      });
      if (!organizationFact || organizationFact.organizationId !== ownerOrganizationId) {
        throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或不可接单', {
          requestId: params.requestId,
        });
      }

      // acceptedAt 使用后端系统事件时间，客户端不可传入
      const writeResult = await this.repairRequestService.acceptRequest(
        {
          requestId: params.requestId,
          engineerAccountId: params.session.accountId,
          acceptedAt: new Date(),
        },
        transactionContext,
      );
      if (writeResult.affected !== 1) {
        await this.rejectAcceptMiss(params.requestId, transactionContext);
      }
    });

    // 写后读复用现有工程师详情读链路（含细粒度读权限与昵称富集），
    // 不在本用例复制权限判断或装配逻辑
    return this.getEngineerRepairRequestDetailUsecase.execute({
      requestId: params.requestId,
      session: params.session,
    });
  }

  /**
   * 条件更新未命中裁决（同事务内最小状态读取）：
   * - 不存在或已删除：对外 NOT_FOUND；
   * - 已接单：对外 CONFLICT（业务细节码 REPAIR_REQUEST_ALREADY_ACCEPTED）；
   *   最小快照不读接单人，无法区分本人重复接单与他人接单，
   *   文案中性，不泄漏接单工程师身份；
   * - 两者皆否属不应出现的状态，按系统失败上报
   */
  private async rejectAcceptMiss(
    requestId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<never> {
    const status = await this.repairRequestService.findAcceptanceStatus(
      requestId,
      transactionContext,
    );
    if (!status || status.deprecated) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '维修申请不存在或已删除', {
        requestId,
      });
    }
    if (status.isAccepted) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED,
        '维修申请已被接单，请刷新后查看最新状态',
        {
          requestId,
        },
      );
    }
    throw new DomainError(REPAIR_REQUEST_ERROR.ACCEPT_FAILED, '维修申请接单失败，请稍后重试', {
      requestId,
    });
  }
}
