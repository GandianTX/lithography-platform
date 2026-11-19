// src/modules/lithography/queries/engineer-repair-revision.query.service.ts
//
// 工程师侧修订历史只读查询。
//
// 职责：
// - 校验查看者是该工单接单人、属于可信服务厂家且具备工单读取权限；
// - 仅返回工程师可见的维修快照与必要历史元数据，不暴露管理员完整快照；
// - 历史附件不参与输出，避免扩大下载权限。
//
// 不包含：任何写入、管理员接口复用与回滚能力。

import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors/domain-error';
import {
  parseRepairRequestRevisionSnapshot,
  ParsedRepairRequestRevisionSnapshot,
} from '@core/repair-request/policy/repair-request-revision.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from '../entities/repair-request-revision.entity';
import {
  EngineerRepairRevisionDetailQueryResult,
  EngineerRepairRevisionHistoryItemQueryResult,
  EngineerRepairRevisionSnapshotView,
} from '../lithography.types';

/** 工程师侧历史查询参数 */
type EngineerRevisionReadParams = {
  requestId: number;
  session: UsecaseSession;
  viewerOrganizationId?: number | null;
};

/**
 * 工程师侧修订历史查询服务。
 *
 * 所有方法先执行同一套读取授权（接单人 + 可信服务厂家 + 未删除），
 * 再读取修订记录；跨工单修订号只会得到 NOT_FOUND。
 */
@Injectable()
export class EngineerRepairRevisionQueryService {
  constructor(
    @InjectRepository(RepairRequestEntity)
    private readonly requestRepository: Repository<RepairRequestEntity>,
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly intakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(RepairRequestRevisionEntity)
    private readonly revisionRepository: Repository<RepairRequestRevisionEntity>,
  ) {}

  /**
   * 工单修订历史（最新在前），仅含接单工程师可见记录。
   */
  async listForAcceptingEngineer(
    params: EngineerRevisionReadParams,
  ): Promise<EngineerRepairRevisionHistoryItemQueryResult[]> {
    await this.assertAcceptingEngineerReadAccess(
      params.requestId,
      params.session,
      params.viewerOrganizationId,
    );

    const rows = await this.revisionRepository.find({
      where: { requestId: params.requestId },
      order: { revisionNo: 'DESC' },
    });

    return rows.map((row) => {
      const before = parseRepairRequestRevisionSnapshot(row.beforeSnapshot);
      const after = parseRepairRequestRevisionSnapshot(row.afterSnapshot);
      const hasComparableSnapshot =
        before !== null && after !== null && before.hasMaintenanceData && after.hasMaintenanceData;
      const hasVisibleMaintenanceChange =
        hasComparableSnapshot && hasMaintenanceDifference(before, after);
      return {
        revisionNo: row.revisionNo,
        previousVersion: row.previousVersion,
        reason: row.reason,
        actorAccountId: row.actorAccountId,
        createdAt: row.createdAt,
        hasComparableSnapshot,
        hasVisibleMaintenanceChange,
        compareUnavailableReason: hasComparableSnapshot
          ? hasVisibleMaintenanceChange
            ? null
            : 'NO_VISIBLE_MAINTENANCE_CHANGE'
          : 'NO_COMPARABLE_SNAPSHOT',
      };
    });
  }

  /**
   * 单个修订详情：跨工单修订号视为不存在。
   */
  async findRevisionForAcceptingEngineer(params: {
    requestId: number;
    revisionNo: number;
    session: UsecaseSession;
    viewerOrganizationId?: number | null;
  }): Promise<EngineerRepairRevisionDetailQueryResult> {
    await this.assertAcceptingEngineerReadAccess(
      params.requestId,
      params.session,
      params.viewerOrganizationId,
    );

    const row = await this.revisionRepository.findOne({
      where: { requestId: params.requestId, revisionNo: params.revisionNo },
    });
    if (row === null) {
      throw new DomainError(REPAIR_REQUEST_ERROR.NOT_FOUND, '修订版本不存在或不可查看', {
        requestId: params.requestId,
        revisionNo: params.revisionNo,
      });
    }

    const before = parseRepairRequestRevisionSnapshot(row.beforeSnapshot);
    const after = parseRepairRequestRevisionSnapshot(row.afterSnapshot);
    const hasComparableSnapshot =
      before !== null && after !== null && before.hasMaintenanceData && after.hasMaintenanceData;
    const hasVisibleMaintenanceChange =
      hasComparableSnapshot && hasMaintenanceDifference(before, after);

    return {
      requestId: row.requestId,
      revisionNo: row.revisionNo,
      previousVersion: row.previousVersion,
      reason: row.reason,
      actorAccountId: row.actorAccountId,
      createdAt: row.createdAt,
      hasComparableSnapshot,
      hasVisibleMaintenanceChange,
      compareUnavailableReason: hasComparableSnapshot
        ? hasVisibleMaintenanceChange
          ? null
          : 'NO_VISIBLE_MAINTENANCE_CHANGE'
        : 'NO_COMPARABLE_SNAPSHOT',
      before: toEngineerSnapshot(before),
      after: toEngineerSnapshot(after),
    };
  }

  /**
   * 读取授权：未删除 + 工程师身份 + 本人为接单人 + 可信服务厂家与查看者组织一致。
   * 任一条件不满足统一拒绝，避免泄露工单或修订存在性。
   */
  private async assertAcceptingEngineerReadAccess(
    requestId: number,
    session: UsecaseSession,
    viewerOrganizationId?: number | null,
  ): Promise<void> {
    const entity = await this.requestRepository.findOne({
      where: { id: requestId },
      select: {
        id: true,
        deprecated: true,
        isAccepted: true,
        acceptedByEngineerAccountId: true,
        intakeId: true,
        serviceOrganizationId: true,
      },
    });
    if (
      entity === null ||
      entity.deprecated ||
      !entity.isAccepted ||
      entity.acceptedByEngineerAccountId === null ||
      entity.acceptedByEngineerAccountId !== session.accountId ||
      !hasRole(session.roles, IdentityTypeEnum.ENGINEER)
    ) {
      throw this.accessDenied(requestId);
    }

    const trustedServiceOrganizationId = await this.resolveTrustedServiceOrganizationId(entity);
    if (
      trustedServiceOrganizationId === null ||
      trustedServiceOrganizationId !== (viewerOrganizationId ?? null)
    ) {
      throw this.accessDenied(requestId);
    }
  }

  private accessDenied(requestId: number): DomainError {
    return new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '维修申请不存在或不可查看', {
      id: requestId,
    });
  }

  /**
   * 可信服务厂家：工单服务公司与原始报修 intake 服务公司一致时才有效；
   * 缺失或冲突一律失败关闭。
   */
  private async resolveTrustedServiceOrganizationId(
    entity: RepairRequestEntity,
  ): Promise<number | null> {
    if (entity.intakeId === null || entity.serviceOrganizationId === null) {
      return null;
    }
    const intake = await this.intakeRepository.findOne({
      where: { id: entity.intakeId },
      select: { id: true, serviceOrganizationId: true },
    });
    return intake !== null && intake.serviceOrganizationId === entity.serviceOrganizationId
      ? entity.serviceOrganizationId
      : null;
  }
}

/** 解析后的快照转为工程师只读视图（不含附件、处理结果与结单信息） */
function toEngineerSnapshot(
  snapshot: ParsedRepairRequestRevisionSnapshot | null,
): EngineerRepairRevisionSnapshotView | null {
  if (snapshot === null) {
    return null;
  }
  return {
    maintenanceDate: snapshot.maintenance.maintenanceDate,
    engineerName: snapshot.maintenance.engineerName,
    resetResult: snapshot.maintenance.resetResult,
    supplementaryNote: snapshot.maintenance.supplementaryNote,
    steps: snapshot.steps.map((step) => ({ ...step })),
    panels: snapshot.panels.map((panel) => ({ ...panel })),
  };
}

/**
 * 维修差异判定：只比较维修字段、排查步骤与故障面板。
 * 调用前置条件：两侧均为 v2 且包含维修数据。
 */
function hasMaintenanceDifference(
  before: ParsedRepairRequestRevisionSnapshot,
  after: ParsedRepairRequestRevisionSnapshot,
): boolean {
  if (
    before.maintenance.maintenanceDate !== after.maintenance.maintenanceDate ||
    before.maintenance.engineerName !== after.maintenance.engineerName ||
    before.maintenance.resetResult !== after.maintenance.resetResult ||
    before.maintenance.supplementaryNote !== after.maintenance.supplementaryNote
  ) {
    return true;
  }
  return !isSameList(before.steps, after.steps) || !isSameList(before.panels, after.panels);
}

/** 顺序敏感的深比较：步骤/面板本身带稳定顺序与 ID */
function isSameList<T extends object>(before: ReadonlyArray<T>, after: ReadonlyArray<T>): boolean {
  if (before.length !== after.length) {
    return false;
  }
  return before.every((item, index) => isSameRecord(item, after[index]));
}

function isSameRecord(left: object, right: object): boolean {
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      (left as Record<PropertyKey, unknown>)[key] === (right as Record<PropertyKey, unknown>)[key],
  );
}
