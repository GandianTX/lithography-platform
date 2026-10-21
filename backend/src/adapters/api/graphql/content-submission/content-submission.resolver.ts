// src/adapters/api/graphql/content-submission/content-submission.resolver.ts
// 投稿域 GraphQL 解析器（A-PR0 §4.1：草稿、本人查询、冻结版本、送审、审核队列/详情、审核决定）
// 仅做协议映射：结构校验 → 调用 usecase → 输出 DTO
// 业务异常不在此捕获，交由全局过滤器映射为 GraphQL 错误契约
//
// 权限口径（A-PR0 §2.1/§4.1）：
// - 本人链路（草稿创建/修改、本人列表/详情、送审）：ENGINEER（usecase 内再以精确
//   activeRole 与本人归属裁决）；
// - 冻结版本读取：ENGINEER + SUPER_ADMIN（usecase 内裁决本人或本组织当前管理员）；
// - 审核链路（队列/详情/决定）：SUPER_ADMIN（usecase 内再以精确 activeRole 裁决）。
// 客户端不传入创建人 / 组织 / 审核状态；组织与归属一律由 usecase 从可信事实裁定。

import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { ApproveContentSubmissionUsecase } from '@src/usecases/content-submission/approve-content-submission.usecase';
import { CreateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/create-content-submission-draft.usecase';
import { GetContentSubmissionRevisionUsecase } from '@src/usecases/content-submission/get-content-submission-revision.usecase';
import { GetMyContentSubmissionUsecase } from '@src/usecases/content-submission/get-my-content-submission.usecase';
import { GetReviewDetailUsecase } from '@src/usecases/content-submission/get-review-detail.usecase';
import { ListMyContentSubmissionsUsecase } from '@src/usecases/content-submission/list-my-content-submissions.usecase';
import { ListReviewQueueUsecase } from '@src/usecases/content-submission/list-review-queue.usecase';
import { ReturnContentSubmissionUsecase } from '@src/usecases/content-submission/return-content-submission.usecase';
import { SubmitContentSubmissionUsecase } from '@src/usecases/content-submission/submit-content-submission.usecase';
import { UpdateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/update-content-submission-draft.usecase';

import { ContentSubmissionFilterInput } from './dto/content-submission-filter.input';
import {
  ContentSubmissionDraftMutationResultDTO,
  ContentSubmissionMineDetailDTO,
  ContentSubmissionPaginatedDTO,
  ContentSubmissionReviewDecisionResultDTO,
  ContentSubmissionReviewDetailDTO,
  ContentSubmissionRevisionDTO,
  ContentSubmissionSubmitResultDTO,
} from './dto/content-submission-read.dto';
import {
  CreateContentSubmissionDraftInput,
  ReviewContentSubmissionDecisionInput,
  SubmitContentSubmissionInput,
  UpdateContentSubmissionDraftInput,
} from './dto/content-submission-write.input';

@Resolver(() => ContentSubmissionMineDetailDTO)
export class ContentSubmissionResolver {
  constructor(
    private readonly createContentSubmissionDraftUsecase: CreateContentSubmissionDraftUsecase,
    private readonly updateContentSubmissionDraftUsecase: UpdateContentSubmissionDraftUsecase,
    private readonly listMyContentSubmissionsUsecase: ListMyContentSubmissionsUsecase,
    private readonly getMyContentSubmissionUsecase: GetMyContentSubmissionUsecase,
    private readonly submitContentSubmissionUsecase: SubmitContentSubmissionUsecase,
    private readonly getContentSubmissionRevisionUsecase: GetContentSubmissionRevisionUsecase,
    private readonly listReviewQueueUsecase: ListReviewQueueUsecase,
    private readonly getReviewDetailUsecase: GetReviewDetailUsecase,
    private readonly returnContentSubmissionUsecase: ReturnContentSubmissionUsecase,
    private readonly approveContentSubmissionUsecase: ApproveContentSubmissionUsecase,
  ) {}

  /**
   * 查询本人投稿列表（仅本人记录；标题模糊 + 类别等值 + 状态等值筛选）。
   * 排序由契约固定：更新时间倒序 + 主键倒序；仅支持 OFFSET 分页（usecase 强制）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => ContentSubmissionPaginatedDTO, { description: '查询本人投稿列表（工程师）' })
  @ValidateInput()
  async myContentSubmissions(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选）' })
    filter?: ContentSubmissionFilterInput,
  ): Promise<ContentSubmissionPaginatedDTO> {
    const page = await this.listMyContentSubmissionsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        title: filter?.title,
        submissionKind: filter?.submissionKind,
        status: filter?.status,
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
   * 查询本人投稿详情（当前稿、当前状态、最近审核、版本入口、已发布正式资料关联）。
   * 非本人投稿统一 NOT_FOUND（不泄露存在性）；审核通过接口读取时使用 reviewContentSubmission。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Query(() => ContentSubmissionMineDetailDTO, { description: '查询本人投稿详情（工程师）' })
  async myContentSubmission(
    @Args({ name: 'id', type: () => Int, description: '投稿 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionMineDetailDTO> {
    return this.getMyContentSubmissionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      submissionId: id,
    });
  }

  /**
   * 查询冻结版本（本人或本组织管理员可读；版本由 submissionId + revisionNo 定位）。
   * 归属裁决在 usecase 内进行，非授权范围统一 NOT_FOUND。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ContentSubmissionRevisionDTO, {
    description: '查询投稿冻结版本（本人或本组织管理员）',
  })
  @ValidateInput()
  async contentSubmissionRevision(
    @Args({ name: 'submissionId', type: () => Int, description: '投稿 ID' }) submissionId: number,
    @Args({ name: 'revisionNo', type: () => Int, description: '版本号（从 1 开始）' })
    revisionNo: number,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionRevisionDTO> {
    return this.getContentSubmissionRevisionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      submissionId,
      revisionNo,
    });
  }

  /**
   * 查询审核队列（仅本组织管理员；缺省待审，标题/类别/状态筛选）。
   * 排序由契约固定：送审时间倒序 + 主键倒序。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ContentSubmissionPaginatedDTO, { description: '查询投稿审核队列（管理员）' })
  @ValidateInput()
  async reviewContentSubmissions(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', { nullable: true, description: '筛选条件（均可选；status 缺省为待审）' })
    filter?: ContentSubmissionFilterInput,
  ): Promise<ContentSubmissionPaginatedDTO> {
    const page = await this.listReviewQueueUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
      filter: {
        title: filter?.title,
        submissionKind: filter?.submissionKind,
        status: filter?.status,
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
   * 查询审核详情（仅本组织管理员）：当前版本完整视图 + 全部历史审核 + 投稿基础事实。
   * 非本组织投稿统一 NOT_FOUND。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ContentSubmissionReviewDetailDTO, { description: '查询投稿审核详情（管理员）' })
  async reviewContentSubmission(
    @Args({ name: 'id', type: () => Int, description: '投稿 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionReviewDetailDTO> {
    return this.getReviewDetailUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      submissionId: id,
    });
  }

  /**
   * 新建投稿草稿（仅本人来源；创建人/组织由服务端从会话与可信事实确定）。
   * 保存草稿只要求一个非空文字业务字段；返回真实保存状态。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => ContentSubmissionDraftMutationResultDTO, {
    description: '新建投稿草稿（工程师）',
  })
  @ValidateInput()
  async createContentSubmissionDraft(
    @Args('input') input: CreateContentSubmissionDraftInput,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionDraftMutationResultDTO> {
    return this.createContentSubmissionDraftUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      kind: input.kind,
      fields: input.fields,
    });
  }

  /**
   * 修改投稿草稿（仅本人 DRAFT/RETURNED；类别不变；未提供字段保持原值）。
   * 返回真实保存状态（write-then-read 回读）。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => ContentSubmissionDraftMutationResultDTO, {
    description: '修改投稿草稿（工程师）',
  })
  @ValidateInput()
  async updateContentSubmissionDraft(
    @Args({ name: 'id', type: () => Int, description: '投稿 ID' }) id: number,
    @Args('input') input: UpdateContentSubmissionDraftInput,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionDraftMutationResultDTO> {
    return this.updateContentSubmissionDraftUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      submissionId: id,
      patch: input.patch,
    });
  }

  /**
   * 送审 / 重提（仅本人 DRAFT/RETURNED）：从已保存稿冻结出新版本。
   * 不接受客户端自报状态、所有者、版本号；返回新版本 ID/版本号与真实状态。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => ContentSubmissionSubmitResultDTO, { description: '提交投稿审核（工程师）' })
  @ValidateInput()
  async submitContentSubmission(
    @Args({ name: 'id', type: () => Int, description: '投稿 ID' }) id: number,
    @Args('input') input: SubmitContentSubmissionInput,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionSubmitResultDTO> {
    return this.submitContentSubmissionUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      submissionId: id,
      libraryNoticeConfirmed: input.libraryNoticeConfirmed,
    });
  }

  /**
   * 审核决定（仅本组织管理员）：RETURN 退回 / APPROVE 通过。
   * 仅接受当前待审 revisionId（行锁内核对）；通过时按 publishAttachment 决定是否发布附件。
   * 协议层仅按 decision 分派到既有用例，不在 resolver 内重建业务判断。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => ContentSubmissionReviewDecisionResultDTO, {
    description: '投稿审核决定：退回/通过（管理员）',
  })
  @ValidateInput()
  async reviewContentSubmissionDecision(
    @Args('input') input: ReviewContentSubmissionDecisionInput,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionReviewDecisionResultDTO> {
    const session = mapJwtToUsecaseSession(user);

    if (input.decision === 'RETURN') {
      return this.returnContentSubmissionUsecase.execute({
        session,
        submissionId: input.submissionId,
        revisionId: input.revisionId,
        comment: input.comment ?? null,
      });
    }

    return this.approveContentSubmissionUsecase.execute({
      session,
      submissionId: input.submissionId,
      revisionId: input.revisionId,
      comment: input.comment ?? null,
      publishAttachment: input.publishAttachment ?? false,
    });
  }
}
