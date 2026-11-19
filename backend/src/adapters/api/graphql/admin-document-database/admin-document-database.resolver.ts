// src/adapters/api/graphql/admin-document-database/admin-document-database.resolver.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { AppendRepairRequestRevisionUsecase } from '@src/usecases/admin-document-database/append-repair-request-revision.usecase';
import { GetAdminAiReportDetailUsecase } from '@src/usecases/admin-document-database/get-admin-ai-report-detail.usecase';
import { GetAdminDocumentDatabaseStatsUsecase } from '@src/usecases/admin-document-database/get-admin-document-database-stats.usecase';
import { GetAdminRepairRequestRevisionDetailUsecase } from '@src/usecases/admin-document-database/get-admin-repair-request-revision-detail.usecase';
import { GetAdminRepairRequestSummaryUsecase } from '@src/usecases/admin-document-database/get-admin-repair-request-summary.usecase';
import { ListAdminAiConversationsUsecase } from '@src/usecases/admin-document-database/list-admin-ai-conversations.usecase';
import { ListAdminAiMessagesUsecase } from '@src/usecases/admin-document-database/list-admin-ai-messages.usecase';
import { ListAdminAiReportsUsecase } from '@src/usecases/admin-document-database/list-admin-ai-reports.usecase';
import { ListAdminRepairRequestsUsecase } from '@src/usecases/admin-document-database/list-admin-repair-requests.usecase';
import {
  AdminAiConversationPaginatedDTO,
  AdminAiMessagePaginatedDTO,
  AdminAiReportDetailDTO,
  AdminAiReportPaginatedDTO,
  AdminDocumentDatabaseStatsDTO,
  AdminRepairRequestPaginatedDTO,
  AdminRepairRequestRevisionDetailDTO,
  AdminRepairRequestSummaryDTO,
  AdminRepairRevisionResultDTO,
  toAdminAiReportDetailDTO,
  toAdminRepairRequestListItemDTO,
  toAdminRepairRequestRevisionDetailDTO,
  toAdminRepairRequestSummaryDTO,
} from './dto/admin-document-database.dto';
import { AppendRepairRequestRevisionInput } from './dto/append-repair-request-revision.input';
import {
  AdminAiConversationFilterInput,
  AdminAiReportFilterInput,
  AdminRepairRequestFilterInput,
} from './dto/admin-document-database-filter.input';
import { ValidateAdminDocumentDatabaseInput } from './validate-admin-document-database-input.decorator';

/**
 * 管理员文档数据库（PR3 只读聚合）GraphQL 解析器
 *
 * 职责边界（docs/api/adapters.rules.md）：
 * - 只做协议映射：结构校验 → 调用 usecase → 输出 DTO；业务异常不在此捕获，
 *   交由全局过滤器映射为 GraphQL 错误契约；
 * - 输入校验走模块局部 `ValidateAdminDocumentDatabaseInput`（R2）：DTO 校验失败抛
 *   `DomainError(ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS)`，生产环境仍稳定
 *   返回 `BAD_USER_INPUT` + 可读消息（通用 `ValidateInput` 的 BadRequestException
 *   会被生产过滤器降级为 INTERNAL_SERVER_ERROR，不得用于本模块入口）；
 * - 权限口径：守卫层 @Roles(SUPER_ADMIN) 粗准入；精确授权（activeRole === SUPER_ADMIN，
 *   失败关闭）由每个 usecase 首行断言；停用/降级账号旧 Token 由 P0-7 每请求复核；
 * - 工单域提供唯一受控写入口 `appendRepairRequestRevision`（版本条件 + 字段白名单），
 *   其余标签保持只读；排序由契约固定（创建时间倒序 + 主键倒序；
 *   AI 消息为 messageSeq 升序），不采纳客户端排序字段；
 * - 参考资料标签复用既有 referenceDocuments / referenceDocument 查询
 *   （工程师/管理员读契约），本解析器不另建平行链路。
 */
@Resolver()
export class AdminDocumentDatabaseResolver {
  constructor(
    private readonly listAdminRepairRequestsUsecase: ListAdminRepairRequestsUsecase,
    private readonly getAdminRepairRequestSummaryUsecase: GetAdminRepairRequestSummaryUsecase,
    private readonly appendRepairRequestRevisionUsecase: AppendRepairRequestRevisionUsecase,
    private readonly getAdminRepairRequestRevisionDetailUsecase: GetAdminRepairRequestRevisionDetailUsecase,
    private readonly listAdminAiConversationsUsecase: ListAdminAiConversationsUsecase,
    private readonly listAdminAiMessagesUsecase: ListAdminAiMessagesUsecase,
    private readonly listAdminAiReportsUsecase: ListAdminAiReportsUsecase,
    private readonly getAdminAiReportDetailUsecase: GetAdminAiReportDetailUsecase,
    private readonly getAdminDocumentDatabaseStatsUsecase: GetAdminDocumentDatabaseStatsUsecase,
  ) {}

  /**
   * 管理员全局维修申请列表（默认不含软删除；客户关键字经服务端解析为账号集合）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminRepairRequestPaginatedDTO, {
    name: 'adminRepairRequests',
    description: '管理员分页查询维修申请列表（一级全公司，二级限本公司）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async adminRepairRequests(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: AdminRepairRequestFilterInput,
  ): Promise<AdminRepairRequestPaginatedDTO> {
    const page = await this.listAdminRepairRequestsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        // R6：GraphQL nullable 显式 null 在映射边界统一 `?? undefined` 规整，
        // 与省略等价；禁止 truthy 过滤（`false` 必须保留）。
        requestNo: filter?.requestNo ?? undefined,
        customerKeyword: filter?.customerKeyword ?? undefined,
        equipmentModelId: filter?.equipmentModelId ?? undefined,
        errorCode: filter?.errorCode ?? undefined,
        isAccepted: filter?.isAccepted ?? undefined,
        createdAtFrom: filter?.createdAtFrom ?? undefined,
        createdAtTo: filter?.createdAtTo ?? undefined,
      },
    });
    return {
      items: page.items.map(toAdminRepairRequestListItemDTO),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 管理员维修申请只读详情（含已提交过程、客户回复、结单事实与修订历史）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminRepairRequestSummaryDTO, {
    name: 'adminRepairRequestSummary',
    description: '管理员查询维修申请只读详情（仅 SUPER_ADMIN；二级限本公司）',
  })
  async adminRepairRequestSummary(
    @Args({ name: 'id', type: () => Int, description: '维修申请 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<AdminRepairRequestSummaryDTO> {
    const summary = await this.getAdminRepairRequestSummaryUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: id,
    });
    return toAdminRepairRequestSummaryDTO(summary);
  }

  /**
   * 管理员修订已提交工单事实（唯一写入口；一级全公司，二级限可信本公司）。
   * 不代接单、不代写过程/总结，不修改客户原始提交与模型输出。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminRepairRevisionResultDTO, {
    name: 'appendRepairRequestRevision',
    description: '管理员按版本条件修订工单已提交事实（仅 SUPER_ADMIN）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async appendRepairRequestRevision(
    @Args('input') input: AppendRepairRequestRevisionInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminRepairRevisionResultDTO> {
    return this.appendRepairRequestRevisionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      contentMd: input.contentMd ?? undefined,
      handlingResult: input.handlingResult ?? undefined,
      closureReason: input.closureReason ?? undefined,
      processEntries:
        input.processEntries?.map((entry) => ({
          entryId: entry.entryId,
          expectedVersion: entry.expectedVersion,
          operationText: entry.operationText,
          testResult: entry.testResult ?? undefined,
        })) ?? undefined,
      expectedMaintenanceVersion: input.expectedMaintenanceVersion ?? null,
      maintenance: input.maintenance
        ? {
            maintenanceDate: input.maintenance.maintenanceDate ?? null,
            engineerName: input.maintenance.engineerName ?? null,
            resetResult: input.maintenance.resetResult ?? null,
            supplementaryNote: input.maintenance.supplementaryNote ?? null,
            steps: input.maintenance.steps.map((step) => ({
              id: step.id ?? null,
              stepNo: step.stepNo,
              errorCode: step.errorCode ?? null,
              partName: step.partName ?? null,
              actionText: step.actionText,
              resultCode: step.resultCode,
            })),
            panels: input.maintenance.panels.map((panel) => ({
              id: panel.id ?? null,
              panelType: panel.panelType,
              stepNo: panel.stepNo ?? null,
              phaseCode: panel.phaseCode ?? null,
              mainError: panel.mainError ?? null,
              unitError: panel.unitError ?? null,
              source: panel.source ?? null,
              errorType: panel.errorType ?? null,
              gpibStatus: panel.gpibStatus ?? null,
              faultStatus: panel.faultStatus ?? null,
              description: panel.description,
              action: panel.action ?? null,
            })),
          }
        : null,
    });
  }

  /**
   * 管理员查看单个修订版本 / 对比上一版（只读，不提供回滚）。
   *
   * 旧快照缺少可比数据时返回 comparable=false 与明确原因，
   * 不拼接当前工单、不用当前值补齐历史。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminRepairRequestRevisionDetailDTO, {
    name: 'adminRepairRequestRevisionDetail',
    description: '管理员查看工单修订版本与前后快照（仅 SUPER_ADMIN；二级限本公司）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async adminRepairRequestRevisionDetail(
    @Args('requestId', { type: () => Int }) requestId: number,
    @Args('revisionNo', { type: () => Int }) revisionNo: number,
    @currentUser() user: JwtPayload,
  ): Promise<AdminRepairRequestRevisionDetailDTO> {
    const detail = await this.getAdminRepairRequestRevisionDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId,
      revisionNo,
    });
    return toAdminRepairRequestRevisionDetailDTO(detail);
  }

  /**
   * 管理员全局 AI 会话列表（含真实消息数/报告数统计）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminAiConversationPaginatedDTO, {
    name: 'adminAiConversations',
    description: '管理员分页查询全局 AI 会话列表（仅 SUPER_ADMIN）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async adminAiConversations(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: AdminAiConversationFilterInput,
  ): Promise<AdminAiConversationPaginatedDTO> {
    return this.listAdminAiConversationsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        // R6：nullable 映射边界规整（同 adminRepairRequests）
        requestNo: filter?.requestNo ?? undefined,
        engineerKeyword: filter?.engineerKeyword ?? undefined,
        status: filter?.status ?? undefined,
        createdAtFrom: filter?.createdAtFrom ?? undefined,
        createdAtTo: filter?.createdAtTo ?? undefined,
      },
    });
  }

  /**
   * 管理员按会话读取 AI 消息列表（稳定顺序：messageSeq 升序 + 主键升序）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminAiMessagePaginatedDTO, {
    name: 'adminAiMessages',
    description: '管理员按会话分页读取 AI 消息列表（仅 SUPER_ADMIN）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async adminAiMessages(
    @Args({ name: 'conversationId', type: () => Int, description: 'AI 会话 ID' })
    conversationId: number,
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
  ): Promise<AdminAiMessagePaginatedDTO> {
    return this.listAdminAiMessagesUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      conversationId,
      pagination: mapGqlToCoreParams(pagination),
    });
  }

  /**
   * 管理员全局 AI 报告列表（不投影正文大字段）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminAiReportPaginatedDTO, {
    name: 'adminAiReports',
    description: '管理员分页查询全局 AI 报告列表（仅 SUPER_ADMIN）',
  })
  @ValidateAdminDocumentDatabaseInput()
  async adminAiReports(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: AdminAiReportFilterInput,
  ): Promise<AdminAiReportPaginatedDTO> {
    return this.listAdminAiReportsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        // R6：nullable 映射边界规整（同 adminRepairRequests）
        requestNo: filter?.requestNo ?? undefined,
        engineerKeyword: filter?.engineerKeyword ?? undefined,
        reportType: filter?.reportType ?? undefined,
        createdAtFrom: filter?.createdAtFrom ?? undefined,
        createdAtTo: filter?.createdAtTo ?? undefined,
      },
    });
  }

  /**
   * 管理员 AI 报告只读详情（含正文；不提供生成/修改/删除能力）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminAiReportDetailDTO, {
    name: 'adminAiReport',
    description: '管理员查询 AI 报告只读详情（仅 SUPER_ADMIN）',
  })
  async adminAiReport(
    @Args({ name: 'id', type: () => Int, description: 'AI 报告 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<AdminAiReportDetailDTO> {
    const detail = await this.getAdminAiReportDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      reportId: id,
    });
    return toAdminAiReportDetailDTO(detail);
  }

  /**
   * 管理员文档数据库统计（四类总数，口径与各标签默认列表过滤一致）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminDocumentDatabaseStatsDTO, {
    name: 'adminDocumentDatabaseStats',
    description: '管理员查询文档数据库统计（仅 SUPER_ADMIN）',
  })
  async adminDocumentDatabaseStats(
    @currentUser() user: JwtPayload,
  ): Promise<AdminDocumentDatabaseStatsDTO> {
    return this.getAdminDocumentDatabaseStatsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
    });
  }
}
