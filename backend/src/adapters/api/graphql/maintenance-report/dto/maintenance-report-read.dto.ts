// src/adapters/api/graphql/maintenance-report/dto/maintenance-report-read.dto.ts
// 我的资料记录读模型（任务 07）：本人报告/工单总结的列表与只读详情。
// 与任务 06 编辑器读侧（maintenance-report.dto.ts）并行：本文件承载独立查询
// myMaintenanceRecordList / myMaintenanceRecordDetail 的输出契约，类名以 MyRecord 前缀
// 与任务 06 DTO 区分，避免 GraphQL 类型重名。
// 不返回组织内部 ID、账号 ID、存储引用与原始冻结快照 JSON。

import { Field, Int, ObjectType } from '@nestjs/graphql';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';

/**
 * 同步状态展示（任务 07 预留，对接草案 §4）：任务 09 未接入前恒为 NOT_CONNECTED。
 * 展示状态，不是同步表枚举透传；message 仅限面向用户的安全提示。
 * 注意：必须定义在 MyRecordSummaryDTO 之前——emitDecoratorMetadata 会对
 * design:type 急切求值，前向引用会触发运行时 TDZ（启动期 ReferenceError）。
 */
@ObjectType({ description: '记录同步状态展示' })
export class MyRecordSyncStatusDTO {
  @Field(() => String, {
    description:
      'NOT_CONNECTED=任务 09 未装配；UNKNOWN=映射缺失或查询失败；' +
      'NOT_APPLICABLE/NO_TASK/PENDING/UPLOADING/FAILED/SYNCED/CONFLICT 由任务 09 裁决',
  })
  status!: string;

  @Field(() => String, {
    nullable: true,
    description: '面向用户的安全提示（不含快照、回执正文、内部错误或文件路径）',
  })
  message?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '当前版本未解决冲突标识（任务 09 提供；处理时仍须重新核权）',
  })
  conflictId?: string | null;

  @Field(() => Boolean, {
    description: '是否允许展示「处理冲突」入口；处理路由本轮不接入，不放占位跳转',
  })
  canResolveConflict!: boolean;
}

/** 本人记录列表项：摘要 + 已发布正式资料标识 */
@ObjectType({ description: '本人维修记录列表项' })
export class MyRecordSummaryDTO {
  @Field(() => Int, { description: '报告 ID（本人记录的稳定标识）' })
  id!: number;

  @Field(() => String, {
    description: '来源类型：HISTORICAL_CASE=独立历史报告；WORK_ORDER_SUMMARY=工单总结',
  })
  sourceType!: string;

  @Field(() => Int, { nullable: true, description: '关联工单 ID（独立报告为空）' })
  repairRequestId?: number | null;

  @Field(() => String, { nullable: true, description: '报告标题（草稿可为空）' })
  title?: string | null;

  @Field(() => String, { description: '报告状态：DRAFT/RETURNED/PENDING_REVIEW/APPROVED' })
  status!: string;

  @Field(() => Int, { description: '当前冻结版本号；0 表示尚未提交' })
  currentVersionNo!: number;

  @Field(() => String, { nullable: true, description: '维修日期' })
  maintenanceDate?: string | null;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;

  @Field(() => Int, {
    nullable: true,
    description: '已发布正式资料 ID；未发布或已下架为空（前端据此提供「查看成品」入口）',
  })
  publishedDocumentId?: number | null;

  @Field(() => MyRecordSyncStatusDTO, {
    description: '同步状态展示（任务 07 预留；与草稿/已入库独立，网页版当前默认隐藏同步列）',
  })
  syncStatus!: MyRecordSyncStatusDTO;
}

/** 本人记录列表分页结果（OFFSET：items/total/page/pageSize） */
@ObjectType({ description: '本人维修记录分页结果' })
export class MyRecordPaginatedDTO extends paginatedTypeFactory(MyRecordSummaryDTO) {}

/** 报告基本信息（详情内嵌；不返回账号与组织内部 ID） */
@ObjectType({ description: '维修报告基本信息' })
export class MyRecordReportDTO {
  @Field(() => Int, { description: '报告 ID' })
  id!: number;

  @Field(() => String, { description: '来源类型：HISTORICAL_CASE/WORK_ORDER_SUMMARY' })
  sourceType!: string;

  @Field(() => Int, { nullable: true, description: '关联工单 ID' })
  repairRequestId?: number | null;

  @Field(() => String, { nullable: true, description: '报告标题' })
  title?: string | null;

  @Field(() => String, { nullable: true, description: '客户厂家' })
  customerFactoryName?: string | null;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '机型文字（手填）' })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '维修日期' })
  maintenanceDate?: string | null;

  @Field(() => String, { description: '维修工程师姓名快照' })
  maintenanceEngineerName!: string;

  @Field(() => String, { description: '报告状态' })
  status!: string;

  @Field(() => Int, { description: '当前冻结版本号；0 表示尚未提交' })
  currentVersionNo!: number;

  @Field(() => Date, { nullable: true, description: '最近提交时间' })
  lastSubmittedAt?: Date | null;

  @Field(() => Date, { nullable: true, description: '最近审核时间' })
  lastReviewedAt?: Date | null;

  @Field(() => String, { description: 'AI 使用情况（NOT_USED/USED）' })
  aiUsage!: string;

  @Field(() => Int, { nullable: true, description: 'AI 综合评分' })
  aiScore?: number | null;

  @Field(() => String, { nullable: true, description: 'AI 正确性评价' })
  aiCorrectness?: string | null;

  @Field(() => Int, { nullable: true, description: 'AI 帮助度' })
  aiHelpfulness?: number | null;

  @Field(() => String, { nullable: true, description: 'AI 评价说明' })
  aiNote?: string | null;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;
}

/** 初始报警（只读展示） */
@ObjectType({ description: '维修报告初始报警' })
export class MyRecordAlarmDTO {
  @Field(() => Int, { description: '报警序号' })
  alarmIndex!: number;

  @Field(() => String, { description: '报警代码（保留前导零）' })
  alarmCode!: string;

  @Field(() => String, { nullable: true, description: '报警描述' })
  alarmDescription?: string | null;

  @Field(() => String, { description: '流程阶段编码' })
  phaseCode!: string;

  @Field(() => String, { description: '复位结果' })
  resetResult!: string;
}

/** 排查步骤（只读展示） */
@ObjectType({ description: '维修报告排查步骤' })
export class MyRecordStepDTO {
  @Field(() => Int, { description: '步骤序号' })
  stepNo!: number;

  @Field(() => String, { description: '步骤编码' })
  stepCode!: string;

  @Field(() => String, { description: '流程阶段编码' })
  phaseCode!: string;

  @Field(() => String, { nullable: true, description: '部件名称' })
  partName?: string | null;

  @Field(() => String, { description: '动作内容' })
  actionText!: string;

  @Field(() => String, { nullable: true, description: '结果' })
  resultText?: string | null;

  @Field(() => String, { nullable: true, description: '新报警代码' })
  newAlarmCode?: string | null;

  @Field(() => Boolean, { description: '是否为有效新分支' })
  isValidNewBranch!: boolean;
}

/** 报告附件安全元数据（不返回存储引用；下载能力由任务 11 提供） */
@ObjectType({ description: '维修报告附件' })
export class MyRecordAttachmentDTO {
  @Field(() => Int, { description: '附件 ID' })
  id!: number;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '字节数' })
  byteSize!: number;

  @Field(() => String, { nullable: true, description: '附件说明' })
  description?: string | null;

  @Field(() => Int, { description: '排序值' })
  sortOrder!: number;

  @Field(() => String, { description: '附件状态：CURRENT/RETIRED' })
  status!: string;
}

/** 冻结版本（不返回原始快照 JSON） */
@ObjectType({ description: '维修报告冻结版本' })
export class MyRecordVersionDTO {
  @Field(() => Int, { description: '版本 ID' })
  id!: number;

  @Field(() => Int, { description: '版本号' })
  versionNo!: number;

  @Field(() => String, { description: '变更类型' })
  changeKind!: string;

  @Field(() => String, { nullable: true, description: '变更原因' })
  changeReason?: string | null;

  @Field(() => Int, { description: '快照 schema 版本' })
  schemaVersion!: number;

  @Field(() => Date, { description: '送审时间' })
  submittedAt!: Date;
}

/** 冻结版本附件清单项 */
@ObjectType({ description: '冻结版本附件清单项' })
export class MyRecordVersionAttachmentDTO {
  @Field(() => Int, { description: '冻结版本 ID' })
  versionId!: number;

  @Field(() => Int, { description: '附件 ID' })
  attachmentId!: number;

  @Field(() => Int, { description: '排序值' })
  sortOrder!: number;

  @Field(() => String, { nullable: true, description: '附件说明快照' })
  descriptionSnapshot?: string | null;

  @Field(() => Boolean, { description: '是否随版本发布' })
  publishFlag!: boolean;
}

/** 审核记录（不返回审核人账号 ID） */
@ObjectType({ description: '维修报告审核记录' })
export class MyRecordReviewDTO {
  @Field(() => Int, { description: '审核记录 ID' })
  id!: number;

  @Field(() => Int, { description: '被审核版本 ID' })
  versionId!: number;

  @Field(() => String, { description: '审核决定：APPROVE/RETURN' })
  decision!: string;

  @Field(() => String, { nullable: true, description: '审核意见' })
  comment?: string | null;

  @Field(() => Date, { description: '审核时间' })
  reviewedAt!: Date;
}

/** 本人记录只读详情（草稿进入任务 06 编辑器续填；正式记录在此只读查看） */
@ObjectType({ description: '本人维修记录详情' })
export class MyRecordDetailDTO {
  @Field(() => MyRecordReportDTO, { description: '报告基本信息' })
  report!: MyRecordReportDTO;

  @Field(() => [MyRecordAlarmDTO], { description: '初始报警' })
  alarms!: MyRecordAlarmDTO[];

  @Field(() => [MyRecordStepDTO], { description: '排查步骤' })
  steps!: MyRecordStepDTO[];

  @Field(() => [MyRecordAttachmentDTO], { description: '当前工作态附件' })
  currentAttachments!: MyRecordAttachmentDTO[];

  @Field(() => String, { nullable: true, description: '最近退回意见' })
  latestReturnComment?: string | null;

  @Field(() => MyRecordVersionDTO, {
    nullable: true,
    description: '当前冻结版本；未提交为空',
  })
  currentVersion?: MyRecordVersionDTO | null;

  @Field(() => [MyRecordVersionAttachmentDTO], {
    description: '当前冻结版本的附件清单',
  })
  currentVersionAttachments!: MyRecordVersionAttachmentDTO[];

  @Field(() => MyRecordReviewDTO, { nullable: true, description: '当前版本审核记录' })
  currentReview?: MyRecordReviewDTO | null;

  @Field(() => [MyRecordReviewDTO], { description: '历史审核记录（时间升序）' })
  reviewHistory!: MyRecordReviewDTO[];

  @Field(() => Boolean, { description: '是否可进入任务 06 编辑器续填（草稿/退回态）' })
  canEdit!: boolean;

  @Field(() => String, { nullable: true, description: '适用设备型号名称' })
  equipmentModelName?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '已发布正式资料 ID；未发布或已下架为空',
  })
  publishedDocumentId?: number | null;

  @Field(() => MyRecordSyncStatusDTO, {
    description: '同步状态展示（任务 07 预留；详情复用列表同一批量接口）',
  })
  syncStatus!: MyRecordSyncStatusDTO;
}
