// src/adapters/api/graphql/reference-document/dto/reference-document-read.dto.ts
// AI 参考资料读模型 GraphQL 输出对象（0907.docx 任务二；A-PR0 §4.3 组织范围扩展）
// 不返回创建人账号 ID、存储后端/存储引用与服务器路径；不返回解析状态（数据库无此模型）

import { Field, Int, ObjectType } from '@nestjs/graphql';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';

/**
 * 正式资料案例明细输出对象（仅 FAULT_CASE 资料存在；普通资料为 null）
 * 不返回 casePayloadJson / schemaVersion 等内部扩展字段
 */
@ObjectType({ description: '正式资料案例明细（仅案例资料）' })
export class ReferenceDocumentCaseDetailDTO {
  @Field(() => String, { nullable: true, description: '设备错误码（保留大小写与内部符号）' })
  errorCode?: string | null;

  @Field(() => String, { description: '处理状态：UNRESOLVED/IN_PROGRESS/RESOLVED' })
  handlingStatus!: string;

  @Field(() => String, { description: '故障现象' })
  phenomenon!: string;

  @Field(() => String, { nullable: true, description: '触发条件' })
  conditionText?: string | null;

  @Field(() => String, { description: '复现步骤' })
  reproductionSteps!: string;

  @Field(() => String, { nullable: true, description: '排查过程' })
  diagnosis?: string | null;

  @Field(() => String, { nullable: true, description: '处理措施' })
  actionTaken?: string | null;

  @Field(() => String, { nullable: true, description: '处理结果；已解决时必填' })
  resolution?: string | null;
}

/**
 * 参考资料列表项输出对象
 * 不携带 contentText 大字段（仅详情返回）；创建人展示经 creatorNickname；
 * A-PR0 §4.3：组织展示名/来源信息/机型文字/案例处理状态（普通资料为 null）
 */
@ObjectType({ description: '参考资料列表项' })
export class ReferenceDocumentListItemDTO {
  @Field(() => Int, { description: '参考资料 ID' })
  id!: number;

  @Field(() => String, { description: '文档标题' })
  title!: string;

  @Field(() => String, { description: '文档类型' })
  documentType!: string;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID；为空表示通用资料' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '适用设备型号名称；通用资料为空' })
  equipmentModelName?: string | null;

  @Field(() => String, { nullable: true, description: '机型文字（用户手填；与机型 ID 互斥）' })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '文档说明' })
  description?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '原始文件名（有存储引用的资料返回；纯文本资料为空）',
  })
  originalFilename?: string | null;

  @Field(() => String, { description: '所属组织展示名' })
  organizationName!: string;

  @Field(() => String, {
    description: '入库方式来源：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=审核发布',
  })
  ingestMethod!: string;

  @Field(() => String, {
    description:
      '来源类型：INDEPENDENT_REPORT=独立历史报告；WORK_ORDER_SUMMARY=工单总结；MATERIAL=普通资料',
  })
  sourceKind!: string;

  @Field(() => Int, {
    description: '生效管理修订号；0 表示原始冻结内容或原始正文',
  })
  effectiveRevisionNo!: number;

  @Field(() => String, {
    nullable: true,
    description: '案例处理状态（UNRESOLVED/IN_PROGRESS/RESOLVED）；普通资料为空',
  })
  caseHandlingStatus?: string | null;

  @Field(() => String, { description: '创建人当前昵称（缺失时回落「未知用户」）' })
  creatorNickname!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;
}

/** 冻结报告初始报警（只读展示；不返回内部行 ID） */
@ObjectType({ description: '冻结报告初始报警' })
export class ReferenceDocumentFrozenAlarmDTO {
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

/** 冻结报告排查步骤（只读展示；不返回内部行 ID） */
@ObjectType({ description: '冻结报告排查步骤' })
export class ReferenceDocumentFrozenStepDTO {
  @Field(() => Int, { description: '步骤序号（稳定身份）' })
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

/** 冻结报告故障面板（任务 07 加法扩展：任务 06 快照扩展键；旧快照为空数组） */
@ObjectType({ description: '冻结报告故障面板' })
export class ReferenceDocumentFrozenFaultDTO {
  @Field(() => String, { description: '分支类型：INITIAL/RESET_NEW_FAULT/STEP_NEW_FAULT' })
  branchKind!: string;

  @Field(() => String, { nullable: true, description: '步骤新故障关联的步骤编码；其余分支为空' })
  stepCode?: string | null;

  @Field(() => String, { nullable: true, description: '流程阶段编码' })
  phaseCode?: string | null;

  @Field(() => String, { nullable: true, description: 'Main Error' })
  mainError?: string | null;

  @Field(() => String, { nullable: true, description: 'Unit Error' })
  unitError?: string | null;

  @Field(() => String, { nullable: true, description: 'Source' })
  source?: string | null;

  @Field(() => String, { nullable: true, description: 'Error Type' })
  errorType?: string | null;

  @Field(() => String, { nullable: true, description: 'GPIB Status' })
  gpibStatus?: string | null;

  @Field(() => String, { nullable: true, description: 'Status' })
  faultStatus?: string | null;

  @Field(() => String, { description: 'Description' })
  description!: string;

  @Field(() => String, { nullable: true, description: 'Action' })
  action?: string | null;
}

/**
 * 资料生效结构化内容（任务 07 管理修订；生效修订快照携带 structuredReport 键时返回）。
 * 与修订写输入同构；客户厂家/机型文字为继承事实，不在修订白名单。
 */
@ObjectType({ description: '资料生效结构化内容（管理修订）' })
export class ReferenceDocumentStructuredContentDTO {
  @Field(() => Int, { description: '结构化内容 schema 版本' })
  schemaVersion!: number;

  @Field(() => String, { description: '维修日期（YYYY-MM-DD）' })
  maintenanceDate!: string;

  @Field(() => String, { description: '维修工程师' })
  maintenanceEngineerName!: string;

  @Field(() => String, { description: '客户厂家（继承来源事实，不在修订白名单）' })
  customerFactoryName!: string;

  @Field(() => String, { nullable: true, description: '机型文字（继承来源事实，不在修订白名单）' })
  equipmentModelText?: string | null;

  @Field(() => String, { description: '复位情况：NORMAL/SAME_FAULT/NEW_FAULT' })
  resetResult!: string;

  @Field(() => [ReferenceDocumentStructuredFaultDTO], {
    description: '故障面板（初始/复位新故障/步骤新故障）',
  })
  faults!: ReferenceDocumentStructuredFaultDTO[];

  @Field(() => [ReferenceDocumentStructuredStepDTO], { description: '排查步骤' })
  steps!: ReferenceDocumentStructuredStepDTO[];

  @Field(() => String, { nullable: true, description: '维修结果（五类稳定枚举）' })
  handlingResult?: string | null;

  @Field(() => String, { nullable: true, description: '中断/无法修复原因' })
  closureReason?: string | null;

  @Field(() => String, { nullable: true, description: '故障根因' })
  actualCause?: string | null;

  @Field(() => String, { nullable: true, description: '维修动作说明' })
  repairActions?: string | null;

  @Field(() => String, { nullable: true, description: '验证结果' })
  verificationResult?: string | null;

  @Field(() => String, { nullable: true, description: '补充说明' })
  supplementaryNote?: string | null;
}

/** 结构化故障面板输出（与输入同构） */
@ObjectType({ description: '结构化故障面板' })
export class ReferenceDocumentStructuredFaultDTO {
  @Field(() => String, { description: '分支类型：INITIAL/RESET_NEW_FAULT/STEP_NEW_FAULT' })
  branchKind!: string;

  @Field(() => String, { nullable: true, description: '步骤新故障关联的步骤编码' })
  stepCode?: string | null;

  @Field(() => String, { nullable: true, description: '流程阶段编码' })
  phaseCode?: string | null;

  @Field(() => String, { nullable: true, description: 'Main Error' })
  mainError?: string | null;

  @Field(() => String, { nullable: true, description: 'Unit Error' })
  unitError?: string | null;

  @Field(() => String, { nullable: true, description: 'Source' })
  source?: string | null;

  @Field(() => String, { nullable: true, description: 'Error Type' })
  errorType?: string | null;

  @Field(() => String, { nullable: true, description: 'GPIB Status' })
  gpibStatus?: string | null;

  @Field(() => String, { nullable: true, description: 'Status' })
  faultStatus?: string | null;

  @Field(() => String, { description: 'Description' })
  description!: string;

  @Field(() => String, { nullable: true, description: 'Action' })
  action?: string | null;
}

/** 结构化排查步骤输出（与输入同构） */
@ObjectType({ description: '结构化排查步骤' })
export class ReferenceDocumentStructuredStepDTO {
  @Field(() => String, { description: '步骤稳定编码（调序不变）' })
  stepCode!: string;

  @Field(() => Int, { description: '步骤序号' })
  stepNo!: number;

  @Field(() => String, { nullable: true, description: '流程阶段编码' })
  phaseCode?: string | null;

  @Field(() => String, { nullable: true, description: '故障部件代码' })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '部件名称' })
  partName?: string | null;

  @Field(() => String, { description: '操作方式' })
  actionText!: string;

  @Field(() => String, { description: '步骤结果：RESOLVED/UNRESOLVED/NEW_FAULT' })
  resultCode!: string;
}

/**
 * 管理修订编辑初值（独立管理修订页专用，仅一级管理员）：
 * STRUCTURED=报告来源/已结构化修订资料；FLAT=普通资料与旧扁平修订（不伪造故障数据）。
 */
@ObjectType({ description: '管理修订编辑初值（仅一级管理员）' })
export class ReferenceDocumentEditableContentDTO {
  @Field(() => Int, { description: '参考资料 ID' })
  documentId!: number;

  @Field(() => String, { description: '文档标题' })
  title!: string;

  @Field(() => String, { nullable: true, description: '文档说明' })
  description?: string | null;

  @Field(() => String, { description: '文档类型' })
  documentType!: string;

  @Field(() => Int, { description: '编辑提交的乐观令牌初始值（current_revision_no）' })
  expectedVersion!: number;

  @Field(() => String, { description: '来源类型：INDEPENDENT_REPORT/WORK_ORDER_SUMMARY/MATERIAL' })
  sourceKind!: string;

  @Field(() => String, { description: '编辑模式：STRUCTURED=结构化报告；FLAT=扁平正文' })
  mode!: string;

  @Field(() => ReferenceDocumentStructuredContentDTO, {
    nullable: true,
    description: '结构化模式初值；扁平模式为空',
  })
  structured?: ReferenceDocumentStructuredContentDTO | null;

  @Field(() => String, { nullable: true, description: '扁平模式初值（当前生效正文）' })
  contentText?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '资料自身机型关联初值（改选 Select 当前值；null 表示通用资料）',
  })
  equipmentModelId?: number | null;

  @Field(() => String, {
    nullable: true,
    description: '机型名称（按关联 ID 实时取字典名，用于当前值展示）',
  })
  equipmentModelName?: string | null;

  @Field(() => Boolean, { description: '案例资料正文保护提示（FAULT_CASE 正文须走案例更正接口）' })
  faultCaseProtected!: boolean;
}

/** 冻结报告 AI 使用与评价（未使用 AI 时 usage=NOT_USED，其余字段为空） */
@ObjectType({ description: '冻结报告 AI 使用与评价' })
export class ReferenceDocumentFrozenAiDTO {
  @Field(() => String, { description: 'AI 使用情况' })
  usage!: string;

  @Field(() => String, { nullable: true, description: '分析结果来源类型' })
  sourceType?: string | null;

  @Field(() => String, { nullable: true, description: '分析结果稳定标识' })
  sourceId?: string | null;

  @Field(() => String, { nullable: true, description: '分析结果不可变版本' })
  sourceVersion?: string | null;

  @Field(() => Int, { nullable: true, description: '综合评分 1-5' })
  score?: number | null;

  @Field(() => String, { nullable: true, description: '正确性评价' })
  correctness?: string | null;

  @Field(() => Int, { nullable: true, description: '帮助度 1-4（历史 5 兼容）' })
  helpfulness?: number | null;

  @Field(() => String, { nullable: true, description: '说明' })
  note?: string | null;
}

/**
 * 冻结报告内容（任务 07：报告来源资料在无管理修订时读取原始冻结版本）。
 * 不返回账号内部标识、存储引用与原始快照 JSON。
 */
@ObjectType({ description: '冻结报告内容（报告来源资料的原始版本）' })
export class ReferenceDocumentFrozenReportDTO {
  @Field(() => Int, { description: '冻结报告版本 ID' })
  versionId!: number;

  @Field(() => Int, { description: '报告版本号' })
  versionNo!: number;

  @Field(() => Int, { description: '冻结快照 schema 版本' })
  schemaVersion!: number;

  @Field(() => Date, { description: '冻结提交时间' })
  submittedAt!: Date;

  @Field(() => String, { description: '报告来源类型：HISTORICAL_CASE/WORK_ORDER_SUMMARY' })
  sourceType!: string;

  @Field(() => Int, { nullable: true, description: '关联工单 ID（独立报告为空）' })
  repairRequestId?: number | null;

  @Field(() => String, { description: '报告标题' })
  title!: string;

  @Field(() => String, { description: '客户厂家' })
  customerFactoryName!: string;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '机型文字' })
  equipmentModelText?: string | null;

  @Field(() => String, { description: '维修日期' })
  maintenanceDate!: string;

  @Field(() => String, { description: '维修工程师姓名快照' })
  maintenanceEngineerName!: string;

  @Field(() => [ReferenceDocumentFrozenAlarmDTO], { description: '初始报警' })
  alarms!: ReferenceDocumentFrozenAlarmDTO[];

  @Field(() => [ReferenceDocumentFrozenStepDTO], { description: '排查步骤' })
  steps!: ReferenceDocumentFrozenStepDTO[];

  // 任务 07 管理修订（加法式扩展）：任务 06 快照扩展键展示视图；任务 04 旧快照为空值
  @Field(() => [ReferenceDocumentFrozenFaultDTO], {
    description: '故障面板（任务 06 扩展键；旧快照为空数组）',
  })
  faults!: ReferenceDocumentFrozenFaultDTO[];

  @Field(() => String, { nullable: true, description: '维修结果（任务 06 扩展键；旧快照为空）' })
  handlingResult?: string | null;

  @Field(() => String, { nullable: true, description: '中断/无法修复原因（任务 06 扩展键）' })
  closureReason?: string | null;

  @Field(() => String, { nullable: true, description: '复位情况（任务 06 扩展键）' })
  resetResult?: string | null;

  @Field(() => String, { nullable: true, description: '故障根因（任务 06 扩展键）' })
  actualCause?: string | null;

  @Field(() => String, { nullable: true, description: '维修动作说明（任务 06 扩展键）' })
  repairActions?: string | null;

  @Field(() => String, { nullable: true, description: '验证结果（任务 06 扩展键）' })
  verificationResult?: string | null;

  @Field(() => String, { nullable: true, description: '补充说明（任务 06 扩展键）' })
  supplementaryNote?: string | null;

  @Field(() => ReferenceDocumentFrozenAiDTO, { description: 'AI 使用与评价' })
  ai!: ReferenceDocumentFrozenAiDTO;
}

/**
 * 来源报告冻结版本的原件附件（任务 07 P2）。
 * 只含展示与下载所需的公开标识（fileId 允许返回，R062-02 口径），
 * 不返回存储引用、磁盘路径与上传者账号等内部事实。
 */
@ObjectType({ description: '来源报告冻结版本的原件附件' })
export class ReferenceDocumentSourceAttachmentDTO {
  @Field(() => Int, { description: '报告附件 ID（下载端点路径参数）' })
  attachmentId!: number;

  @Field(() => String, { description: '关联原件 ID（公开标识；下载经服务端授权后回写流）' })
  fileId!: string;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '文件字节数' })
  byteSize!: number;
}

/**
 * 参考资料详情输出对象（元数据 + 生效正文 + 案例明细）
 * 不返回存储引用与服务器本地路径（0907.docx：不能把服务器本地路径返回给浏览器）
 * 任务 07：contentText 为生效正文，并附来源类型 / 生效版本 / 冻结报告内容。
 */
@ObjectType({ description: '参考资料详情（元数据与文本内容）' })
export class ReferenceDocumentDetailDTO {
  @Field(() => Int, { description: '参考资料 ID' })
  id!: number;

  @Field(() => String, { description: '文档标题' })
  title!: string;

  @Field(() => String, { description: '文档类型' })
  documentType!: string;

  @Field(() => Int, { nullable: true, description: '适用设备型号 ID；为空表示通用资料' })
  equipmentModelId?: number | null;

  @Field(() => String, { nullable: true, description: '适用设备型号名称；通用资料为空' })
  equipmentModelName?: string | null;

  @Field(() => String, { nullable: true, description: '机型文字（用户手填；与机型 ID 互斥）' })
  equipmentModelText?: string | null;

  @Field(() => String, { nullable: true, description: '文档说明' })
  description?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '原始文件名（有存储引用的资料返回；纯文本资料为空）',
  })
  originalFilename?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '文件 MIME 类型（有存储引用的资料返回；纯文本资料为空）',
  })
  mimeType?: string | null;

  @Field(() => Boolean, {
    description:
      '是否带可下载文件（权威判定 = 存储引用非空；前端下载按钮与编辑放行均以本字段为准）',
  })
  hasFile!: boolean;

  @Field(() => String, { nullable: true, description: '文本内容' })
  contentText?: string | null;

  @Field(() => String, { description: '所属组织展示名' })
  organizationName!: string;

  @Field(() => String, {
    description: '入库方式来源：ADMIN_DIRECT=管理员直建；REVIEWED_SUBMISSION=审核发布',
  })
  ingestMethod!: string;

  @Field(() => String, {
    description:
      '来源类型：INDEPENDENT_REPORT=独立历史报告；WORK_ORDER_SUMMARY=工单总结；MATERIAL=普通资料',
  })
  sourceKind!: string;

  @Field(() => Int, { description: '生效管理修订号；0 表示原始冻结内容或原始正文' })
  effectiveRevisionNo!: number;

  @Field(() => Int, {
    nullable: true,
    description: '来源报告 ID（报告来源资料返回；普通资料为空）',
  })
  sourceReportId?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: '来源冻结报告版本 ID（永久保留；普通资料为空）',
  })
  sourceReportVersionId?: number | null;

  @Field(() => String, {
    description:
      '生效正文来源：ORIGINAL=资料正文；FROZEN_REPORT=原始冻结报告；CURRENT_REVISION=管理修订后正文',
  })
  contentSource!: string;

  @Field(() => ReferenceDocumentFrozenReportDTO, {
    nullable: true,
    description:
      '冻结报告内容；报告来源资料恒返回（授权追溯原始冻结版本，不随管理修订替换），生效正文仍由 contentSource 决定',
  })
  frozenReport?: ReferenceDocumentFrozenReportDTO | null;

  @Field(() => ReferenceDocumentStructuredContentDTO, {
    nullable: true,
    description:
      '生效管理修订的结构化内容（任务 07；生效修订快照携带 structuredReport 键时返回，旧扁平修订为空）',
  })
  structuredContent?: ReferenceDocumentStructuredContentDTO | null;

  @Field(() => ReferenceDocumentSourceAttachmentDTO, {
    nullable: true,
    description:
      '来源报告冻结版本的原件附件（任务 07 P2；按冻结版本附件绑定装配，有权读者可经 REST 下载，普通资料与无冻结原件为空）',
  })
  sourceReportAttachment?: ReferenceDocumentSourceAttachmentDTO | null;

  @Field(() => ReferenceDocumentCaseDetailDTO, {
    nullable: true,
    description: '案例明细；普通资料为空（前端需兼容可空 caseDetail）',
  })
  caseDetail?: ReferenceDocumentCaseDetailDTO | null;

  @Field(() => String, { description: '创建人当前昵称（缺失时回落「未知用户」）' })
  creatorNickname!: string;

  @Field(() => Boolean, {
    description:
      '当前会话账号是否为本条资料的原作者（任务 07 R053：原作者删除入口的唯一依据；不返回账号 ID）',
  })
  viewerIsOriginalAuthor!: boolean;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Date, { description: '最近更新时间' })
  updatedAt!: Date;
}

/**
 * 参考资料列表分页输出（OFFSET：items/total/page/pageSize）
 */
@ObjectType({ description: '参考资料分页结果' })
export class ReferenceDocumentPaginatedDTO extends paginatedTypeFactory(
  ReferenceDocumentListItemDTO,
) {}

/** 资料生效修订摘要（历史版本；contentText 供授权追溯该版本具体内容） */
@ObjectType({ description: '资料生效修订摘要' })
export class ReferenceDocumentRevisionDTO {
  @Field(() => Int, { description: '生效修订号' })
  revisionNo!: number;

  @Field(() => String, { description: '修订原因' })
  reason!: string;

  @Field(() => String, { description: '修订人昵称（缺失时回落「未知用户」）' })
  actorNickname!: string;

  @Field(() => Date, { description: '修订时间' })
  createdAt!: Date;

  @Field(() => String, {
    nullable: true,
    description: '该修订版本的生效正文（after 快照内容键；快照缺内容键时为空）',
  })
  contentText?: string | null;
}

/**
 * 资料历史版本读取结果。
 * 原始冻结报告版本以 sourceReportVersionId 表达，管理修订以 revisions 表达；
 * 与列表/详情/下载共用同一服务端可见范围，不可见资料统一 NOT_FOUND。
 */
@ObjectType({ description: '参考资料历史版本' })
export class ReferenceDocumentRevisionsDTO {
  @Field(() => Int, { description: '参考资料 ID' })
  documentId!: number;

  @Field(() => Int, { description: '当前生效修订号；0 表示无管理修订' })
  currentRevisionNo!: number;

  @Field(() => String, { description: '来源类型：INDEPENDENT_REPORT/WORK_ORDER_SUMMARY/MATERIAL' })
  sourceKind!: string;

  @Field(() => Int, {
    nullable: true,
    description: '原始冻结报告版本 ID；普通资料为空',
  })
  sourceReportVersionId?: number | null;

  @Field(() => [ReferenceDocumentRevisionDTO], { description: '管理修订列表（修订号升序）' })
  revisions!: ReferenceDocumentRevisionDTO[];
}
