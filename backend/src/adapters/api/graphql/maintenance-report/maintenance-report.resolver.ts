// src/adapters/api/graphql/maintenance-report/maintenance-report.resolver.ts
//
// 维修报告（任务 06）GraphQL 入口：只做协议映射 → 调用用例 → 输出 DTO。
// 作者与公司一律来自可信会话；本入口不接收客户端自报 author/company。
// 本切片提供草稿创建/续填、R051-01 正式提交、本人读取与 R051 导出；
// AI 评价真实读侧待任务 05 联调。
//
// 任务 07「我的资料记录」读侧（R052）以独立查询名并行提供：
// myMaintenanceRecordList / myMaintenanceRecordDetail，复用同一组 usecase
// （读入口放开到管理员：页面只展示本人创建记录，他人正式资料走资料库/文档数据库）；
// 任务 06 既有查询契约保持不变。

import { IdentityTypeEnum } from '@app-types/models/account.types';
import { MaintenanceReportStatus } from '@app-types/models/maintenance-report.types';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { CreateMaintenanceReportDraftUsecase } from '@src/usecases/maintenance-report/create-maintenance-report-draft.usecase';
import { AddMaintenanceReportAttachmentUsecase } from '@src/usecases/maintenance-report/add-maintenance-report-attachment.usecase';
import { ExportMaintenanceReportUsecase } from '@src/usecases/maintenance-report/export-maintenance-report.usecase';
import { GetMyMaintenanceReportUsecase } from '@src/usecases/maintenance-report/get-my-maintenance-report.usecase';
import { GetMyWorkOrderSummaryUsecase } from '@src/usecases/maintenance-report/get-my-work-order-summary.usecase';
import { ListMyMaintenanceReportsUsecase } from '@src/usecases/maintenance-report/list-my-maintenance-reports.usecase';
import { ListMyWorkOrderSummaryCandidatesUsecase } from '@src/usecases/maintenance-report/list-my-work-order-summary-candidates.usecase';
import { ListWorkOrderSummaryAiConversationsUsecase } from '@src/usecases/maintenance-report/list-work-order-summary-ai-conversations.usecase';
import { RemoveMaintenanceReportAttachmentUsecase } from '@src/usecases/maintenance-report/remove-maintenance-report-attachment.usecase';
import { SubmitMaintenanceReportFormalUsecase } from '@src/usecases/maintenance-report/submit-maintenance-report-formal.usecase';
import { UpdateMaintenanceReportDraftUsecase } from '@src/usecases/maintenance-report/update-maintenance-report-draft.usecase';
import {
  AddMaintenanceReportAttachmentInput,
  CreateMaintenanceReportDraftInput,
  MaintenanceReportDraftInputDTO,
  MaintenanceReportExportInput,
  MaintenanceReportFaultInputDTO,
  MaintenanceReportPaginationInput,
  MaintenanceReportStagedAttachmentInputDTO,
  MaintenanceReportStepInputDTO,
  MyMaintenanceReportFilterInput,
  RemoveMaintenanceReportAttachmentInput,
  SubmitMaintenanceReportInput,
  UpdateMaintenanceReportDraftInput,
} from './dto/maintenance-report.input';
import {
  MaintenanceReportAttachmentResultDTO,
  MaintenanceReportDetailDTO,
  MaintenanceReportDraftResultDTO,
  MaintenanceReportExportResultDTO,
  MaintenanceReportSubmitResultDTO,
  MaintenanceReportPageDTO,
  MaintenanceReportDTO,
  MyWorkOrderSummaryDTO,
  WorkOrderSummaryAiConversationDTO,
  WorkOrderSummaryCandidatePageDTO,
  toMaintenanceReportDetailDTO,
  toMaintenanceReportSummaryDTO,
  toWorkOrderSummaryCandidateDTO,
  toWorkOrderSummaryAiConversationDTO,
  toWorkOrderSummarySourcePreviewDTO,
} from './dto/maintenance-report.dto';
import { MaintenanceReportFilterInput } from './dto/maintenance-report-filter.input';
import { MyRecordDetailDTO, MyRecordPaginatedDTO } from './dto/maintenance-report-read.dto';

function toStagedAttachmentUsecaseInput(
  attachment: MaintenanceReportStagedAttachmentInputDTO | null | undefined,
) {
  if (attachment === null || attachment === undefined) {
    return null;
  }
  return {
    fileId: attachment.fileId,
    uploadContextId: attachment.uploadContextId,
    description: attachment.description ?? null,
  };
}

function toDraftUsecaseInput(draft: MaintenanceReportDraftInputDTO) {
  return {
    title: draft.title,
    customerFactoryName: draft.customerFactoryName,
    equipmentModelId: draft.equipmentModelId,
    equipmentModelText: draft.equipmentModelText,
    maintenanceDate: draft.maintenanceDate,
    handlingResult: draft.handlingResult,
    closureReason: draft.closureReason,
    resetResult: draft.resetResult,
    actualCause: draft.actualCause,
    repairActions: draft.repairActions,
    verificationResult: draft.verificationResult,
    supplementaryNote: draft.supplementaryNote,
    steps: draft.steps?.map((step: MaintenanceReportStepInputDTO) => ({
      stepCode: step.stepCode ?? null,
      phaseCode: step.phaseCode ?? null,
      partName: step.partName ?? null,
      actionText: step.actionText,
      resultCode: step.resultCode ?? null,
      errorCode: step.errorCode ?? null,
      resultText: step.resultText ?? null,
    })),
    faults: draft.faults?.map((fault: MaintenanceReportFaultInputDTO) => ({
      branchKind: fault.branchKind,
      stepNo: fault.stepNo ?? null,
      phaseCode: fault.phaseCode ?? null,
      mainError: fault.mainError ?? null,
      unitError: fault.unitError ?? null,
      source: fault.source ?? null,
      errorType: fault.errorType ?? null,
      gpibStatus: fault.gpibStatus ?? null,
      faultStatus: fault.faultStatus ?? null,
      description: fault.description,
      action: fault.action ?? null,
    })),
    // AI 评价组：undefined 表示沿用落库值；null 表示显式清空该字段
    aiUsage: draft.aiUsage ?? undefined,
    aiSourceType: draft.aiSourceType,
    aiSourceId: draft.aiSourceId,
    aiSourceVersion: draft.aiSourceVersion,
    aiScore: draft.aiScore,
    aiCorrectness: draft.aiCorrectness,
    aiHelpfulness: draft.aiHelpfulness,
    aiNote: draft.aiNote,
  };
}

@Resolver(() => MaintenanceReportDTO)
export class MaintenanceReportResolver {
  constructor(
    private readonly createMaintenanceReportDraftUsecase: CreateMaintenanceReportDraftUsecase,
    private readonly updateMaintenanceReportDraftUsecase: UpdateMaintenanceReportDraftUsecase,
    private readonly getMyMaintenanceReportUsecase: GetMyMaintenanceReportUsecase,
    private readonly listMyMaintenanceReportsUsecase: ListMyMaintenanceReportsUsecase,
    private readonly getMyWorkOrderSummaryUsecase: GetMyWorkOrderSummaryUsecase,
    private readonly listMyWorkOrderSummaryCandidatesUsecase: ListMyWorkOrderSummaryCandidatesUsecase,
    private readonly listWorkOrderSummaryAiConversationsUsecase: ListWorkOrderSummaryAiConversationsUsecase,
    private readonly submitMaintenanceReportFormalUsecase: SubmitMaintenanceReportFormalUsecase,
    private readonly exportMaintenanceReportUsecase: ExportMaintenanceReportUsecase,
    private readonly addMaintenanceReportAttachmentUsecase: AddMaintenanceReportAttachmentUsecase,
    private readonly removeMaintenanceReportAttachmentUsecase: RemoveMaintenanceReportAttachmentUsecase,
  ) {}

  /** 新建维修报告草稿：独立历史报告不关联工单；工单总结须本人已接且已结单 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => MaintenanceReportDraftResultDTO, {
    description: '新建维修报告草稿（独立历史记录或本人工单总结）',
  })
  @ValidateInput()
  async createMaintenanceReportDraft(
    @Args('input') input: CreateMaintenanceReportDraftInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportDraftResultDTO> {
    const result = await this.createMaintenanceReportDraftUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      sourceType: input.sourceType,
      repairRequestId: input.repairRequestId ?? null,
      draft: toDraftUsecaseInput(input.draft),
      attachment: toStagedAttachmentUsecaseInput(input.attachment),
    });
    return {
      reportId: result.reportId,
      status: result.status as MaintenanceReportDraftResultDTO['status'],
      currentVersionNo: result.currentVersionNo,
      updatedAt: result.updatedAt,
    };
  }

  /** 更新本人草稿：仅作者、同组织、DRAFT/RETURNED 可写 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => MaintenanceReportDraftResultDTO, { description: '更新本人维修报告草稿' })
  @ValidateInput()
  async updateMaintenanceReportDraft(
    @Args('input') input: UpdateMaintenanceReportDraftInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportDraftResultDTO> {
    const result = await this.updateMaintenanceReportDraftUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId: input.reportId,
      draft: toDraftUsecaseInput(input.draft),
      attachment: toStagedAttachmentUsecaseInput(input.attachment),
    });
    return {
      reportId: result.reportId,
      status: result.status as MaintenanceReportDraftResultDTO['status'],
      currentVersionNo: result.currentVersionNo,
      updatedAt: result.updatedAt,
    };
  }

  /**
   * R051-01 正式提交：草稿提交与未保存表单直接提交共用。
   * 服务端核对身份、工单、公司与版本；同标识异内容拒绝，合法重试返回原结果。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => MaintenanceReportSubmitResultDTO, {
    description: '正式提交维修报告（冻结并生成正式资料）',
  })
  @ValidateInput()
  async submitMaintenanceReport(
    @Args('input') input: SubmitMaintenanceReportInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportSubmitResultDTO> {
    const result = await this.submitMaintenanceReportFormalUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      sourceType: input.sourceType,
      repairRequestId: input.repairRequestId ?? null,
      reportId: input.reportId ?? null,
      expectedVersionNo: input.expectedVersionNo ?? null,
      submissionRequestId: input.submissionRequestId,
      sourceConfirmation: input.sourceConfirmation ?? null,
      draft: toDraftUsecaseInput(input.draft),
      attachment: toStagedAttachmentUsecaseInput(input.attachment),
    });
    return {
      reportId: result.reportId,
      versionId: result.versionId,
      versionNo: result.versionNo,
      status: result.status as MaintenanceReportStatus,
      submissionRequestId: result.submissionRequestId,
      referenceDocumentId: result.referenceDocumentId,
    };
  }

  /**
   * R051 预览/导出：当前表单（含未保存草稿）或有权已保存版本 → DOCX/PDF。
   * 只读：不创建报告、不登记机型、不改版本或附件引用；权限与内容完整性由 usecase 裁决。
   * CURRENT_FORM 仅工程师本人；SAVED_VERSION 另允许管理员按公司范围导出正式版本
   * （R047/R048、页面 V6.5 §8.5：1 级全部公司、2 级本公司，不读他人工作态草稿）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => MaintenanceReportExportResultDTO, {
    description: '导出维修报告 DOCX/PDF（当前表单或有权已保存版本；不写库）',
  })
  @ValidateInput()
  async exportMaintenanceReport(
    @Args('input') input: MaintenanceReportExportInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportExportResultDTO> {
    return this.exportMaintenanceReportUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      format: input.format,
      currentForm: input.currentForm
        ? {
            sourceType: input.currentForm.sourceType,
            repairRequestId: input.currentForm.repairRequestId ?? null,
            draft: toDraftUsecaseInput(input.currentForm.draft),
          }
        : null,
      savedVersion: input.savedVersion
        ? {
            reportId: input.savedVersion.reportId,
            versionNo: input.savedVersion.versionNo ?? null,
          }
        : null,
    });
  }

  /** 挂接任务 11 暂存原件到本人可编辑报告：服务端同事务核验并绑定 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => MaintenanceReportAttachmentResultDTO, {
    description: '挂接暂存原件到本人可编辑报告附件集合',
  })
  @ValidateInput()
  async addMaintenanceReportAttachment(
    @Args('input') input: AddMaintenanceReportAttachmentInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportAttachmentResultDTO> {
    return this.addMaintenanceReportAttachmentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId: input.reportId,
      fileId: input.fileId,
      uploadContextId: input.uploadContextId,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? null,
    });
  }

  /** 移除（退役）本人可编辑报告的当前附件：已冻结版本历史不受影响 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => MaintenanceReportAttachmentResultDTO, {
    description: '移除本人可编辑报告的当前附件',
  })
  @ValidateInput()
  async removeMaintenanceReportAttachment(
    @Args('input') input: RemoveMaintenanceReportAttachmentInput,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportAttachmentResultDTO> {
    return this.removeMaintenanceReportAttachmentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId: input.reportId,
      attachmentId: input.attachmentId,
    });
  }

  /** 本人报告详情：他人/跨组织统一不可访问 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => MaintenanceReportDetailDTO, { description: '读取本人维修报告（含工作态草稿内容）' })
  async myMaintenanceReport(
    @Args('reportId', { type: () => Int }) reportId: number,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportDetailDTO> {
    const detail = await this.getMyMaintenanceReportUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId,
    });
    return toMaintenanceReportDetailDTO(detail);
  }

  /** 本人报告列表：可按来源过滤（独立历史记录 / 工单总结） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => MaintenanceReportPageDTO, { description: '本人维修报告列表' })
  @ValidateInput()
  async myMaintenanceReports(
    @Args('pagination', { type: () => MaintenanceReportPaginationInput, nullable: true })
    pagination: MaintenanceReportPaginationInput | undefined,
    @Args('filter', { type: () => MyMaintenanceReportFilterInput, nullable: true })
    filter: MyMaintenanceReportFilterInput | undefined,
    @currentUser() user: JwtPayload,
  ): Promise<MaintenanceReportPageDTO> {
    const page = await this.listMyMaintenanceReportsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: {
        page: pagination?.page,
        pageSize: pagination?.pageSize,
        withTotal: pagination?.withTotal,
      },
      sourceType: filter?.sourceType,
    });
    return {
      items: page.items.map(toMaintenanceReportSummaryDTO),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 本人记录列表（任务 07 R052，页面 V6.5 §9.2）：可按来源类型与未完成/已提交筛选，
   * OFFSET 分页；`withTotal` 缺省 true（本人记录页需要总数），total 与同一归属谓词一致。
   * 页面只展示本人创建记录（后端 usecase 按作者 [+ 本组织] 谓词收敛）；管理员查看
   * 他人正式资料走历史维修记录库/文档数据库，不经过本查询。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => MyRecordPaginatedDTO, {
    description: '查询本人资料记录列表（本人草稿及有权正式记录）',
  })
  @ValidateInput()
  async myMaintenanceRecordList(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: MaintenanceReportFilterInput,
  ): Promise<MyRecordPaginatedDTO> {
    const mapped = mapGqlToCoreParams(pagination);
    const page = await this.listMyMaintenanceReportsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination:
        mapped.mode === 'OFFSET'
          ? {
              mode: 'OFFSET',
              page: mapped.page,
              pageSize: mapped.pageSize,
              withTotal: mapped.withTotal ?? true,
            }
          : {
              mode: 'CURSOR',
              page: 1,
              pageSize: mapped.limit,
              withTotal: false,
            },
      filter: {
        sourceType: filter?.sourceType,
        recordKind: filter?.recordKind,
        titleKeyword: filter?.titleKeyword,
      },
    });
    return {
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 本人记录详情（任务 07，只读）：他人/跨公司报告统一 NOT_FOUND。
   * 草稿续填入口由前端按 `canEdit` 决定是否展示任务 06 编辑器入口。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => MyRecordDetailDTO, {
    description: '查询本人资料记录详情（本人草稿及有权正式记录）',
  })
  async myMaintenanceRecordDetail(
    @Args({ name: 'id', type: () => Int, description: '维修报告 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<MyRecordDetailDTO> {
    const detail = await this.getMyMaintenanceReportUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId: id,
    });
    return {
      ...detail,
      // 快照字段名到 DTO 字段名的薄映射：冻结时的姓名快照是唯一权威展示来源
      report: {
        ...detail.report,
        maintenanceEngineerName: detail.report.maintenanceEngineerNameSnapshot,
      },
    };
  }

  /** 工单总结入口：服务端复核本人、已接单、已结单；返回同一份草稿（若有） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => MyWorkOrderSummaryDTO, { description: '工单维修总结入口（本人已接且已结单）' })
  async myWorkOrderSummary(
    @Args('repairRequestId', { type: () => Int }) repairRequestId: number,
    @currentUser() user: JwtPayload,
  ): Promise<MyWorkOrderSummaryDTO> {
    const entry = await this.getMyWorkOrderSummaryUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      repairRequestId,
    });
    return {
      repairRequestId: entry.repairRequestId,
      requestNo: entry.requestNo,
      equipmentModelId: entry.equipmentModelId,
      equipmentModelCode: entry.equipmentModelCode,
      equipmentModelName: entry.equipmentModelName,
      closedAt: entry.closedAt,
      report: entry.report === null ? null : toMaintenanceReportDetailDTO(entry.report),
      sourceChangedSinceDraft: entry.sourceChangedSinceDraft,
      sourceConfirmation: entry.sourceConfirmation,
      sourcePreview: toWorkOrderSummarySourcePreviewDTO(entry.sourcePreview),
    };
  }

  /** 工单维修总结待填写列表：本人接单、已结单、尚未正式提交 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => WorkOrderSummaryCandidatePageDTO, { description: '工单维修总结待填写列表' })
  @ValidateInput()
  async myWorkOrderSummaryCandidates(
    @Args('pagination', { type: () => MaintenanceReportPaginationInput, nullable: true })
    pagination: MaintenanceReportPaginationInput | undefined,
    @currentUser() user: JwtPayload,
  ): Promise<WorkOrderSummaryCandidatePageDTO> {
    const page = await this.listMyWorkOrderSummaryCandidatesUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: {
        page: pagination?.page,
        pageSize: pagination?.pageSize,
        withTotal: pagination?.withTotal,
      },
    });
    return {
      items: page.items.map(toWorkOrderSummaryCandidateDTO),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 工单总结 AI 评价候选会话（任务 05 真实读侧）。
   * 只返回本人工单、同一公司、所选版本内有有效回复的会话；
   * 空数组表示确认没有符合条件的会话，读取失败按 GraphQL 错误返回（不得当作无会话）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => [WorkOrderSummaryAiConversationDTO], {
    description: '工单总结 AI 评价候选会话（不含会话正文）',
  })
  async myWorkOrderSummaryAiConversations(
    @Args('repairRequestId', { type: () => Int }) repairRequestId: number,
    @currentUser() user: JwtPayload,
  ): Promise<WorkOrderSummaryAiConversationDTO[]> {
    const candidates = await this.listWorkOrderSummaryAiConversationsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      repairRequestId,
    });
    return candidates.map(toWorkOrderSummaryAiConversationDTO);
  }
}
