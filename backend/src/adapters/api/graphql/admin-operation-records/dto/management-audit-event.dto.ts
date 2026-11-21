// src/adapters/api/graphql/admin-operation-records/dto/management-audit-event.dto.ts

import type { ManagementAuditDetailView } from '@core/management-audit/policy/management-audit-detail.policy';
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { paginatedTypeFactory } from '@src/adapters/api/graphql/pagination.type-factory';
import {
  managementAuditOperationValues,
  managementAuditResultValues,
  type ManagementAuditEventView,
  type ManagementAuditQueryOperation,
  type ManagementAuditResultValue,
} from '@src/modules/lithography/management-audit.types';

/**
 * 关键操作记录的安全摘要（`detail` 白名单投影）。
 *
 * 刻意不提供原始 `detail` 字段：写入方自由组织的原值可能夹带正文、路径或凭据，
 * 只有服务端核对过的白名单键才允许出现在响应中。
 */
@ObjectType('ManagementAuditEventDetail', {
  description: '关键操作记录安全摘要（仅白名单字段，不含 detail 原值）',
})
export class ManagementAuditEventDetailDTO {
  @Field(() => String, { nullable: true, description: '操作原因摘要（已截断）' })
  reason!: string | null;

  @Field(() => String, { nullable: true, description: '实际阶段标识（如恢复阶段）' })
  stage!: string | null;

  @Field(() => [String], {
    nullable: true,
    description: '发生变化的字段名（不含字段值）',
  })
  changedFields!: string[] | null;

  @Field(() => Int, { nullable: true, description: '同一操作的尝试序号' })
  attemptNo!: number | null;

  @Field(() => String, { nullable: true, description: '变更前公司名' })
  beforeOrganizationName!: string | null;

  @Field(() => String, { nullable: true, description: '变更后公司名' })
  afterOrganizationName!: string | null;
}

/** 关键操作记录列表项（只读，不含操作者账号 ID 与 detail 原值）。 */
@ObjectType('ManagementAuditEventItem', { description: '关键操作记录条目' })
export class ManagementAuditEventItemDTO {
  @Field(() => ID, { description: '事件 ID（UUID）' })
  eventId!: string;

  @Field(() => Date, { description: '发生时间' })
  occurredAt!: Date;

  @Field(() => Int, { description: '操作时的实际管理员等级（1 或 2）' })
  actorAdminLevel!: number;

  @Field(() => String, { description: '操作者昵称（读时关联，缺失回落占位）' })
  actorNickname!: string;

  @Field(() => Int, { nullable: true, description: '作用公司 ID；无法判定归属时为空' })
  organizationId!: number | null;

  @Field(() => String, { nullable: true, description: '作用公司名称；公司为空或已不存在时为空' })
  organizationName!: string | null;

  @Field(() => managementAuditOperationValues, {
    description: '操作类型（固定三类，凭据类不在此契约内）',
  })
  operation!: ManagementAuditQueryOperation;

  @Field(() => String, { description: '目标类型' })
  targetType!: string;

  @Field(() => String, { description: '目标真实 ID' })
  targetId!: string;

  @Field(() => managementAuditResultValues, { description: '实际操作结果' })
  result!: ManagementAuditResultValue;

  @Field(() => ManagementAuditEventDetailDTO, {
    nullable: true,
    description: '安全摘要；无可展示内容时为空',
  })
  detail!: ManagementAuditEventDetailDTO | null;
}

@ObjectType('ManagementAuditEventPaginated', { description: '关键操作记录分页结果' })
export class ManagementAuditEventPaginatedDTO extends paginatedTypeFactory(
  ManagementAuditEventItemDTO,
) {}

/** View → DTO：只做字段搬运，不在此做权限或业务判断。 */
export function toManagementAuditEventItemDTO(
  view: ManagementAuditEventView,
): ManagementAuditEventItemDTO {
  return {
    eventId: view.eventId,
    occurredAt: view.occurredAt,
    actorAdminLevel: view.actorAdminLevel,
    actorNickname: view.actorNickname,
    organizationId: view.organizationId,
    organizationName: view.organizationName,
    operation: view.operation,
    targetType: view.targetType,
    targetId: view.targetId,
    result: view.result,
    detail: toManagementAuditEventDetailDTO(view.detail),
  };
}

function toManagementAuditEventDetailDTO(
  view: ManagementAuditDetailView | null,
): ManagementAuditEventDetailDTO | null {
  if (view === null) {
    return null;
  }
  return {
    reason: view.reason ?? null,
    stage: view.stage ?? null,
    changedFields: view.changedFields === undefined ? null : [...view.changedFields],
    attemptNo: view.attemptNo ?? null,
    beforeOrganizationName: view.beforeOrganizationName ?? null,
    afterOrganizationName: view.afterOrganizationName ?? null,
  };
}
