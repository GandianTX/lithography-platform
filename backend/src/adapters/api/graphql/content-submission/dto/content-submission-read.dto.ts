// src/adapters/api/graphql/content-submission/dto/content-submission-read.dto.ts
// 投稿域读侧与 mutation 结果输出对象（A-PR0 §4.1）
// 不返回 storageReference / 存储后端 / 服务器路径 / 审核人账号 ID / 内部扩展 JSON；
// payloadSnapshot 为冻结版本的业务字段快照（写入时已剔除存储引用与服务器路径）

import { Field, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';

/**
 * 草稿写操作结果（创建/修改共用）：返回真实保存状态（write-then-read 回读，
 * 不回显请求入参里的状态值）。
 */
@ObjectType({ description: '投稿草稿写操作结果（真实保存状态）' })
export class ContentSubmissionDraftMutationResultDTO {
  @Field(() => Int, { description: '投稿 ID' })
  id!: number;

  @Field(() => String, { description: '投稿类别：MATERIAL / FAULT_CASE' })
  submissionKind!: string;

  @Field(() => String, { description: '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED' })
  status!: string;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;
}

/** 本人投稿列表项输出对象（无他人记录；草稿标题可为空） */
@ObjectType({ description: '投稿列表项' })
export class ContentSubmissionListItemDTO {
  @Field(() => Int, { description: '投稿 ID' })
  id!: number;

  @Field(() => String, { nullable: true, description: '标题（草稿可为空）' })
  title?: string | null;

  @Field(() => String, { description: '投稿类别：MATERIAL / FAULT_CASE' })
  submissionKind!: string;

  @Field(() => String, { description: '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED' })
  status!: string;

  @Field(() => Int, { description: '当前版本号（未送审为 0）' })
  currentRevisionNo!: number;

  @Field(() => Date, { nullable: true, description: '最近送审时间；未送审为空' })
  lastSubmittedAt?: Date | null;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

/** 投稿列表分页输出（OFFSET：items/total/page/pageSize） */
@ObjectType({ description: '投稿分页结果' })
export class ContentSubmissionPaginatedDTO extends paginatedTypeFactory(
  ContentSubmissionListItemDTO,
) {}

/** 私有附件安全元数据（无存储引用与服务器路径） */
@ObjectType({ description: '投稿附件安全元数据' })
export class ContentSubmissionAttachmentMetaDTO {
  @Field(() => Int, { description: '附件 ID（下载时传回）' })
  id!: number;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型（服务端按扩展名映射落库）' })
  mimeType!: string;

  @Field(() => Int, { description: '实际字节数' })
  byteSize!: number;

  @Field(() => Date, { description: '上传时间' })
  uploadedAt!: Date;
}

/** 最近审核稳定视图（未审核为空） */
@ObjectType({ description: '投稿最近审核事实' })
export class ContentSubmissionLatestReviewDTO {
  @Field(() => String, { description: '审核决定：RETURN / APPROVE' })
  decision!: string;

  @Field(() => String, { nullable: true, description: '审核意见（退回必填、通过可选）' })
  comment?: string | null;

  @Field(() => Boolean, { description: '附件发布决定（退回恒为 false）' })
  publishAttachment!: boolean;

  @Field(() => Date, { description: '审核时间' })
  reviewedAt!: Date;
}

/** 已发布正式资料关联（available 表示正式资料未被软删；已下架保留 ID 但不可用） */
@ObjectType({ description: '已发布正式资料关联' })
export class ContentSubmissionPublishedDocumentDTO {
  @Field(() => Int, { description: '正式参考资料 ID' })
  documentId!: number;

  @Field(() => Boolean, { description: '正式资料是否可用（未被软删）' })
  available!: boolean;
}

/** 普通资料明细稳定视图（草稿字段可空） */
@ObjectType({ description: '普通资料投稿明细（草稿字段可空）' })
export class MaterialSubmissionDetailDTO {
  @Field(() => String, { nullable: true, description: '标题' })
  title?: string | null;

  @Field(() => String, { nullable: true, description: '资料类型（不可为 FAULT_CASE）' })
  documentType?: string | null;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '适用设备型号名称' })
  equipmentModelName?: string | null;

  @Field(() => String, { nullable: true, description: '机型文字（与机型 ID 互斥）' })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '说明' })
  description?: string | null;

  @Field(() => String, { nullable: true, description: '正文' })
  contentText?: string | null;
}

/** 故障案例明细稳定视图（草稿字段可空） */
@ObjectType({ description: '故障案例投稿明细（草稿字段可空）' })
export class FaultCaseSubmissionDetailDTO {
  @Field(() => String, { nullable: true, description: '标题' })
  title?: string | null;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '适用设备型号名称' })
  equipmentModelName?: string | null;

  @Field(() => String, { nullable: true, description: '机型文字（与机型 ID 互斥）' })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '设备错误码（保留大小写与内部符号）' })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '故障现象' })
  phenomenon?: string | null;

  @Field(() => String, { nullable: true, description: '触发条件' })
  conditionText?: string | null;

  @Field(() => String, { nullable: true, description: '复现步骤' })
  reproductionSteps?: string | null;

  @Field(() => String, { nullable: true, description: '排查过程' })
  diagnosis?: string | null;

  @Field(() => String, { nullable: true, description: '处理措施' })
  actionTaken?: string | null;

  @Field(() => String, { nullable: true, description: '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED' })
  handlingStatus?: string | null;

  @Field(() => String, { nullable: true, description: '处理结果（已解决时必填）' })
  resolution?: string | null;
}

/**
 * 本人投稿详情输出对象（A-PR0 §4.1 `myContentSubmission`）：
 * 当前稿（按类别恰好一类明细非空）、当前状态、最近审核、版本入口与已发布正式资料关联。
 */
@ObjectType({ description: '本人投稿详情' })
export class ContentSubmissionMineDetailDTO {
  @Field(() => Int, { description: '投稿 ID' })
  id!: number;

  @Field(() => String, { description: '投稿类别：MATERIAL / FAULT_CASE' })
  submissionKind!: string;

  @Field(() => String, { description: '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED' })
  status!: string;

  @Field(() => Int, { description: '当前版本号（未送审为 0）' })
  currentRevisionNo!: number;

  @Field(() => Date, { nullable: true, description: '最近送审时间；未送审为空' })
  lastSubmittedAt?: Date | null;

  @Field(() => Date, { nullable: true, description: '发布通过时间；未发布为空' })
  publishedAt?: Date | null;

  @Field(() => MaterialSubmissionDetailDTO, {
    nullable: true,
    description: '普通资料明细（仅普通资料投稿非空）',
  })
  material?: MaterialSubmissionDetailDTO | null;

  @Field(() => FaultCaseSubmissionDetailDTO, {
    nullable: true,
    description: '故障案例明细（仅案例投稿非空）',
  })
  faultCase?: FaultCaseSubmissionDetailDTO | null;

  @Field(() => ContentSubmissionAttachmentMetaDTO, {
    nullable: true,
    description: '当前附件安全元数据（无当前附件为空）',
  })
  currentAttachment?: ContentSubmissionAttachmentMetaDTO | null;

  @Field(() => ContentSubmissionLatestReviewDTO, {
    nullable: true,
    description: '最近审核事实（未审核为空）',
  })
  latestReview?: ContentSubmissionLatestReviewDTO | null;

  @Field(() => ContentSubmissionPublishedDocumentDTO, {
    nullable: true,
    description: '已发布正式资料关联（未发布为空）',
  })
  publishedDocument?: ContentSubmissionPublishedDocumentDTO | null;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;
}

/**
 * 冻结版本输出对象（A-PR0 §4.1 `contentSubmissionRevision`）：
 * 本人或本组织管理员可读；含完整内容快照、附件安全元数据与版本审核记录（至多一条）。
 */
@ObjectType({ description: '投稿冻结版本' })
export class ContentSubmissionRevisionDTO {
  @Field(() => Int, { description: '版本 ID' })
  revisionId!: number;

  @Field(() => Int, { description: '投稿 ID' })
  submissionId!: number;

  @Field(() => String, { description: '投稿类别：MATERIAL / FAULT_CASE' })
  submissionKind!: string;

  @Field(() => Int, { description: '版本号（从 1 开始单调递增）' })
  revisionNo!: number;

  @Field(() => Int, { description: '明细 schema 版本（当前为 1）' })
  schemaVersion!: number;

  @Field(() => String, { description: '送审时标题快照' })
  titleSnapshot!: string;

  @Field(() => GraphQLJSON, {
    description: '业务字段完整快照（不含存储引用与服务器路径；字段随类别而定）',
  })
  payloadSnapshot!: Record<string, unknown>;

  @Field(() => ContentSubmissionAttachmentMetaDTO, {
    nullable: true,
    description: '该版本冻结的附件安全元数据（无附件为空）',
  })
  attachment?: ContentSubmissionAttachmentMetaDTO | null;

  @Field(() => String, { description: '入库告知版本（服务端固定，如 library-internal-v1）' })
  noticeVersion!: string;

  @Field(() => Date, { description: '入库告知确认时间' })
  confirmedAt!: Date;

  @Field(() => Date, { description: '送审时间' })
  submittedAt!: Date;

  @Field(() => ContentSubmissionLatestReviewDTO, {
    nullable: true,
    description: '该版本审核记录（至多一条；未审核为空）',
  })
  review?: ContentSubmissionLatestReviewDTO | null;
}

/** 历史审核条目（跨版本，审核详情历史区；不含审核人账号 ID） */
@ObjectType({ description: '投稿历史审核条目' })
export class ContentSubmissionReviewHistoryItemDTO {
  @Field(() => Int, { description: '版本 ID' })
  revisionId!: number;

  @Field(() => Int, { description: '版本号' })
  revisionNo!: number;

  @Field(() => String, { description: '审核决定：RETURN / APPROVE' })
  decision!: string;

  @Field(() => String, { nullable: true, description: '审核意见' })
  comment?: string | null;

  @Field(() => Boolean, { description: '附件发布决定' })
  publishAttachment!: boolean;

  @Field(() => Date, { description: '审核时间' })
  reviewedAt!: Date;
}

/**
 * 审核详情输出对象（A-PR0 §4.1 `reviewContentSubmission`）：
 * 当前版本完整视图（无版本时为空）+ 全部历史审核（新在前）+ 投稿基础事实。
 */
@ObjectType({ description: '投稿审核详情' })
export class ContentSubmissionReviewDetailDTO {
  @Field(() => Int, { description: '投稿 ID' })
  submissionId!: number;

  @Field(() => String, { description: '投稿类别：MATERIAL / FAULT_CASE' })
  submissionKind!: string;

  @Field(() => String, { description: '投稿状态：DRAFT/PENDING_REVIEW/RETURNED/PUBLISHED' })
  status!: string;

  @Field(() => Int, { description: '当前版本号（未送审为 0）' })
  currentRevisionNo!: number;

  @Field(() => Date, { nullable: true, description: '最近送审时间；未送审为空' })
  lastSubmittedAt?: Date | null;

  @Field(() => Int, { description: '投稿人账号 ID（仅审核链路返回，供管理员联系投稿人）' })
  submittedByAccountId!: number;

  @Field(() => ContentSubmissionRevisionDTO, {
    nullable: true,
    description: '当前版本完整视图（未送审为空）',
  })
  currentRevision?: ContentSubmissionRevisionDTO | null;

  @Field(() => [ContentSubmissionReviewHistoryItemDTO], {
    description: '全部历史审核（新在前）',
  })
  reviewHistory!: ContentSubmissionReviewHistoryItemDTO[];
}

/** 送审结果（新版本 ID/版本号 + 真实落库状态 PENDING_REVIEW） */
@ObjectType({ description: '送审结果' })
export class ContentSubmissionSubmitResultDTO {
  @Field(() => Int, { description: '投稿 ID' })
  submissionId!: number;

  @Field(() => Int, { description: '新版本 ID' })
  revisionId!: number;

  @Field(() => Int, { description: '新版本号' })
  revisionNo!: number;

  @Field(() => String, { description: '投稿状态（PENDING_REVIEW）' })
  status!: string;
}

/**
 * 审核决定结果（退回/通过共用；退回不产生正式资料，documentId 恒为空）。
 * 通过返回新正式资料 ID；重复/并发决定最多一次成功，失败方返回冲突/未找到。
 */
@ObjectType({ description: '审核决定结果' })
export class ContentSubmissionReviewDecisionResultDTO {
  @Field(() => Int, { description: '投稿 ID' })
  submissionId!: number;

  @Field(() => String, { description: '投稿状态' })
  status!: string;

  @Field(() => Int, {
    nullable: true,
    description: '通过的正式资料 ID；退回为空',
  })
  documentId?: number | null;
}
