// src/adapters/api/graphql/repair-request/dto/repair-request-read.dto.ts
// 维修申请公共读模型 GraphQL 输出对象（负责人 20260901 裁定契约）
// 处理状态使用共享类型层正式枚举（裁定 4）；回复返回工程师安全昵称（裁定 3）

import {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';
import { EquipmentModelDTO } from '../../equipment-model/dto/equipment-model.dto';
import { RepairProcessEntryDTO } from './repair-process-entry.dto';

/**
 * 维修申请列表项输出对象（客户列表基础结构）
 * 工程师列表项在其上扩展展示字段（RepairRequestEngineerListItemDTO）；
 * 不返回归属类账号 ID
 */
@ObjectType({ description: '维修申请列表项' })
export class RepairRequestListItemDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => String, { description: '申请编号' })
  requestNo!: string;

  @Field(() => EquipmentModelDTO, { description: '设备型号' })
  equipmentModel!: EquipmentModelDTO;

  @Field(() => String, { description: '设备错误码' })
  errorCode!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '是否已接单' })
  isAccepted!: boolean;

  @Field(() => Date, { nullable: true, description: '接单时间（未接单为空）' })
  acceptedAt?: Date | null;

  @Field(() => EngineerResolutionStatus, {
    nullable: true,
    description: '最新回复处理状态；尚无回复为空',
  })
  latestResolutionStatus?: EngineerResolutionStatus | null;
}

/**
 * 工程师回复输出对象（随详情返回，时间正序）
 * engineerNickname 为后端实时关联的安全昵称，缺失回落「工程师」；
 * 不返回工程师账号 ID（裁定 3）
 */
@ObjectType({ description: '工程师回复（按时间正序）' })
export class EngineerResponseDTO {
  @Field(() => Int, { description: '回复 ID' })
  id!: number;

  @Field(() => String, { description: '回复工程师当前昵称（缺失时回落「工程师」）' })
  engineerNickname!: string;

  @Field(() => EngineerResolutionStatus, { description: '处理状态' })
  resolutionStatus!: EngineerResolutionStatus;

  @Field(() => String, { description: '面向客户的处理回复' })
  responseText!: string;

  @Field(() => Date, { description: '回复时间' })
  createdAt!: Date;
}

/**
 * 维修申请详情输出对象（客户与工程师入口共用结构，读权限由后端按身份判定）
 */
@ObjectType({ description: '维修申请详情（含回复时间线）' })
export class RepairRequestDetailDTO {
  @Field(() => Int, { description: '维修申请 ID' })
  id!: number;

  @Field(() => String, { description: '申请编号' })
  requestNo!: string;

  @Field(() => EquipmentModelDTO, { description: '设备型号' })
  equipmentModel!: EquipmentModelDTO;

  @Field(() => String, { description: '设备错误码' })
  errorCode!: string;

  @Field(() => String, { description: '故障描述' })
  faultDescription!: string;

  @Field(() => String, { description: '维修申请 Markdown 内容' })
  contentMd!: string;

  @Field(() => Date, { description: '创建时间' })
  createdAt!: Date;

  @Field(() => Boolean, { description: '是否已接单' })
  isAccepted!: boolean;

  @Field(() => Date, { nullable: true, description: '接单时间（未接单为空）' })
  acceptedAt?: Date | null;

  @Field(() => EngineerResolutionStatus, {
    nullable: true,
    description: '最新回复处理状态；尚无回复为空',
  })
  latestResolutionStatus?: EngineerResolutionStatus | null;

  @Field(() => [EngineerResponseDTO], { description: '工程师回复（时间正序）' })
  responses!: EngineerResponseDTO[];

  // ---- 结单事实（客户与工程师入口共用；旧行可为空）----

  @Field(() => String, {
    nullable: true,
    description: '结单状态（OPEN / CLOSED）；字段缺失为 null，展示层按不可确认处理',
  })
  closureStatus?: string | null;

  @Field(() => Date, { nullable: true, description: '结单时间；未结单为空' })
  closedAt?: Date | null;

  @Field(() => String, { nullable: true, description: '结单原因' })
  closureReason?: string | null;

  @Field(() => RepairRequestHandlingResult, {
    nullable: true,
    description: '处理结果；尚未处理为空',
  })
  handlingResult?: RepairRequestHandlingResult | null;

  @Field(() => RepairRequestHandlingStatus, {
    nullable: true,
    description: '实际处理状态；尚未处理为空',
  })
  handlingStatus?: RepairRequestHandlingStatus | null;

  // ---- 内部过程（仅接单工程师本人可见；客户入口为空数组）----

  @Field(() => [RepairProcessEntryDTO], {
    description: '内部维修过程（仅接单工程师本人可见；客户入口为空数组）',
  })
  processEntries!: RepairProcessEntryDTO[];

  // ---- 工程师入口富集字段（客户入口为空；accept Mutation 成功输出复用工程师入口）----

  @Field(() => String, {
    nullable: true,
    description: '客户当前昵称（缺失回落「客户」）；客户入口为空',
  })
  customerNickname?: string | null;

  @Field(() => String, { nullable: true, description: '客户公司名称；客户入口为空' })
  customerCompanyName?: string | null;

  @Field(() => RepairRequestAcceptanceViewStatus, {
    nullable: true,
    description:
      '接单状态视角（AVAILABLE / MINE / TAKEN_BY_OTHER）；客户入口为空；AVAILABLE 仅表示未接单事实，不代表当前会话可接单',
  })
  acceptanceViewStatus?: RepairRequestAcceptanceViewStatus | null;

  @Field(() => String, {
    nullable: true,
    description: '接单工程师当前昵称（缺失回落「工程师」）；未接单或客户入口为空',
  })
  acceptedEngineerNickname?: string | null;
}

/**
 * 工程师列表项输出对象：在基础列表项上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态；不返回归属类账号 ID
 */
@ObjectType({ description: '工程师维修申请列表项' })
export class RepairRequestEngineerListItemDTO extends RepairRequestListItemDTO {
  @Field(() => String, {
    description: '客户当前昵称（缺失回落「客户」）',
  })
  customerNickname!: string;

  @Field(() => String, { nullable: true, description: '客户公司名称' })
  customerCompanyName?: string | null;

  @Field(() => RepairRequestAcceptanceViewStatus, {
    description:
      '接单状态视角（AVAILABLE / MINE / TAKEN_BY_OTHER）；AVAILABLE 仅表示未接单事实，不代表当前会话可接单',
  })
  acceptanceViewStatus!: RepairRequestAcceptanceViewStatus;

  @Field(() => String, {
    nullable: true,
    description: '接单工程师当前昵称（缺失回落「工程师」）；未接单为空',
  })
  acceptedEngineerNickname?: string | null;

  // ---- 工单真实进度（列表展示用；与详情结单事实同源）----

  @Field(() => String, {
    nullable: true,
    description: '结单状态（OPEN / CLOSED）；字段缺失为 null，展示层按不可确认处理',
  })
  closureStatus?: string | null;

  @Field(() => Date, { nullable: true, description: '结单时间；未结单为空' })
  closedAt?: Date | null;

  @Field(() => RepairRequestHandlingResult, {
    nullable: true,
    description: '处理结果；尚未处理为空',
  })
  handlingResult?: RepairRequestHandlingResult | null;

  @Field(() => RepairRequestHandlingStatus, {
    nullable: true,
    description: '实际处理状态；尚未处理为空',
  })
  handlingStatus?: RepairRequestHandlingStatus | null;
}

/**
 * 工程师列表分页输出（OFFSET：items/total/page/pageSize）
 */
@ObjectType({ description: '工程师维修申请分页结果' })
export class RepairRequestEngineerPaginatedDTO extends paginatedTypeFactory(
  RepairRequestEngineerListItemDTO,
) {}

/**
 * 维修申请列表分页输出（OFFSET：items/total/page/pageSize）
 */
@ObjectType({ description: '维修申请分页结果' })
export class RepairRequestPaginatedDTO extends paginatedTypeFactory(RepairRequestListItemDTO) {}
