// src/usecases/reference-document/get-reference-document-detail.usecase.ts

import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichReferenceDocumentCreator } from './enrich-reference-document-creator';
import { assertDocumentIdValid, assertReferenceDocumentReadRole } from './reference-document-roles';
import {
  GetReferenceDocumentDetailCommand,
  GetReferenceDocumentDetailResult,
} from './reference-document.types';

/**
 * 查询参考资料详情用例（工程师/管理员维度，本组织范围）
 *
 * - 组织范围经可信组织上下文解析（A-PR0 §2.1）：客户端自报组织不参与归属判定；
 * - 不存在、已软删与跨组织统一 NOT_FOUND（QueryService 口径，不泄露删除状态与存在性）
 * - 创建人展示经 creatorNickname 实时富集，不返回账号 ID
 * - 角色准入由 adapter 层守卫决策（ENGINEER/SUPER_ADMIN），本用例兜底
 */
@Injectable()
export class GetReferenceDocumentDetailUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: GetReferenceDocumentDetailCommand,
  ): Promise<GetReferenceDocumentDetailResult> {
    assertReferenceDocumentReadRole(command.session.roles);
    assertDocumentIdValid(command.documentId);

    const membership = await this.organizationContextService.resolveForAccount({
      accountId: command.session.accountId,
    });

    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: membership.organizationId,
    });
    return enrichReferenceDocumentCreator(this.accountQueryService, detail);
  }
}
