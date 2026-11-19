// src/usecases/admin-document-database/get-admin-repair-request-revision-detail.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminRepairRequestRevisionDetailView } from '@src/modules/lithography/admin-document-database.types';
import { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { assertAdminDocumentDatabasePermission } from './admin-document-database-permission';
import { assertPositiveId } from './admin-document-database-filter.normalize';
import { resolveAdminOrganizationScope } from './admin-organization-scope';

/** 修订人昵称缺失时的统一回落 */
const ADMIN_ENGINEER_NICKNAME_FALLBACK = '工程师';

/**
 * 管理员查看单个修订版本 / 对比上一版（只读）。
 *
 * - 精确授权：activeRole === SUPER_ADMIN（失败关闭）；
 * - 组织范围复用既有管理员工单口径：一级跨公司、二级仅本公司；
 * - 只返回该修订自身保存的前后快照；旧快照缺维修区块时明确返回不可比原因；
 * - 不提供版本回滚，也不以当前工单数据补齐历史快照。
 */
@Injectable()
export class GetAdminRepairRequestRevisionDetailUsecase {
  constructor(
    private readonly adminRepairRequestQueryService: AdminRepairRequestQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
  ) {}

  async execute(params: {
    session: UsecaseSession;
    requestId: number;
    revisionNo: number;
  }): Promise<AdminRepairRequestRevisionDetailView> {
    assertAdminDocumentDatabasePermission(params.session, '查看工单修订历史');
    assertPositiveId(params.requestId, '维修申请 ID', 'requestId');
    assertPositiveId(params.revisionNo, '修订版本号', 'revisionNo');
    const organizationScope = await resolveAdminOrganizationScope({
      session: params.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const result = await this.adminRepairRequestQueryService.findRevisionDetail({
      requestId: params.requestId,
      revisionNo: params.revisionNo,
      organizationId: organizationScope.organizationId,
    });
    const nickname =
      (
        await this.accountQueryService.findAccountDisplayInfosByAccountIds([result.actorAccountId])
      ).get(result.actorAccountId)?.nickname ?? ADMIN_ENGINEER_NICKNAME_FALLBACK;

    return {
      requestId: result.requestId,
      revisionNo: result.revisionNo,
      previousVersion: result.previousVersion,
      reason: result.reason,
      actorNickname: nickname,
      createdAt: result.createdAt,
      comparable: result.comparable,
      hasMaintenanceData: result.hasMaintenanceData,
      incomparableReason: result.incomparableReason,
      before: result.before,
      after: result.after,
    };
  }
}
