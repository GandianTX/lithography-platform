// src/usecases/reference-document/get-reference-document-detail.usecase.ts

import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichReferenceDocumentCreator } from './enrich-reference-document-creator';
import { assertDocumentIdValid } from './reference-document-roles';
import { resolveReferenceDocumentEffectiveContent } from './resolve-reference-document-effective-detail';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';
import {
  GetReferenceDocumentDetailCommand,
  GetReferenceDocumentDetailResult,
} from './reference-document.types';

/**
 * 查询参考资料详情用例（普通资料库，服务端统一可见范围）
 *
 * - 范围经 resolveReferenceDocumentReadScope 决议（A-PR0 §2.1 + 功能 V5.6 R055-02/R056-02）：
 *   工程师与二级管理员仅本公司，一级管理员全部公司正式资料（含任务 06 正式维修报告），客户拒绝；
 * - 不存在、下架、归属未确认、已软删与跨范围统一 NOT_FOUND（QueryService 口径，不泄露删除状态与存在性）；
 * - 生效正文口径（任务 07）：
 *   管理修订 > 原始冻结报告版本 > 资料自身正文；
 *   报告来源无冻结版本行属数据定式破坏，失败关闭（不输出半截正文）；
 * - 合法无附件资料（仅有正文或仅有冻结报告）正常返回，不强制要求文件；
 * - 创建人展示经 creatorNickname 实时富集，不返回账号 ID、存储引用；
 * - 角色准入由 adapter 层守卫决策（ENGINEER/SUPER_ADMIN），本用例兜底
 */
@Injectable()
export class GetReferenceDocumentDetailUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(
    command: GetReferenceDocumentDetailCommand,
  ): Promise<GetReferenceDocumentDetailResult> {
    assertDocumentIdValid(command.documentId);

    // 读侧范围先决议：一级 GLOBAL / 其余本公司（工程师与二级管理员仍失败关闭）
    const scope = await resolveReferenceDocumentReadScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope,
    });
    const enriched = await enrichReferenceDocumentCreator(this.accountQueryService, detail);

    const { contentText, contentSource, frozenReport, structuredContent, sourceReportAttachment } =
      await resolveReferenceDocumentEffectiveContent({
        referenceDocumentQueryService: this.referenceDocumentQueryService,
        maintenanceReportQueryService: this.maintenanceReportQueryService,
        detail: enriched,
      });

    return {
      ...enriched,
      contentText,
      contentSource,
      frozenReport,
      structuredContent,
      sourceReportAttachment,
      // R053 作者删除入口依据：只给布尔事实，不返回创建人账号 ID
      viewerIsOriginalAuthor: detail.createdByAccountId === command.session.accountId,
    };
  }
}
