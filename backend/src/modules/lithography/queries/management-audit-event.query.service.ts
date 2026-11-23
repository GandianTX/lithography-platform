// src/modules/lithography/queries/management-audit-event.query.service.ts

import { DomainError, MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import { projectManagementAuditDetail } from '@core/management-audit/policy/management-audit-detail.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { ManagementAuditEventEntity } from '../entities/management-audit-event.entity';
import {
  MANAGEMENT_AUDIT_QUERY_OPERATIONS,
  isManagementAuditQueryOperation,
  isManagementAuditResultValue,
  type ManagementAuditEventReadModel,
  type ManagementAuditListPagination,
} from '../management-audit.types';

/** 固定排序：发生时间倒序；同一毫秒用事件主键倒序，保证跨页稳定。 */
const LIST_ORDER = { createdAt: 'DESC', eventId: 'DESC' } as const;

/**
 * 关键操作记录只读查询服务（任务 10）。
 *
 * 职责范围：
 * - 只读 `management_audit_event`，**固定三类 operation 白名单**：凭据补发/重置及其他
 *   历史类型即使同表存在也不会返回；
 * - 组织范围由调用方（usecase）按可信会话解析后传入：`null` 表示一级全公司（含
 *   `organization_id IS NULL` 的记录），数字表示二级只看本公司（NULL 行被 SQL 天然排除）；
 * - 排序固定「发生时间倒序 + 事件主键倒序」，不采纳客户端排序；
 * - 把 `detail` 原值就地投影为白名单摘要，原值不离开本层。
 *
 * 不包含：角色/等级准入（usecase 负责流程级授权）、昵称与公司名富集（跨域读取，
 * 由 usecase 经账户域/组织域 QueryService 批量补齐）、任何写入。
 */
@Injectable()
export class ManagementAuditEventQueryService {
  constructor(
    @InjectRepository(ManagementAuditEventEntity)
    private readonly repository: Repository<ManagementAuditEventEntity>,
  ) {}

  /**
   * 按固定白名单与组织范围分页读取。
   *
   * @param params.organizationId 可信公司范围：`null` 为一级全公司，数字为二级本公司
   * @param params.pagination 已由上层归一化的 OFFSET 参数
   */
  async listEvents(params: {
    organizationId: number | null;
    pagination: ManagementAuditListPagination;
  }): Promise<{ items: ManagementAuditEventReadModel[]; total: number }> {
    const where: FindOptionsWhere<ManagementAuditEventEntity> = {
      operation: In([...MANAGEMENT_AUDIT_QUERY_OPERATIONS]),
    };

    if (params.organizationId !== null) {
      // 二级管理员：只读本公司；organization_id IS NULL 的记录不会被等值条件命中
      where.organizationId = params.organizationId;
    }

    const { page, pageSize, withTotal } = params.pagination;
    const [entities, total] = await Promise.all([
      this.repository.find({
        where,
        order: LIST_ORDER,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      withTotal ? this.repository.count({ where }) : Promise.resolve(0),
    ]);

    return { items: entities.map(toReadModel), total };
  }
}

/**
 * 实体 → 读模型。
 *
 * 存储事实越出白名单（例如 SQL 条件被误改、库中混入凭据类 operation）时失败关闭，
 * 不静默丢弃也不降级展示——查询能力只承诺三类事实。
 */
function toReadModel(entity: ManagementAuditEventEntity): ManagementAuditEventReadModel {
  if (!isManagementAuditQueryOperation(entity.operation)) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.READ_FAILED,
      '关键操作记录包含未登记的操作类型，查询已失败关闭',
      { eventId: entity.eventId },
    );
  }
  if (!isManagementAuditResultValue(entity.result)) {
    throw new DomainError(
      MANAGEMENT_AUDIT_ERROR.READ_FAILED,
      '关键操作记录的结果值不合法，查询已失败关闭',
      { eventId: entity.eventId },
    );
  }

  return {
    eventId: entity.eventId,
    actorAccountId: entity.actorAccountId,
    actorAdminLevel: entity.actorAdminLevel,
    organizationId: entity.organizationId,
    operation: entity.operation,
    targetType: entity.targetType,
    targetId: entity.targetId,
    result: entity.result,
    detail: projectManagementAuditDetail(entity.detail),
    createdAt: entity.createdAt,
  };
}
