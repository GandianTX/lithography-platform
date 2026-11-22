// src/adapters/api/graphql/local-runtime/dto/local-backup.dto.ts

import { Field, GraphQLISODateTime, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import type {
  LocalBackupRecordDetailSnapshot,
  LocalBackupRecordSnapshot,
  LocalBackupSettingSnapshot,
} from '@src/modules/lithography/local-runtime.types';

/** 备份记录分页入参（仅 OFFSET 形态，与本地运行域自有分页口径一致） */
@InputType()
export class LocalBackupRecordPaginationInput {
  @Field(() => Int, { nullable: true, description: '页码，从 1 开始' })
  @IsOptional()
  @IsInt({ message: '页码必须是整数' })
  @Min(1, { message: '页码必须大于等于 1' })
  page?: number;

  @Field(() => Int, { nullable: true, description: '每页条数（1-100）' })
  @IsOptional()
  @IsInt({ message: '每页条数必须是整数' })
  @Min(1, { message: '每页条数必须大于等于 1' })
  @Max(100, { message: '每页条数不能超过 100' })
  pageSize?: number;

  @Field(() => Boolean, { nullable: true, description: '是否返回总条数' })
  @IsOptional()
  @IsBoolean({ message: 'withTotal 必须是布尔值' })
  withTotal?: boolean;
}

/** 备份记录行（任务书第 12 节「备份记录」列） */
@ObjectType('LocalBackupRecord')
export class LocalBackupRecordDTO {
  @Field(() => String, { description: '备份资产 ID' })
  backupId!: string;

  @Field(() => Int, { description: '公司数据区' })
  organizationId!: number;

  @Field(() => Int, { nullable: true, description: '对应备份运行 ID' })
  runId?: number | null;

  @Field(() => String, { nullable: true, description: '本机安装标识' })
  installationId?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '触发方式：SCHEDULED 计划 / MANUAL 手动 / AUTO / RETRY / USB_EXPORT',
  })
  triggerType?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '运行状态：RUNNING / SUCCEEDED / FAILED / INTERRUPTED',
  })
  runStatus?: string | null;

  @Field(() => GraphQLISODateTime, { description: '备份开始时间' })
  startedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '备份结束时间' })
  finishedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { description: '资产登记时间' })
  createdAt!: Date;

  @Field(() => Int, { nullable: true, description: '包总字节数' })
  byteSize?: number | null;

  @Field(() => String, {
    description: '本地包状态：PENDING 待处理 / CLEANING 清理中 / CLEANED 已清理 / FAILED 清理失败',
  })
  localStatus!: string;

  @Field(() => Boolean, { description: '本地包是否仍保留在本机' })
  localPackageRetained!: boolean;

  @Field(() => String, {
    description: '云端状态：PENDING 待上传 / UPLOADING 上传中 / SUCCEEDED 已上云 / FAILED 上传失败',
  })
  cloudStatus!: string;

  @Field(() => Boolean, { description: '是否已取得完整云端回执' })
  cloudReceiptPresent!: boolean;

  @Field(() => String, { nullable: true, description: '清单 SHA-256' })
  manifestChecksum?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近校验成功时间' })
  verifiedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '保留截止时间' })
  retentionUntil?: Date | null;

  @Field(() => String, { nullable: true, description: '最近失败原因' })
  failureReason?: string | null;

  @Field(() => String, { nullable: true, description: '本地清理失败原因' })
  localCleanupError?: string | null;

  @Field(() => Int, { description: '云端上传尝试次数' })
  attemptCount!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次上传尝试时间' })
  lastAttemptAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '本地包清理事实时间' })
  deletedAt?: Date | null;
}

/** 一致性范围快照条目（只读元数据） */
@ObjectType('LocalBackupScopeEntry')
export class LocalBackupScopeEntryDTO {
  @Field(() => String, { description: '表名' })
  table!: string;

  @Field(() => Int, { description: '备份时该表的行数' })
  rowCount!: number;

  @Field(() => String, { nullable: true, description: '该表最近更新时间（ISO 8601）' })
  lastUpdatedAt?: string | null;
}

/** 备份记录详情（含清单元数据；不含包正文与密钥材料） */
@ObjectType('LocalBackupRecordDetail')
export class LocalBackupRecordDetailDTO {
  @Field(() => LocalBackupRecordDTO, { description: '备份记录行' })
  record!: LocalBackupRecordDTO;

  @Field(() => Int, { nullable: true, description: '清单结构版本' })
  schemaVersion?: number | null;

  @Field(() => String, { nullable: true, description: '保护密钥标识（仅标识，不含密钥）' })
  protectionKeyId?: string | null;

  @Field(() => Int, { nullable: true, description: '包内文件数' })
  fileCount?: number | null;

  @Field(() => Int, { nullable: true, description: '原件引用条目数' })
  originalCount?: number | null;

  @Field(() => [LocalBackupScopeEntryDTO], { description: '一致性范围快照' })
  scope!: LocalBackupScopeEntryDTO[];

  @Field(() => Boolean, { description: '清单是否可读（包已不在本机或清单损坏时为 false）' })
  manifestReadable!: boolean;
}

/** 备份记录分页结果 */
@ObjectType('LocalBackupRecordPage')
export class LocalBackupRecordPageDTO {
  @Field(() => [LocalBackupRecordDTO], { description: '备份记录行' })
  items!: LocalBackupRecordDTO[];

  @Field(() => Int, { nullable: true, description: '总条数' })
  total?: number | null;

  @Field(() => Int, { description: '当前页码' })
  page!: number;

  @Field(() => Int, { description: '每页条数' })
  pageSize!: number;
}

/** 自动备份设置（只读；约 72 小时周期与约 30 天保留窗口为需求固定口径） */
@ObjectType('LocalBackupSetting')
export class LocalBackupSettingDTO {
  @Field(() => Int, { description: '公司数据区' })
  organizationId!: number;

  @Field(() => String, { description: '本机安装标识' })
  installationId!: string;

  @Field(() => Boolean, { description: '本机是否启用自动备份' })
  backupEnabled!: boolean;

  @Field(() => Int, { description: '当前配置的备份间隔小时数' })
  backupIntervalHours!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '下次计划备份时间' })
  nextBackupAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近自动备份成功时间' })
  lastAutoSuccessAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近自动备份失败时间' })
  lastAutoFailureAt?: Date | null;

  @Field(() => String, { nullable: true, description: '最近一次自动备份失败原因' })
  failureReason?: string | null;

  @Field(() => Boolean, {
    description: '自动上云开关（只控制新的自动上云，不影响业务同步）',
  })
  autoUploadEnabled!: boolean;

  @Field(() => Int, { description: '需求固定：约 72 小时计划周期（只读）' })
  planIntervalHours!: number;

  @Field(() => Int, { description: '需求固定：约 30 天保留窗口（只读）' })
  retentionDays!: number;

  @Field(() => String, { nullable: true, description: '最近一次备份运行状态' })
  lastRunStatus?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次备份开始时间' })
  lastRunStartedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次备份结束时间' })
  lastRunFinishedAt?: Date | null;

  @Field(() => String, { nullable: true, description: '最近一次备份资产的云端状态' })
  lastAssetCloudStatus?: string | null;

  @Field(() => String, { nullable: true, description: '最近一次备份资产的本地包状态' })
  lastAssetLocalStatus?: string | null;
}

/** 手动备份触发结果（阶段状态如实反映实际执行情况） */
@ObjectType('StartManualLocalBackupResult')
export class StartManualLocalBackupResultDTO {
  @Field(() => Int, { description: '备份运行 ID' })
  runId!: number;

  @Field(() => Int, { description: '目标公司数据区' })
  organizationId!: number;

  @Field(() => String, { description: '生成阶段结果：SUCCEEDED / FAILED' })
  status!: string;

  @Field(() => String, { nullable: true, description: '生成的备份资产 ID' })
  backupId?: string | null;

  @Field(() => String, { nullable: true, description: '清单 SHA-256' })
  manifestChecksum?: string | null;

  @Field(() => Int, { nullable: true, description: '包总字节数' })
  byteSize?: number | null;

  @Field(() => String, { nullable: true, description: '失败错误码' })
  errorCode?: string | null;

  @Field(() => String, { nullable: true, description: '失败说明' })
  errorMessage?: string | null;

  @Field(() => String, {
    description:
      '上云阶段状态：PENDING 待上云 / RUNNING / SUCCEEDED / FAILED / NOT_REQUIRED；云接收端未接入时保持 PENDING',
  })
  uploadStatus!: string;

  @Field(() => String, {
    description: '清理阶段状态：无完整云端回执时不执行本地包清理，保持 PENDING',
  })
  cleanupStatus!: string;
}

/** View → DTO 薄映射 */
export function toLocalBackupRecordDTO(view: LocalBackupRecordSnapshot): LocalBackupRecordDTO {
  return { ...view };
}

export function toLocalBackupRecordDetailDTO(
  view: LocalBackupRecordDetailSnapshot,
): LocalBackupRecordDetailDTO {
  return {
    record: toLocalBackupRecordDTO(view.record),
    schemaVersion: view.schemaVersion,
    protectionKeyId: view.protectionKeyId,
    fileCount: view.fileCount,
    originalCount: view.originalCount,
    scope: view.scope.map((entry) => ({
      table: entry.table,
      rowCount: entry.rowCount,
      lastUpdatedAt: entry.lastUpdatedAt,
    })),
    manifestReadable: view.manifestReadable,
  };
}

export function toLocalBackupSettingDTO(view: LocalBackupSettingSnapshot): LocalBackupSettingDTO {
  return { ...view };
}

/** 恢复预检发现项 */
@ObjectType('LocalRestoreCheckFinding')
export class LocalRestoreCheckFindingDTO {
  @Field(() => String, { description: '发现项编码' })
  code!: string;

  @Field(() => String, { description: '可展示的原因（不含包正文与凭据）' })
  message!: string;
}

/** 恢复预检结果（目标核对＋包完整性＋保护副本） */
@ObjectType('LocalRestorePrecheckResult')
export class LocalRestorePrecheckResultDTO {
  @Field(() => String, { description: '恢复预检 ID' })
  restoreId!: string;

  @Field(() => String, { description: '预检结论：PASSED 通过 / FAILED 未通过' })
  outcome!: string;

  @Field(() => GraphQLISODateTime, { description: '核对时间' })
  checkedAt!: Date;

  @Field(() => String, { description: '被恢复的备份资产 ID' })
  targetBackupId!: string;

  @Field(() => Int, { description: '恢复目标公司数据区' })
  targetOrganizationId!: number;

  @Field(() => String, { nullable: true, description: '本机安装标识' })
  targetInstallationId?: string | null;

  @Field(() => String, { nullable: true, description: '清单 SHA-256' })
  manifestChecksum?: string | null;

  @Field(() => Boolean, { description: '本机备份包清单是否可读' })
  packageReadable!: boolean;

  @Field(() => Int, { nullable: true, description: '包内文件数' })
  fileCount?: number | null;

  @Field(() => Int, { nullable: true, description: '原件引用条目数' })
  originalCount?: number | null;

  @Field(() => Int, { description: '已通过校验的文件数' })
  verifiedFileCount!: number;

  @Field(() => String, { nullable: true, description: '保护副本的备份资产 ID' })
  protectionBackupId?: string | null;

  @Field(() => Boolean, { description: '保护副本是否已生成' })
  protectionCreated!: boolean;

  @Field(() => [LocalRestoreCheckFindingDTO], { description: '预检发现项（空表示通过）' })
  findings!: LocalRestoreCheckFindingDTO[];
}

/** 恢复执行能力状态（如实声明当前环境是否可执行恢复） */
@ObjectType('LocalRestoreCapability')
export class LocalRestoreCapabilityDTO {
  @Field(() => Boolean, { description: '恢复执行入口是否可用' })
  executionAvailable!: boolean;

  @Field(() => String, { description: '不可用原因或启用说明' })
  reason!: string;
}

/** 清理方式：MANUAL 手动清理（须有完整云端回执）/ RETENTION 过期清理（约 30 天保留窗口） */
export enum LocalBackupCleanupMode {
  MANUAL = 'MANUAL',
  RETENTION = 'RETENTION',
}

/** 单个备份包的清理结果（逐项可追踪） */
@ObjectType('LocalBackupCleanupItem')
export class LocalBackupCleanupItemDTO {
  @Field(() => String, { description: '备份资产 ID' })
  backupId!: string;

  @Field(() => String, { description: '清理结果：CLEANED 已清理 / RETAINED 仍保留' })
  outcome!: string;

  @Field(() => String, { nullable: true, description: '仍保留的原因（已清理时为空）' })
  reason?: string | null;
}

/** 一轮清理的汇总结果 */
@ObjectType('LocalBackupCleanupResult')
export class LocalBackupCleanupResultDTO {
  @Field(() => String, { description: '清理方式：MANUAL / RETENTION' })
  mode!: string;

  @Field(() => Int, { description: '目标公司数据区' })
  organizationId!: number;

  @Field(() => Boolean, {
    description: '是否具备清理授权；不可用时已清理数必为 0（零清理）',
  })
  available!: boolean;

  @Field(() => String, { nullable: true, description: '不可用原因' })
  reason?: string | null;

  @Field(() => Int, { description: '固定后的清理目标数' })
  targetCount!: number;

  @Field(() => Int, { description: '已清理数量' })
  cleaned!: number;

  @Field(() => Int, { description: '仍保留数量' })
  retained!: number;

  @Field(() => [LocalBackupCleanupItemDTO], { description: '逐项清理结果' })
  items!: LocalBackupCleanupItemDTO[];
}

/** 云端备份包元数据（受控；不含密钥与存储引用） */
@ObjectType('LocalBackupCloudPackage')
export class LocalBackupCloudPackageDTO {
  @Field(() => String, { description: '云端包标识（下载用）' })
  packageId!: string;

  @Field(() => Int, { description: '归属公司数据区' })
  organizationId!: number;

  @Field(() => String, { nullable: true, description: '本机备份标识' })
  backupId?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '生成时间' })
  createdAt?: Date | null;

  @Field(() => Int, { nullable: true, description: '包字节数' })
  byteSize?: number | null;

  @Field(() => String, { nullable: true, description: '内容摘要' })
  checksumSha256?: string | null;
}

/** 受授权的云端备份包清单 */
@ObjectType('LocalBackupCloudPackageList')
export class LocalBackupCloudPackageListDTO {
  @Field(() => Int, { description: '本次查询的公司数据区' })
  organizationId!: number;

  @Field(() => [LocalBackupCloudPackageDTO], { description: '云端包元数据' })
  packages!: LocalBackupCloudPackageDTO[];
}

/** 恢复受理结论（受理 ≠ 恢复：只确认"可以受理"，不代表已恢复） */
@ObjectType('LocalRestoreAcceptance')
export class LocalRestoreAcceptanceDTO {
  @Field(() => String, { description: '稳定恢复 ID' })
  restoreId!: string;

  @Field(() => Boolean, { description: '是否已受理（受理不等于恢复成功）' })
  accepted!: boolean;

  @Field(() => String, { nullable: true, description: '被恢复的备份资产 ID' })
  backupId?: string | null;

  @Field(() => String, { nullable: true, description: '保护副本备份资产 ID' })
  protectionBackupId?: string | null;

  @Field(() => Int, { nullable: true, description: '恢复目标公司数据区' })
  organizationId?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '受理时间' })
  acceptedAt?: Date | null;
}
