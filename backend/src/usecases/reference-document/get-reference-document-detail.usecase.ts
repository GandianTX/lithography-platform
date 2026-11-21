// src/usecases/reference-document/get-reference-document-detail.usecase.ts

import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichReferenceDocumentCreator } from './enrich-reference-document-creator';
import { assertDocumentIdValid, assertReferenceDocumentReadRole } from './reference-document-roles';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';
import {
  GetReferenceDocumentDetailCommand,
  GetReferenceDocumentDetailResult,
} from './reference-document.types';

/**
 * 查询参考资料详情用例（工程师/管理员维度，读侧范围决议）
 *
 * - 范围经 resolveReferenceDocumentReadScope 决议（A-PR0 §2.1 + 功能 V5.6 R055-02/R056-02）：
 *   工程师与二级管理员仅本公司，一级管理员全部公司正式资料（含任务 06 正式维修报告）；
 * - 不存在、已软删与跨范围统一 NOT_FOUND（QueryService 口径，不泄露删除状态与存在性）
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

    // 读侧范围先决议：一级 GLOBAL / 其余本公司（工程师与二级管理员仍失败关闭）
    const scope = await resolveReferenceDocumentReadScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      organizationId: scope.kind === 'GLOBAL' ? null : scope.organizationId,
    });
    return enrichReferenceDocumentCreator(this.accountQueryService, detail);
  }
}
