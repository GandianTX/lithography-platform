// src/usecases/maintenance-report/list-my-maintenance-reports.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  MaintenanceReportQueryService,
  type MaintenanceReportListPage,
} from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  MaintenanceReportListFilter,
  MaintenanceReportRecordSummaryView,
} from '@src/modules/lithography/maintenance-report.types';
import type { ListMyMaintenanceReportsCommand } from './maintenance-report-command.types';
import { normalizeListFilter } from './maintenance-report-list-filter';
import { normalizePagination } from './maintenance-report-pagination';
import { assertMyMaintenanceReportReadEntryRole } from './maintenance-report-roles';
import { resolveMyMaintenanceReportReaderScope } from './maintenance-report-reader-scope';
import {
  UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS,
  attachMaintenanceReportSyncStatuses,
} from './maintenance-report-sync-status.helpers';
import {
  MAINTENANCE_REPORT_SYNC_STATUS_READER,
  type MaintenanceReportSyncStatusReader,
} from './ports/maintenance-report-sync-status-reader.contract';

/**
 * 本人记录列表（任务 07 R052）：仅当前组织内由本人负责的报告，按更新时间倒序分页。
 *
 * 任务 07 增补：
 * - 支持来源类型与「未完成/已提交」筛选（状态集合判定，不硬编码正式状态）；
 * - 逐报告关联已发布正式资料标识（批量一次读取），供页面提供「查看成品」入口；
 *   已下架/软删资料不返回标识，入口随之消失。
 * - 读入口放开到管理员（R052：管理员保留本人记录查询，无新建入口）。
 *   页面口径（2026-11-21 设计确认）：列表只展示「本人创建且本人有权访问」的记录——
 *   他人草稿、他人待审与他人正式记录一律不出现在本页面（管理员查看他人正式资料
 *   走参考资料库与管理员文档数据库，R055/R056）。管理员没有本人记录时得到
 *   空列表/total=0，而不是在角色层被拒。
 * - 一级管理员是平台级角色（2026-11-21 平台级角色口径确认）：无业务所属公司，
 *   不解析组织成员关系，列表/成品标识只按作者本人读取，无记录时正常空态；
 *   工程师与二级管理员仍按作者本人+可信本公司判断（作者换公司后旧公司记录
 *   不再可见，不自动转移归属）。
 * - 同步状态（任务 07 预留）：授权与页面读取完成后，对当前页最多批量调用一次
 *   同步状态读取（任务 09 未装配默认返回 NOT_CONNECTED）；只对具备可信映射的
 *   记录发起真实查询；提供方漏项/重复/旧版本/失败一律降级 UNKNOWN，
 *   不影响原列表、total，也不吞掉上方已发生的授权错误。
 */
@Injectable()
export class ListMyMaintenanceReportsUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(MAINTENANCE_REPORT_SYNC_STATUS_READER)
    private readonly syncStatusReader: MaintenanceReportSyncStatusReader,
  ) {}

  async execute(
    command: ListMyMaintenanceReportsCommand,
  ): Promise<MaintenanceReportListPage<MaintenanceReportRecordSummaryView>> {
    assertMyMaintenanceReportReadEntryRole(command.session);
    const pagination = normalizePagination(command.pagination);
    // 兼容任务 06 既有调用形态：未提供任务 07 filter 对象时回退 sourceType 单字段
    const filter: MaintenanceReportListFilter = normalizeListFilter(
      command.filter ??
        (command.sourceType !== undefined ? { sourceType: command.sourceType } : undefined),
    );
    const readerScope = await resolveMyMaintenanceReportReaderScope({
      session: command.session,
      adminLevelReader: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });
    const organizationId =
      readerScope.kind === 'ORGANIZATION' ? readerScope.organizationId : undefined;
    const page = await this.maintenanceReportQueryService.listMine(
      command.session.accountId,
      organizationId,
      pagination,
      filter,
    );
    if (page.items.length === 0) {
      return { ...page, items: [] };
    }
    const publishedByReportId =
      await this.referenceDocumentQueryService.listPublishedDocumentIdsByReportIds(
        page.items.map((item) => item.id),
        organizationId,
      );
    // 同步状态（任务 07 预留）：当前页批量读取最多一次。公司取自列表返回的资源
    // 归属 owner_organization_id（服务端事实，查询谓词已保证与读者范围一致）；
    // 跨端 UUID 的持久来源待任务 09 对齐（handoff §2 断点），对齐前恒为 null——
    // 不用本地 reportId、提交请求 ID、资料修订号或草稿 0 版本硬凑查询键。
    const syncStatuses = await attachMaintenanceReportSyncStatuses({
      reader: this.syncStatusReader,
      records: page.items.map((item) => ({
        id: item.id,
        facts: {
          ownerOrganizationId: item.ownerOrganizationId,
          recordUuid: null,
          currentVersionNo: item.currentVersionNo,
        },
      })),
    });
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        publishedDocumentId: publishedByReportId.get(item.id) ?? null,
        syncStatus: syncStatuses.get(item.id) ?? UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS,
      })),
    };
  }
}
