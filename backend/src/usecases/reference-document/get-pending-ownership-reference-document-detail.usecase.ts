// src/usecases/reference-document/get-pending-ownership-reference-document-detail.usecase.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { enrichReferenceDocumentCreator } from './enrich-reference-document-creator';
import {
  assertDocumentIdValid,
  assertReferenceDocumentFirstLevelAdmin,
} from './reference-document-roles';
import { resolveReferenceDocumentEffectiveContent } from './resolve-reference-document-effective-detail';
import {
  GetPendingOwnershipReferenceDocumentDetailCommand,
  GetReferenceDocumentDetailResult,
} from './reference-document.types';

/**
 * 查询归属待核实资料详情用例（任务 07 R061-01，一级管理员专用入口）。
 *
 * - 准入：仅一级管理员（与清单同一事实复核，与归属更正写路径同口径）；
 *   二级管理员、工程师、客户一律 INSUFFICIENT_PERMISSIONS；
 * - 数据口径：走写路径谓词放宽（GLOBAL 不按组织收敛、不要求 ONLINE+CONFIRMED），
 *   但仅 ownership_status = PENDING 条目可读——已确认条目请走普通资料库详情，
 *   已软删条目仍统一 NOT_FOUND，保证普通详情「未知归属受限」的旧地址口径不变；
 * - 生效正文口径与普通详情完全一致（同一公共装配 helper）；
 * - 创建人展示经 creatorNickname 实时富集，不返回账号 ID。
 */
@Injectable()
export class GetPendingOwnershipReferenceDocumentDetailUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(
    command: GetPendingOwnershipReferenceDocumentDetailCommand,
  ): Promise<GetReferenceDocumentDetailResult> {
    assertDocumentIdValid(command.documentId);

    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });

    const detail = await this.referenceDocumentQueryService.findDetail({
      documentId: command.documentId,
      scope: { kind: 'GLOBAL' },
      includeUnpublished: true,
    });
    if (detail.ownershipStatus !== 'PENDING') {
      // 非 PENDING（已确认/已下架等）不进入本入口：统一 NOT_FOUND，不泄露状态与存在性
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '归属待核实资料不存在或不可访问', {
        id: command.documentId,
      });
    }

    const enriched = await enrichReferenceDocumentCreator(this.accountQueryService, detail);
    const { contentText, contentSource, frozenReport, structuredContent } =
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
      viewerIsOriginalAuthor: detail.createdByAccountId === command.session.accountId,
    };
  }
}
