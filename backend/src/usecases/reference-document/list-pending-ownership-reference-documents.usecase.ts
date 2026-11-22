// src/usecases/reference-document/list-pending-ownership-reference-documents.usecase.ts

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { applyDefaults, enforceMaxPageSize } from '@core/pagination/pagination.policy';
import { OffsetParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import { ReferenceDocumentListPage } from '@src/modules/lithography/lithography.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { enrichReferenceDocumentListCreators } from './enrich-reference-document-creator';
import { assertReferenceDocumentFirstLevelAdmin } from './reference-document-roles';
import {
  ListPendingOwnershipReferenceDocumentsCommand,
  ListReferenceDocumentsResult,
} from './reference-document.types';

/** 页大小上限：与 GraphQL 边界 PaginationArgs @Max(100) 对齐（统一分页策略） */
const MAX_PAGE_SIZE = 100;

/**
 * 查询归属待核实资料列表用例（任务 07 R061-01，一级管理员专用入口）。
 *
 * - 准入：仅可信 activeRole = SUPER_ADMIN 且账号当前事实 admin_level = 1
 *   （`assertReferenceDocumentFirstLevelAdmin`）；二级管理员、工程师、客户一律
 *   INSUFFICIENT_PERMISSIONS——这是权限拒绝而非资源不可见；
 * - 范围：恒为全公司（GLOBAL），不按组织收敛——待核实条目的 owner_organization_id
 *   本身待确认，正是本清单要核实的事实；
 * - 数据口径：query service 仅返回未软删 + ownership_status = PENDING 条目；
 *   不进普通资料库列表（普通列表可见谓词已排除 PENDING），两条路径互不重叠；
 * - total 恒返回（清单页需要真实汇总），排序契约与普通列表一致；
 * - 创建人展示经 creatorNickname 实时富集，不返回账号 ID。
 */
@Injectable()
export class ListPendingOwnershipReferenceDocumentsUsecase {
  constructor(
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(
    command: ListPendingOwnershipReferenceDocumentsCommand,
  ): Promise<ListReferenceDocumentsResult> {
    if (command.pagination.mode !== 'OFFSET') {
      throw new DomainError(
        REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS,
        '归属待核实清单第一版仅支持 OFFSET 分页',
        { mode: command.pagination.mode },
      );
    }
    await assertReferenceDocumentFirstLevelAdmin({
      session: command.session,
      accountQueryService: this.accountQueryService,
    });

    const { page, pageSize } = enforceMaxPageSize(
      applyDefaults(command.pagination, {}),
      MAX_PAGE_SIZE,
    ) as OffsetParams;

    const listPage = await this.referenceDocumentQueryService.listPendingOwnershipDocuments({
      pagination: { page, pageSize, withTotal: true },
    });
    const items = await enrichReferenceDocumentListCreators(
      this.accountQueryService,
      listPage.items,
    );
    const result: ReferenceDocumentListPage = { ...listPage, items };
    return result;
  }
}
