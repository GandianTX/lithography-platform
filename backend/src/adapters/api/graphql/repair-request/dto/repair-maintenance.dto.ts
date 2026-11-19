// src/adapters/api/graphql/repair-request/dto/repair-maintenance.dto.ts
// 结构化内部维修记录输出对象（任务 04）

import { Field, Int, ObjectType } from '@nestjs/graphql';
import type {
  RepairIntakeSourceView,
  RepairMaintenanceAttachmentView,
  RepairMaintenanceFaultPanelView,
  RepairMaintenanceRecordView,
  RepairMaintenanceStepView,
} from '@src/modules/lithography/lithography.types';

@ObjectType({ description: '维修原件安全展示字段（不返回存储引用）' })
export class RepairMaintenanceAttachmentDTO {
  @Field(() => String, { description: '原件 ID' })
  fileId!: string;

  @Field(() => String, { description: '原始文件名' })
  originalFilename!: string;

  @Field(() => String, { description: 'MIME 类型' })
  mimeType!: string;

  @Field(() => Int, { description: '字节数' })
  byteSize!: number;

  @Field(() => String, { description: 'SHA-256 校验值' })
  checksumSha256!: string;
}

@ObjectType({ description: '工单排查步骤' })
export class RepairMaintenanceStepDTO {
  @Field(() => String, { description: '步骤 ID（调序保留）' })
  id!: string;

  @Field(() => Int, { description: '工单内顺序号' })
  stepNo!: number;

  @Field(() => String, { nullable: true, description: '报错代码' })
  errorCode!: string | null;

  @Field(() => String, { nullable: true, description: '零件/部位' })
  partName!: string | null;

  @Field(() => String, { description: '排查动作' })
  actionText!: string;

  @Field(() => String, { description: 'RESOLVED / UNRESOLVED / NEW_FAULT' })
  resultCode!: string;
}

@ObjectType({ description: '工单故障面板' })
export class RepairMaintenanceFaultPanelDTO {
  @Field(() => String, { description: '面板 ID' })
  id!: string;

  @Field(() => String, { description: 'INITIAL / STEP_NEW_FAULT / RESET_NEW_FAULT' })
  panelType!: string;

  @Field(() => String, { nullable: true, description: '来源步骤 ID（仅步骤新故障）' })
  stepId!: string | null;

  @Field(() => String, { nullable: true, description: '稳定阶段编码 PHASE_01—PHASE_10' })
  phaseCode!: string | null;

  @Field(() => String, { nullable: true })
  mainError!: string | null;

  @Field(() => String, { nullable: true })
  unitError!: string | null;

  @Field(() => String, { nullable: true })
  source!: string | null;

  @Field(() => String, { nullable: true })
  errorType!: string | null;

  @Field(() => String, { nullable: true })
  gpibStatus!: string | null;

  @Field(() => String, { nullable: true })
  faultStatus!: string | null;

  @Field(() => String)
  description!: string;

  @Field(() => String, { nullable: true })
  action!: string | null;
}

@ObjectType({ description: '工单结构化维修记录' })
export class RepairMaintenanceRecordDTO {
  @Field(() => String, { nullable: true, description: '维修日期 YYYY-MM-DD' })
  maintenanceDate!: string | null;

  @Field(() => String, { nullable: true, description: '维修工程师姓名快照' })
  engineerName!: string | null;

  @Field(() => String, { nullable: true, description: 'NORMAL / SAME_FAULT / NEW_FAULT' })
  resetResult!: string | null;

  @Field(() => String, { nullable: true, description: '补充说明' })
  supplementaryNote!: string | null;

  @Field(() => Int, { description: '维修记录版本号（乐观并发）' })
  versionNo!: number;

  @Field(() => RepairMaintenanceAttachmentDTO, {
    nullable: true,
    description: '已绑定维修原件（至多一份，绑定后不可替换）',
  })
  attachment!: RepairMaintenanceAttachmentDTO | null;
}

@ObjectType({ description: '首次 AI 分析尝试' })
export class RepairIntakeAnalysisDTO {
  @Field(() => String, { description: 'RUNNING / SUCCEEDED / FAILED' })
  status!: string;

  @Field(() => Int, { description: '0=初次；1=唯一重试' })
  generation!: number;

  @Field(() => String, { nullable: true, description: '模型输出原文（未成功时为空）' })
  outputText!: string | null;

  @Field(() => String, { nullable: true, description: '真实失败原因' })
  failureReason!: string | null;

  @Field(() => Date, { nullable: true })
  finishedAt!: Date | null;
}

@ObjectType({ description: '客户原始报修与首次 AI 分析' })
export class RepairIntakeSourceDTO {
  @Field(() => Int, { description: '报修原始输入 ID' })
  intakeId!: number;

  @Field(() => String, { description: '客户原始故障描述' })
  faultDescription!: string;

  @Field(() => RepairMaintenanceAttachmentDTO, { nullable: true, description: '客户报修原件' })
  customerFile!: RepairMaintenanceAttachmentDTO | null;

  @Field(() => RepairIntakeAnalysisDTO, { nullable: true, description: '尚无分析尝试时为空' })
  analysis!: RepairIntakeAnalysisDTO | null;
}

export function toRepairMaintenanceAttachmentDTO(
  view: RepairMaintenanceAttachmentView | null,
): RepairMaintenanceAttachmentDTO | null {
  return view === null ? null : { ...view };
}

export function toRepairMaintenanceStepDTO(
  view: RepairMaintenanceStepView,
): RepairMaintenanceStepDTO {
  return { ...view };
}

export function toRepairMaintenanceFaultPanelDTO(
  view: RepairMaintenanceFaultPanelView,
): RepairMaintenanceFaultPanelDTO {
  return { ...view };
}

export function toRepairMaintenanceRecordDTO(
  view: RepairMaintenanceRecordView | null,
): RepairMaintenanceRecordDTO | null {
  if (view === null) {
    return null;
  }
  return {
    maintenanceDate: view.maintenanceDate,
    engineerName: view.engineerName,
    resetResult: view.resetResult,
    supplementaryNote: view.supplementaryNote,
    versionNo: view.versionNo,
    attachment: toRepairMaintenanceAttachmentDTO(view.attachment),
  };
}

export function toRepairIntakeSourceDTO(
  view: RepairIntakeSourceView | null,
): RepairIntakeSourceDTO | null {
  if (view === null) {
    return null;
  }
  return {
    intakeId: view.intakeId,
    faultDescription: view.faultDescription,
    customerFile: toRepairMaintenanceAttachmentDTO(view.customerFile),
    analysis:
      view.analysis === null
        ? null
        : {
            status: view.analysis.status,
            generation: view.analysis.generation,
            outputText: view.analysis.outputText,
            failureReason: view.analysis.failureReason,
            finishedAt: view.analysis.finishedAt,
          },
  };
}
