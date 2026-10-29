// src/modules/lithography/queries/trusted-organization-context.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, ORGANIZATION_ERROR } from '@core/common/errors/domain-error';
import { resolveSingletonOrganizationContext } from '@core/organization/policy/organization-context.policy';
import { Injectable } from '@nestjs/common';
import { OrganizationMembershipFact } from '../organization.types';
import { OrganizationMembershipQueryService } from './organization-membership.query.service';

/**
 * 可信组织上下文解析（A-PR0 计划 §2.1/§2.2）——读侧组织校验的唯一入口。
 *
 * 唯一职责：同域只读组合成员事实（OrganizationMembershipQueryService，成员 ACTIVE
 * 且组织 ACTIVE）与 core 决议策略，解析当前账号的单一组织上下文。
 * 前端自报的 `ownerOrganizationId`、账号 `company_name`、客户端角色名称一律不参与。
 *
 * 决议口径（core policy `resolveSingletonOrganizationContext`）：
 * - 无有效成员关系 → `ORGANIZATION_NO_ACTIVE_MEMBERSHIP`（对外 FORBIDDEN）；
 * - 多个有效关系 → `ORGANIZATION_AMBIGUOUS_MEMBERSHIP`（对外 FORBIDDEN，
 *   拒绝歧义请求，不回退全库；本期不提供组织选择 UI）；
 * - 恰有一条 → 返回事实（含 organizationId / memberRole，供用例继续裁决）。
 *
 * 读侧校验错误口径在此收敛（queryservice 规则：细粒度授权/读侧校验归 QueryService），
 * 供各 usecase 复用同一事实口径（S2b 参考资料组织范围、S2c 账号创建绑定、
 * S3+ 投稿用例）；组织上下文必须由此解析，不得由客户端传入。
 */
@Injectable()
export class TrustedOrganizationContextQueryService {
  constructor(private readonly membershipQueryService: OrganizationMembershipQueryService) {}

  /**
   * 解析账号的当前可信组织上下文。
   *
   * @param params.accountId 账号 ID（必须来自可信 Session）
   * @param params.transactionContext 可选事务上下文（写用例在同一事务连接上读最新成员事实）
   * @returns 单一有效成员关系事实
   */
  async resolveForAccount(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationMembershipFact> {
    const facts = await this.membershipQueryService.listActiveMembershipsByAccount(params);
    const resolution = resolveSingletonOrganizationContext(facts);
    switch (resolution.kind) {
      case 'RESOLVED':
        return resolution.fact;
      case 'NO_ACTIVE_MEMBERSHIP':
        throw new DomainError(
          ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
          '当前账号没有有效组织成员关系，无法执行组织范围操作',
        );
      case 'AMBIGUOUS_MEMBERSHIP':
        throw new DomainError(
          ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
          '当前账号存在多个有效组织成员关系，无法确定组织范围',
        );
    }
  }

  /**
   * 可选组织解析：用于「无组织归属也可成立」的存量兼容写入路径
   * （如客户自注册账号创建本人工单）。
   *
   * - 恰有一条 → 返回事实；
   * - 无有效关系 → 返回 null（不伪造组织，也不授予组织范围权限）；
   * - 多条关系 → 仍视为异常，抛出 `ORGANIZATION_AMBIGUOUS_MEMBERSHIP`。
   */
  async tryResolveForAccount(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<OrganizationMembershipFact | null> {
    const facts = await this.membershipQueryService.listActiveMembershipsByAccount(params);
    const resolution = resolveSingletonOrganizationContext(facts);
    switch (resolution.kind) {
      case 'RESOLVED':
        return resolution.fact;
      case 'NO_ACTIVE_MEMBERSHIP':
        return null;
      case 'AMBIGUOUS_MEMBERSHIP':
        throw new DomainError(
          ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
          '当前账号存在多个有效组织成员关系，无法确定组织范围',
        );
    }
  }
}
