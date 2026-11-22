// src/usecases/maintenance-report/record-package-item-writer.ts

/**
 * 维修报告域的**记录包受控写入实现**（任务 09 S3.2）。
 *
 * 定位：记录包导入的"受控写入"必须走来源业务既有的受控入口（这里＝
 * `CreateMaintenanceReportDraftUsecase`），不另立第二套权限口径——
 * 身份由服务端会话派生、公司范围由入口自己裁决。
 *
 * 已知边界（失败关闭，不静默降级）：
 * - 包内**原件**尚未接入受控写入入口：带原件的条目直接判失败，不丢原件；
 * - `WORK_ORDER_SUMMARY` 来源的报告内容由工单事实派生，不能由记录包导入；
 * - 资料与工单域**没有**可用的受控新建入口，由任务 09 侧按"无受控写入入口"判失败。
 */

import { Injectable } from '@nestjs/common';

import type {
  RecordPackageItemWriteOutcome,
  RecordPackageItemWriteRequest,
  RecordPackageItemWriter,
} from '@usecases/common/ports/record-package-item-writer.contract';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { CreateMaintenanceReportDraftUsecase } from './create-maintenance-report-draft.usecase';
import type {
  MaintenanceReportAlarmInput,
  MaintenanceReportDraftInput,
  MaintenanceReportFaultInput,
  MaintenanceReportStepInput,
} from './maintenance-report-command.types';

/** 快照载荷里可映射为草稿输入的字段 */
type SnapshotPayload = {
  sourceType?: unknown;
  repairRequestId?: unknown;
  title?: unknown;
  customerFactoryName?: unknown;
  equipmentModelId?: unknown;
  equipmentModelText?: unknown;
  maintenanceDate?: unknown;
  handlingResult?: unknown;
  closureReason?: unknown;
  resetResult?: unknown;
  actualCause?: unknown;
  repairActions?: unknown;
  verificationResult?: unknown;
  supplementaryNote?: unknown;
  alarms?: unknown;
  steps?: unknown;
  faults?: unknown;
};

/** 读取文本字段（缺省或非文本一律视为缺省，不猜值） */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 读取正整数（缺省或非法一律视为缺省） */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readSteps(value: unknown): MaintenanceReportStepInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const step = item as Record<string, unknown>;
    const stepCode = readText(step.stepCode);
    if (stepCode === null) {
      return [];
    }
    return [
      {
        actionText: readText(step.actionText) ?? '',
        isValidNewBranch: step.isValidNewBranch === true,
        newAlarmCode: readText(step.newAlarmCode),
        partName: readText(step.partName),
        phaseCode: readText(step.phaseCode),
        resultCode: readText(step.resultCode),
        resultText: readText(step.resultText),
        stepCode,
      },
    ];
  });
}

function readFaults(value: unknown): MaintenanceReportFaultInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const fault = item as Record<string, unknown>;
    const branchKind = readText(fault.branchKind);
    const description = readText(fault.description);
    if (branchKind === null || description === null) {
      return [];
    }
    return [
      {
        action: readText(fault.action),
        branchKind,
        description,
        errorType: readText(fault.errorType),
        faultStatus: readText(fault.faultStatus),
        gpibStatus: readText(fault.gpibStatus),
        mainError: readText(fault.mainError),
        phaseCode: readText(fault.phaseCode),
        source: readText(fault.source),
        unitError: readText(fault.unitError),
      },
    ];
  });
}

function readAlarms(value: unknown): MaintenanceReportAlarmInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const alarm = item as Record<string, unknown>;
    const alarmIndex = readNumber(alarm.alarmIndex);
    const alarmCode = readText(alarm.alarmCode);
    if (alarmIndex === null || alarmCode === null) {
      return [];
    }
    return [
      {
        alarmCode,
        alarmDescription: readText(alarm.alarmDescription),
        alarmIndex,
        phaseCode: readText(alarm.phaseCode) ?? '',
        resetResult: readText(alarm.resetResult) ?? '',
      },
    ];
  });
}

@Injectable()
export class MaintenanceReportRecordPackageItemWriter implements RecordPackageItemWriter {
  readonly supportedResourceTypes = ['MAINTENANCE_REPORT'] as const;

  constructor(private readonly createDraftUsecase: CreateMaintenanceReportDraftUsecase) {}

  async write(
    request: RecordPackageItemWriteRequest,
    session: UsecaseSession,
  ): Promise<RecordPackageItemWriteOutcome> {
    if (request.resourceType !== 'MAINTENANCE_REPORT') {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '该资源类型在维修报告域没有受控写入入口',
      };
    }
    if (request.originals.length > 0) {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '记录包原件尚未接入受控写入入口，本次不导入（不静默丢弃原件）',
      };
    }

    const payload = request.body.payload as SnapshotPayload | undefined;
    if (typeof payload !== 'object' || payload === null) {
      return { status: 'FAILED', localRecordId: null, reason: '包内报告载荷缺失或形状不受控' };
    }
    const sourceType = readText(payload.sourceType);
    if (sourceType === null) {
      return { status: 'FAILED', localRecordId: null, reason: '包内报告缺少来源类型' };
    }
    if (sourceType === 'WORK_ORDER_SUMMARY') {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: '工单总结来源的报告内容由工单事实派生，不能由记录包导入',
      };
    }

    const draft: MaintenanceReportDraftInput = {
      actualCause: readText(payload.actualCause),
      alarms: readAlarms(payload.alarms),
      closureReason: readText(payload.closureReason),
      customerFactoryName: readText(payload.customerFactoryName),
      equipmentModelId: readNumber(payload.equipmentModelId),
      equipmentModelText: readText(payload.equipmentModelText),
      faults: readFaults(payload.faults),
      handlingResult: readText(payload.handlingResult),
      maintenanceDate: readText(payload.maintenanceDate),
      repairActions: readText(payload.repairActions),
      resetResult: readText(payload.resetResult),
      steps: readSteps(payload.steps),
      supplementaryNote: readText(payload.supplementaryNote),
      title: readText(payload.title),
      verificationResult: readText(payload.verificationResult),
    };

    try {
      const created = await this.createDraftUsecase.execute({
        session,
        sourceType,
        repairRequestId: readNumber(payload.repairRequestId),
        draft,
      });
      return { status: 'CREATED', localRecordId: created.reportId, reason: null };
    } catch (error) {
      return {
        status: 'FAILED',
        localRecordId: null,
        reason: error instanceof Error ? error.message : '受控写入入口拒绝了该条导入',
      };
    }
  }
}
