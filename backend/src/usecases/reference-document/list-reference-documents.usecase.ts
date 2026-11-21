// src/usecases/reference-document/list-reference-documents.usecase.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { applyDefaults, enforceMaxPageSize } from '@core/pagination/pagination.policy';
import { OffsetParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { ReferenceDocumentListPage } from '@src/modules/lithography/lithography.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { enrichReferenceDocumentListCreators } from './enrich-reference-document-creator';
import { normalizeOptionalFilterText } from './reference-document-fields.normalize';
import { assertReferenceDocumentReadRole } from './reference-document-roles';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';
import {
  ListReferenceDocumentsCommand,
  ListReferenceDocumentsResult,
} from './reference-document.types';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 查询参考资料列表用例（工程师/管理员维度，读侧范围决议）
 *
 * - 范围经 resolveReferenceDocumentReadScope 决议（A-PR0 §2.1 + 功能 V5.6 R055/R056）：
 *   工程师与二级管理员仅本公司，一级管理员全部公司正式资料；
 *   无有效成员关系/多关系歧义时由 TrustedOrganizationContextQueryService 拒绝
 *   （一级管理员 GLOBAL 范围不依赖本人成员关系）；
 * - 默认仅返回未软删资料；排序由契约固定（创建时间倒序 + 主键倒序），
 *   不采纳客户端排序入参；页大小上限在传输无关的用例层强制，不依赖入口校验
 * - 创建人展示经 creatorNickname 实时富集，不返回账号 ID
 * - 角色准入由 adapter 层守卫决策（ENGINEER/SUPER_ADMIN），本用例兜底
 */
@Injectable()
export class ListReferenceDocumentsUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
  ) {}

  async execute(command: ListReferenceDocumentsCommand): Promise<ListReferenceDocumentsResult> {
    assertReferenceDocumentReadRole(command.session.roles);

    if (command.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '参考资料列表第一版仅支持 OFFSET 分页',
        { mode: command.pagination.mode },
      );
    }
    const { page, pageSize, withTotal } = enforceMaxPageSize(
      applyDefaults(command.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    // 读侧范围先决议：一级 GLOBAL / 其余本公司（工程师与二级管理员仍失败关闭）
    const scope = await resolveReferenceDocumentReadScope({
      session: command.session,
      accountQueryService: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });

    const listPage = await this.referenceDocumentQueryService.listDocuments({
      // 字符串筛选词先规范化：空白视为未提供该筛选，与前端「空白搜索词=无筛选」口径一致
      filter: {
        title: normalizeOptionalFilterText(command.filter?.title),
        documentType: normalizeOptionalFilterText(command.filter?.documentType),
        equipmentModelId: command.filter?.equipmentModelId,
        caseHandlingStatus: normalizeOptionalFilterText(command.filter?.caseHandlingStatus),
      },
      pagination: { page, pageSize, withTotal: withTotal ?? false },
      organizationId: scope.kind === 'GLOBAL' ? null : scope.organizationId,
    });
    const items = await enrichReferenceDocumentListCreators(
      this.accountQueryService,
      listPage.items,
    );
    const result: ReferenceDocumentListPage = { ...listPage, items };
    return result;
  }
}
