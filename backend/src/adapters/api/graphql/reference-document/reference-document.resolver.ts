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
import { CreateReferenceDocumentUsecase } from '@src/usecases/reference-document/create-reference-document.usecase';
import { GetReferenceDocumentDetailUsecase } from '@src/usecases/reference-document/get-reference-document-detail.usecase';
import { ListReferenceDocumentsUsecase } from '@src/usecases/reference-document/list-reference-documents.usecase';
import { SoftDeleteReferenceDocumentUsecase } from '@src/usecases/reference-document/soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from '@src/usecases/reference-document/update-reference-document-case.usecase';
import { UpdateReferenceDocumentUsecase } from '@src/usecases/reference-document/update-reference-document.usecase';
import { ReferenceDocumentFilterInput } from './dto/reference-document-filter.input';
import {
  ReferenceDocumentDetailDTO,
  ReferenceDocumentPaginatedDTO,
} from './dto/reference-document-read.dto';
import {
  CreateReferenceDocumentInput,
  ReferenceDocumentCaseMutationResultDTO,
  ReferenceDocumentMutationResultDTO,
  UpdateReferenceDocumentCaseInput,
  UpdateReferenceDocumentInput,
} from './dto/reference-document-write.dto';

/**
 * AI 参考资料库 GraphQL 解析器
 * 仅做协议映射：结构校验 → 调用 usecase → 输出 DTO
 * 业务异常不在此捕获，交由全局过滤器映射为 GraphQL 错误契约
 *
 * 权限口径（0907.docx 任务二）：
 * - 读（列表/详情）：ENGINEER + SUPER_ADMIN（守卫显式列出，超管继承在 usecase hasRole 生效）
 * - 写（创建/编辑/软删除）：仅 SUPER_ADMIN；工程师第一版不负责增删资料
 */
@Resolver(() => ReferenceDocumentDetailDTO)
export class ReferenceDocumentResolver {
  constructor(
    private readonly listReferenceDocumentsUsecase: ListReferenceDocumentsUsecase,
    private readonly getReferenceDocumentDetailUsecase: GetReferenceDocumentDetailUsecase,
    private readonly createReferenceDocumentUsecase: CreateReferenceDocumentUsecase,
    private readonly updateReferenceDocumentUsecase: UpdateReferenceDocumentUsecase,
    private readonly updateReferenceDocumentCaseUsecase: UpdateReferenceDocumentCaseUsecase,
    private readonly softDeleteReferenceDocumentUsecase: SoftDeleteReferenceDocumentUsecase,
  ) {}

  /**
   * 查询本组织参考资料列表（默认仅未软删；标题模糊 + 类型等值 + 型号等值 + 案例处理状态筛选）
   * 排序由契约固定：创建时间倒序 + 主键倒序；仅支持 OFFSET 分页（usecase 强制）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentPaginatedDTO, { description: '查询参考资料列表（工程师/管理员）' })
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
   * 查询本组织参考资料详情（元数据 + 文本内容 + 可空案例明细）
   * 不存在、已软删与跨组织统一 NOT_FOUND（usecase/QueryService 口径），不泄露存在性
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ReferenceDocumentDetailDTO, { description: '查询参考资料详情（工程师/管理员）' })
  async referenceDocument(
    @Args({ name: 'id', type: () => Int, description: '参考资料 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentDetailDTO> {
    return this.getReferenceDocumentDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }

  /**
   * 创建参考资料（仅 SUPER_ADMIN）
   * 创建人取自会话，客户端不可传入；contentText 必填（本周仅文本内容来源）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentMutationResultDTO, { description: '创建参考资料（仅管理员）' })
  @ValidateInput()
  async createReferenceDocument(
    @Args('input') input: CreateReferenceDocumentInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentMutationResultDTO> {
    return this.createReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      title: input.title,
      documentType: input.documentType,
      equipmentModelId: input.equipmentModelId,
      description: input.description,
      contentText: input.contentText,
    });
  }

  /**
   * 编辑参考资料（仅 SUPER_ADMIN；字段范围=标题/类型/型号/说明/文本内容）
   * 不提供替换二进制文件；需要替换时新增一份资料再软删除旧资料
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentMutationResultDTO, { description: '编辑参考资料（仅管理员）' })
  @ValidateInput()
  async updateReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '参考资料 ID' }) id: number,
    @Args('input') input: UpdateReferenceDocumentInput,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentMutationResultDTO> {
    return this.updateReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
      patch: {
        title: input.title,
        documentType: input.documentType,
        equipmentModelId: input.equipmentModelId,
        description: input.description,
        contentText: input.contentText,
      },
    });
  }

  /**
   * 更正正式案例资料（仅 SUPER_ADMIN；A-PR0 §S6 专属更正）
   * 仅 FAULT_CASE 资料可用；合并允许字段后重新生成可读正文并与明细同事务更新；
   * 类型/归属组织/来源与原附件不可通过本接口修改；普通资料仍用通用编辑接口
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentCaseMutationResultDTO, {
    description: '更正正式案例资料（仅管理员；仅案例资料）',
  })
  @ValidateInput()
  async updateReferenceDocumentCase(
    @Args({ name: 'id', type: () => Int, description: '参考资料 ID' }) id: number,
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
   * 软删除参考资料（仅 SUPER_ADMIN；deprecated + deleted_at 同步写入，不物理删除）
   * 不存在与已软删统一 NOT_FOUND，不泄露删除状态
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ReferenceDocumentMutationResultDTO, {
    description: '软删除参考资料（仅管理员）',
  })
  async softDeleteReferenceDocument(
    @Args({ name: 'id', type: () => Int, description: '参考资料 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ReferenceDocumentMutationResultDTO> {
    return this.softDeleteReferenceDocumentUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      documentId: id,
    });
  }
}
