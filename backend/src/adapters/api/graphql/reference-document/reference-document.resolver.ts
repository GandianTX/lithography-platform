// src/adapters/api/graphql/reference-document/reference-document.resolver.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { AdminDeleteReferenceDocumentUsecase } from '@src/usecases/reference-document/admin-delete-reference-document.usecase';
import { CorrectReferenceDocumentOwnershipUsecase } from '@src/usecases/reference-document/correct-reference-document-ownership.usecase';
import { GetReferenceDocumentDetailUsecase } from '@src/usecases/reference-document/get-reference-document-detail.usecase';
import { GetReferenceDocumentEditableContentUsecase } from '@src/usecases/reference-document/get-reference-document-editable-content.usecase';
import { GetPendingOwnershipReferenceDocumentDetailUsecase } from '@src/usecases/reference-document/get-pending-ownership-reference-document-detail.usecase';
import { ReviseReferenceDocumentStructuredUsecase } from '@src/usecases/reference-document/revise-reference-document-structured.usecase';
import { ListReferenceDocumentRevisionsUsecase } from '@src/usecases/reference-document/list-reference-document-revisions.usecase';
import { ListReferenceDocumentsUsecase } from '@src/usecases/reference-document/list-reference-documents.usecase';
import { ListPendingOwnershipReferenceDocumentsUsecase } from '@src/usecases/reference-document/list-pending-ownership-reference-documents.usecase';
import { OfflineReferenceDocumentUsecase } from '@src/usecases/reference-document/offline-reference-document.usecase';
import { ReviseReferenceDocumentUsecase } from '@src/usecases/reference-document/revise-reference-document.usecase';
import { SoftDeleteReferenceDocumentUsecase } from '@src/usecases/reference-document/soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from '@src/usecases/reference-document/update-reference-document-case.usecase';
import { ReferenceDocumentFilterInput } from './dto/reference-document-filter.input';
import {
  ReferenceDocumentDetailDTO,
  ReferenceDocumentEditableContentDTO,
  ReferenceDocumentPaginatedDTO,
  ReferenceDocumentRevisionsDTO,
} from './dto/reference-document-read.dto';
import {
  AdminDeleteReferenceDocumentInput,
  CorrectReferenceDocumentOwnershipInput,
  OfflineReferenceDocumentInput,
  ReferenceDocumentCaseMutationResultDTO,
  ReferenceDocumentManagedMutationResultDTO,
  ReferenceDocumentMutationResultDTO,
  ReviseReferenceDocumentInput,
  ReviseReferenceDocumentStructuredInput,
  UpdateReferenceDocumentCaseInput,
} from './dto/reference-document-write.dto';

/**
 * 历史维修记录库 GraphQL 解析器
 * 仅做协议映射：结构校验 → 调用 usecase → 输出 DTO
 * 业务异常不在此捕获，交由全局过滤器映射为 GraphQL 错误契约
 *
 * 权限口径（任务 07 确认需求）：
 * - 读（列表/详情/历史版本）：ENGINEER + SUPER_ADMIN；服务端按可信等级决议范围；
 * - 管理修订/下架/管理删除/归属更正（R058–R061）：仅一级管理员（守卫 SUPER_ADMIN
 *   + usecase 内账号等级事实复核）；
 * - softDeleteReferenceDocument（R053）：原作者删除本人正式资料，工程师与管理员
 *   （作为原作者）均可发起，归属与版本由 usecase 裁决；
 * - 旧普通新增（createReferenceDocument）与通用编辑（updateReferenceDocument）
 *   写入口已按确认需求关闭：本期普通资料新增与资料审核取消，历史照常授权读取；
 *   案例专属更正（updateReferenceDocumentCase，A-PR0 §S6）为既有能力保留。
 */
@Resolver(() => ReferenceDocumentDetailDTO)
export class ReferenceDocumentResolver {
  constructor(
    private readonly listReferenceDocumentsUsecase: ListReferenceDocumentsUsecase,
    private readonly getReferenceDocumentDetailUsecase: GetReferenceDocumentDetailUsecase,
    private readonly listPendingOwnershipReferenceDocumentsUsecase: ListPendingOwnershipReferenceDocumentsUsecase,
    private readonly getPendingOwnershipReferenceDocumentDetailUsecase: GetPendingOwnershipReferenceDocumentDetailUsecase,
    private readonly listReferenceDocumentRevisionsUsecase: ListReferenceDocumentRevisionsUsecase,
    private readonly getReferenceDocumentEditableContentUsecase: GetReferenceDocumentEditableContentUsecase,
    private readonly reviseReferenceDocumentUsecase: ReviseReferenceDocumentUsecase,
    private readonly reviseReferenceDocumentStructuredUsecase: ReviseReferenceDocumentStructuredUsecase,
    private readonly offlineReferenceDocumentUsecase: OfflineReferenceDocumentUsecase,
    private readonly adminDeleteReferenceDocumentUsecase: AdminDeleteReferenceDocumentUsecase,
    private readonly correctReferenceDocumentOwnershipUsecase: CorrectReferenceDocumentOwnershipUsecase,
    private readonly updateReferenceDocumentCaseUsecase: UpdateReferenceDocumentCaseUsecase,
    private readonly softDeleteReferenceDocumentUsecase: SoftDeleteReferenceDocumentUsecase,
  ) {}

  /**
   * 查询历史维修记录列表（默认仅未软删；标题模糊 + 类型等值 + 型号等值 + 案例处理状态筛选）
   * 排序由契约固定：创建时间倒序 + 主键倒序；仅支持 OFFSET 分页（usecase 强制）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentPaginatedDTO, {
    description: '查询历史维修记录列表（工程师/管理员）',
  })
  @ValidateInput()
  async referenceDocuments(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: ReferenceDocumentFilterInput,
  ): Promise<ReferenceDocumentPaginatedDTO> {
    const page = await this.listReferenceDocumentsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        title: filter?.title,
        documentType: filter?.documentType,
        equipmentModelId: filter?.equipmentModelId,
        caseHandlingStatus: filter?.caseHandlingStatus,
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
   * 查询历史维修记录详情（元数据 + 生效正文 + 可空案例明细）
   * 不存在、下架、归属未确认、已软删与跨范围统一 NOT_FOUND，不泄露状态与存在性
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentDetailDTO, { description: '查询历史维修记录详情（工程师/管理员）' })
  async referenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentDetailDTO> {
    return this.getReferenceDocumentDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }

  /**
   * 查询历史维修记录的修订版本（生效修订摘要 + 原始冻结报告版本标识）
   * 与列表/详情/下载共用同一服务端可见范围；不可见资料统一 NOT_FOUND
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentRevisionsDTO, {
    description: '查询历史维修记录的修订版本（工程师/管理员）',
  })
  async referenceDocumentRevisions(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentRevisionsDTO> {
    return this.listReferenceDocumentRevisionsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }

  /**
   * 归属待核实清单（任务 07 R061-01，仅一级管理员）：与普通资料库分开的管理入口，
   * 仅返回未软删 + ownership_status = PENDING 的全公司条目及真实 total；
   * 二级管理员、工程师、客户由 usecase 内账号等级事实复核拒绝。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentPaginatedDTO, {
    description: '查询归属待核实资料清单（仅一级管理员）',
  })
  @ValidateInput()
  async pendingOwnershipReferenceDocuments(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentPaginatedDTO> {
    const page = await this.listPendingOwnershipReferenceDocumentsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 归属待核实资料详情（任务 07 R061-01，仅一级管理员）：仅 PENDING 条目可读；
   * 已确认/下架/软删与直接 ID 探测统一 NOT_FOUND，普通正式资料走普通详情查询。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentDetailDTO, {
    description: '查询归属待核实资料详情（仅一级管理员）',
  })
  async pendingOwnershipReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentDetailDTO> {
    return this.getPendingOwnershipReferenceDocumentDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }

  /**
   * 管理修订正式资料（任务 07 R058，仅一级管理员）：编辑当前生效内容并填写原因，
   * 保存后生成新生效版本；原作者冻结内容及旧管理版本保留供授权追溯。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentManagedMutationResultDTO, {
    description: '管理修订正式资料（仅一级管理员）',
  })
  @ValidateInput()
  async reviseReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: ReviseReferenceDocumentInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentManagedMutationResultDTO> {
    return this.reviseReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      patch: {
        title: input.title,
        description: input.description,
        contentText: input.contentText,
      },
    });
  }

  /**
   * 管理修订编辑初值（任务 07，独立管理修订页专用，仅一级管理员）：
   * 结构化模式返回当前生效结构化内容（冻结版本派生或修订快照），
   * 扁平模式返回生效正文文本（普通资料/旧扁平修订，不伪造故障数据）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentEditableContentDTO, {
    description: '查询管理修订编辑初值（仅一级管理员）',
  })
  async referenceDocumentEditableContent(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentEditableContentDTO> {
    return this.getReferenceDocumentEditableContentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }

  /**
   * 结构化管理修订正式资料（任务 07，报告来源正式资料；仅一级管理员）：
   * 结构化内容全量提交 + 原因必填；分支启用条件与稳定关联由 usecase 裁决；
   * 生成资料管理版本，不修改原始冻结报告与来源工单。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentManagedMutationResultDTO, {
    description: '结构化管理修订正式资料（仅一级管理员）',
  })
  @ValidateInput()
  async reviseReferenceDocumentStructured(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: ReviseReferenceDocumentStructuredInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentManagedMutationResultDTO> {
    return this.reviseReferenceDocumentStructuredUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      patch: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.structured !== undefined
          ? {
              structured: {
                schemaVersion: input.structured.schemaVersion,
                maintenanceDate: input.structured.maintenanceDate,
                maintenanceEngineerName: input.structured.maintenanceEngineerName,
                customerFactoryName: input.structured.customerFactoryName,
                resetResult: input.structured.resetResult,
                faults: input.structured.faults.map((fault) => ({ ...fault })),
                steps: input.structured.steps.map((step) => ({ ...step })),
                ...(input.structured.handlingResult !== undefined
                  ? { handlingResult: input.structured.handlingResult }
                  : {}),
                ...(input.structured.closureReason !== undefined
                  ? { closureReason: input.structured.closureReason }
                  : {}),
                ...(input.structured.actualCause !== undefined
                  ? { actualCause: input.structured.actualCause }
                  : {}),
                ...(input.structured.repairActions !== undefined
                  ? { repairActions: input.structured.repairActions }
                  : {}),
                ...(input.structured.verificationResult !== undefined
                  ? { verificationResult: input.structured.verificationResult }
                  : {}),
                ...(input.structured.supplementaryNote !== undefined
                  ? { supplementaryNote: input.structured.supplementaryNote }
                  : {}),
              },
            }
          : {}),
        ...(input.equipmentModelId !== undefined
          ? { equipmentModelId: input.equipmentModelId }
          : {}),
      },
    });
  }

  /**
   * 下架正式资料（任务 07 R059，仅一级管理员）：发布状态置 OFFLINE 并保存生效
   * 版本及业务历史；不写三类关键操作记录，不清来源或有效原件。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentManagedMutationResultDTO, {
    description: '下架正式资料（仅一级管理员）',
  })
  @ValidateInput()
  async offlineReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: OfflineReferenceDocumentInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentManagedMutationResultDTO> {
    return this.offlineReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
    });
  }

  /**
   * 管理删除正式资料（任务 07 R060，仅一级管理员）：软删除、生效版本、历史及
   * 管理员关键记录同事务保存；不物理删除来源与有效原件，不新增回收站。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentManagedMutationResultDTO, {
    description: '管理删除正式资料（仅一级管理员）',
  })
  @ValidateInput()
  async adminDeleteReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: AdminDeleteReferenceDocumentInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentManagedMutationResultDTO> {
    return this.adminDeleteReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
    });
  }

  /**
   * 保存资料归属更正（任务 07 R061-02，仅一级管理员）：仅更正显式提交字段，
   * 原因必填；更换上传者不自动采用其当前公司；关键记录与业务变更同事务写入。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentManagedMutationResultDTO, {
    description: '保存资料归属更正（仅一级管理员）',
  })
  @ValidateInput()
  async correctReferenceDocumentOwnership(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: CorrectReferenceDocumentOwnershipInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentManagedMutationResultDTO> {
    return this.correctReferenceDocumentOwnershipUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion: input.expectedVersion,
      verificationReason: input.verificationReason,
      createdByAccountId: input.createdByAccountId,
      ownerOrganizationId: input.ownerOrganizationId,
    });
  }

  /**
   * 更正正式案例资料（仅 SUPER_ADMIN；A-PR0 §S6 专属更正，既有能力保留）
   * 仅 FAULT_CASE 资料可用；合并允许字段后重新生成可读正文并与明细同事务更新
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentCaseMutationResultDTO, {
    description: '更正正式案例资料（仅管理员；仅案例资料）',
  })
  @ValidateInput()
  async updateReferenceDocumentCase(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args('input') input: UpdateReferenceDocumentCaseInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentCaseMutationResultDTO> {
    return this.updateReferenceDocumentCaseUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      patch: {
        title: input.title,
        equipmentModelId: input.equipmentModelId,
        equipmentModelText: input.equipmentModelText,
        description: input.description,
        errorCode: input.errorCode,
        phenomenon: input.phenomenon,
        conditionText: input.conditionText,
        reproductionSteps: input.reproductionSteps,
        diagnosis: input.diagnosis,
        actionTaken: input.actionTaken,
        handlingStatus: input.handlingStatus,
        resolution: input.resolution,
      },
    });
  }

  /**
   * 原作者删除本人正式资料（任务 07 R053）：deprecated + deleted_at + 生效版本 +
   * 修订历史同事务写入，不物理删除；管理员作为原作者删除时补写关键记录。
   * 不存在与已软删统一 NOT_FOUND，不泄露删除状态。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentMutationResultDTO, {
    description: '原作者删除本人正式资料（R053）',
  })
  async softDeleteReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '历史维修记录 ID' }) id: number,
    @Args({ name: 'expectedVersion', type: () => Int, description: '期望生效版本号' })
    expectedVersion: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentMutationResultDTO> {
    return this.softDeleteReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      expectedVersion,
    });
  }
}
