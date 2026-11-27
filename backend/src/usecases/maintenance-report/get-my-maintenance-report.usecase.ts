// src/usecases/maintenance-report/get-my-maintenance-report.usecase.ts

import { DomainError, MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  GetMaintenanceReportCommand,
  MyMaintenanceReportDetailResult,
} from './maintenance-report-command.types';
import {
  assertMaintenanceReportId,
  assertMyMaintenanceReportReadEntryRole,
} from './maintenance-report-roles';
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
 * 本人维修报告详情（任务 07 R052，页面 V6.5 §9.2；2026-11-21 页面设计确认）。
 *
 * 页面只展示「本人创建且本人有权访问」的记录，归属裁决按读者范围分支：
 * - 工程师与二级管理员：作者本人 + 本组织资源授权（作者换公司后旧公司记录
 *   不再可见，不自动转移归属，不因曾是作者放行）；
 * - 一级管理员（2026-11-21 平台级角色口径确认）：平台级角色、无业务所属公司，
 *   只按作者本人读取自己的记录，不解析组织成员关系（无成员关系不报组织错误）；
 *   其全公司正式资料读取走历史维修记录库/文档数据库既有权限，不经本页面；
 * - 他人正式记录不经本页面读取：一级/二级管理员走历史维修记录库与管理员文档
 *   数据库（R055/R056 资源权限），他人草稿/待审一律 NOT_FOUND。
 *
 * 返回工作态内容、当前冻结版本（含版本附件清单）与审核历史；
 * 读取时再次携带同一范围谓词（第二道约束），列表/total/详情/直接 ID 一致。
 *
 * 任务 07 增补：机型展示名与「已发布正式资料」标识（批量入口传 [reportId]），
 * 供「我的资料记录」只读成品视图使用；已下架/软删资料不返回标识；一级管理员
 * 不按公司过滤成品标识（资料侧按其 GLOBAL 权限在详情读侧裁决）。
 * 读入口放开到管理员（R052）；越权 ID 一律拒绝。
 *
 * 同步状态（任务 07 预留）：授权与详情读取完成后，复用列表同一批量接口
 * （单条 = 一批，最多一次）；公司取自服务端核实的资源归属；提供方失败降级
 * UNKNOWN，不影响详情返回，也不吞掉上方已发生的授权错误。
 */
@Injectable()
export class GetMyMaintenanceReportUsecase {
  constructor(
    private readonly maintenanceReportQueryService: MaintenanceReportQueryService,
    private readonly referenceDocumentQueryService: ReferenceDocumentQueryService,
    private readonly equipmentModelQueryService: EquipmentModelQueryService,
    private readonly organizationContextService: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
    @Inject(MAINTENANCE_REPORT_SYNC_STATUS_READER)
    private readonly syncStatusReader: MaintenanceReportSyncStatusReader,
  ) {}

  async execute(command: GetMaintenanceReportCommand): Promise<MyMaintenanceReportDetailResult> {
    assertMyMaintenanceReportReadEntryRole(command.session);
    assertMaintenanceReportId(command.reportId);
    const ownership = await this.maintenanceReportQueryService.readReportOwnership(
      command.reportId,
    );
    if (ownership === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    // 页面口径（2026-11-21 确认）：所有状态都要求作者本人。
    // - 工程师/二级管理员：本组织谓词承担资源授权（作者换公司后旧公司记录统一
    //   NOT_FOUND，不因曾是作者绕过资源权限）；
    // - 一级管理员：平台级角色无业务所属公司，不解析组织成员关系，只按作者谓词。
    const readerScope = await resolveMyMaintenanceReportReaderScope({
      session: command.session,
      adminLevelReader: this.accountQueryService,
      organizationContextService: this.organizationContextService,
    });
    const isAuthor = ownership.maintenanceEngineerAccountId === command.session.accountId;
    const isSameOrganization =
      readerScope.kind === 'FIRST_LEVEL_ADMIN' ||
      ownership.ownerOrganizationId === readerScope.organizationId;
    if (!isSameOrganization || !isAuthor) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }
    // 授权后才加载完整内容；详情读取仍携带同一范围谓词（作者 [+ 本组织]），不依赖第一次检查。
    const detail = await this.maintenanceReportQueryService.readReportDetail(
      command.reportId,
      undefined,
      {
        maintenanceEngineerAccountId: command.session.accountId,
        ...(readerScope.kind === 'ORGANIZATION'
          ? { ownerOrganizationId: readerScope.organizationId }
          : {}),
      },
    );
    if (detail === null) {
      throw new DomainError(MAINTENANCE_REPORT_ERROR.NOT_FOUND, '维修报告不存在或不可访问', {
        reportId: command.reportId,
      });
    }

    const equipmentModel =
      detail.report.equipmentModelId === null
        ? null
        : await this.equipmentModelQueryService.findModelById({
            id: detail.report.equipmentModelId,
          });
    const publishedByReportId =
      await this.referenceDocumentQueryService.listPublishedDocumentIdsByReportIds(
        [detail.report.id],
        readerScope.kind === 'ORGANIZATION' ? readerScope.organizationId : undefined,
      );

    // 同步状态（任务 07 预留）：详情复用列表同一批量接口，单条一次。
    // 公司取自授权通过的资源归属；跨端 UUID 已对齐（handoff §2 断点已消解，取
    // `maintenance_report.record_uuid`），历史行 NULL 时不发真实查询，映射缺失按 UNKNOWN 展示。
    const syncStatuses = await attachMaintenanceReportSyncStatuses({
      reader: this.syncStatusReader,
      session: command.session,
      records: [
        {
          id: detail.report.id,
          facts: {
            ownerOrganizationId: ownership.ownerOrganizationId,
            recordUuid: ownership.recordUuid,
            currentVersionNo: detail.report.currentVersionNo,
          },
        },
      ],
    });

    return {
      ...detail,
      equipmentModelName: equipmentModel?.modelName ?? null,
      publishedDocumentId: publishedByReportId.get(detail.report.id) ?? null,
      syncStatus: syncStatuses.get(detail.report.id) ?? UNKNOWN_MAINTENANCE_REPORT_SYNC_STATUS,
    };
  }
}
