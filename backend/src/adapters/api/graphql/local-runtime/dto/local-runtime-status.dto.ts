// src/adapters/api/graphql/local-runtime/dto/local-runtime-status.dto.ts

import {
  localRuntimeViewerRoleValues,
  type LocalRuntimeViewerRole,
} from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';
import type { LocalRuntimeStatusView } from '@src/usecases/local-runtime/local-runtime-status.types';

/** 本机服务状态（真实读数，不做乐观降级） */
@ObjectType('LocalRuntimeServiceStatus')
export class LocalRuntimeServiceStatusDTO {
  @Field(() => String, {
    description: 'API 服务状态：UP 表示本次请求已被 API 处理（真实自检位，非静态配置）',
  })
  apiStatus!: string;

  @Field(() => String, {
    description:
      '数据库连通状态：UP 表示本次请求已完成数据库读取；读取失败则整个查询报错，不会返回 UP',
  })
  databaseStatus!: string;

  @Field(() => String, { description: '上传/备份任务的耐久事实源：SQL' })
  taskFactSource!: string;

  @Field(() => String, { description: '进程重启后的任务恢复职责：ON_RESTART' })
  taskRecovery!: string;
}

/** 本机存储位置（只来自部署配置，不扫描文件系统） */
@ObjectType('LocalRuntimeStorageStatus')
export class LocalRuntimeStorageStatusDTO {
  @Field(() => String, { description: '业务原件默认保存位置（部署配置值）' })
  businessFileDirectory!: string;

  @Field(() => Boolean, { description: '业务原件目录当前是否可写' })
  businessFileDirectoryWritable!: boolean;

  @Field(() => String, { description: '备份包默认保存位置（部署配置值，与业务原件目录分离）' })
  backupDirectory!: string;

  @Field(() => Boolean, { description: '备份包目录当前是否可写' })
  backupDirectoryWritable!: boolean;
}

/** 本机后台任务计数（说明业务与队列已落库，不展示任何业务正文） */
@ObjectType('LocalRuntimeTaskStatus')
export class LocalRuntimeTaskStatusDTO {
  @Field(() => Int, { description: '待上传任务数' })
  pendingUploadCount!: number;

  @Field(() => Int, { description: '上传中任务数' })
  uploadingUploadCount!: number;

  @Field(() => Int, { description: '上传失败任务数' })
  failedUploadCount!: number;

  @Field(() => Int, { description: '已上传成功任务数' })
  succeededUploadCount!: number;

  @Field(() => Int, { description: '运行中的备份任务数' })
  runningBackupCount!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次备份开始时间' })
  lastBackupStartedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次备份结束时间' })
  lastBackupFinishedAt?: Date | null;
}

/** 本设备某公司的备份计划与云开关（只读展示，写入入口属 S3） */
@ObjectType('LocalRuntimeCompanySetting')
export class LocalRuntimeCompanySettingDTO {
  @Field(() => Int, { description: '公司 ID' })
  organizationId!: number;

  @Field(() => Boolean, { description: '该公司的自动备份计划是否已启用' })
  backupEnabled!: boolean;

  @Field(() => Int, { description: '自动备份间隔小时数' })
  backupIntervalHours!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '下次计划备份时间' })
  nextBackupAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近自动备份成功时间' })
  lastAutoSuccessAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近自动备份失败时间' })
  lastAutoFailureAt?: Date | null;

  @Field(() => String, { nullable: true, description: '最近一次自动备份失败原因' })
  failureReason?: string | null;

  @Field(() => Boolean, { description: '自动备份成功后是否自动上云' })
  autoUploadEnabled!: boolean;

  @Field(() => GraphQLISODateTime, { description: '该公司的计划初始化时间' })
  initializedAt!: Date;
}

/** 本机某公司的业务同步授权事实（只读，不含任何凭据材料） */
@ObjectType('LocalRuntimeAuthorizationSummary')
export class LocalRuntimeAuthorizationSummaryDTO {
  @Field(() => Int, { description: '公司 ID' })
  organizationId!: number;

  @Field(() => Int, { description: '有效授权记录数' })
  activeCount!: number;

  @Field(() => Int, { description: '已撤销授权记录数（撤销后仅保留待传，不再发起新同步）' })
  revokedCount!: number;

  @Field(() => GraphQLISODateTime, { nullable: true, description: '最近一次签名校验成功时间' })
  lastVerifiedAt?: Date | null;

  @Field(() => String, {
    description:
      '凭据用途：恒为 BUSINESS_SYNC（业务同步）；自动备份凭据不复用本表，避免同一凭据既同步又归档',
  })
  credentialPurpose!: string;
}

/** 本机运行状态（本地设置只读页） */
@ObjectType('LocalRuntimeStatus')
export class LocalRuntimeStatusDTO {
  @Field(() => String, { description: '本机安装标识' })
  installationId!: string;

  @Field(() => String, { nullable: true, description: '现场名称' })
  localSiteName?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: '设备映射公司 ID；未映射为 null，查看者不属于该公司且非全局范围时同样为 null',
  })
  mappedOrganizationId?: number | null;

  @Field(() => String, { nullable: true, description: '设备映射公司编码留痕' })
  mappedOrganizationCode?: string | null;

  @Field(() => localRuntimeViewerRoleValues, {
    description: '当前查看者角色：ADMIN_LEVEL_1 / ADMIN_LEVEL_2 / ENGINEER',
  })
  viewerRole!: LocalRuntimeViewerRole;

  @Field(() => Int, {
    nullable: true,
    description: '查看者可读取的公司范围；一级管理员为 null（全局授权）',
  })
  scopeOrganizationId?: number | null;

  @Field(() => LocalRuntimeServiceStatusDTO, { description: '本机服务状态' })
  service!: LocalRuntimeServiceStatusDTO;

  @Field(() => LocalRuntimeStorageStatusDTO, { description: '本机存储位置与可用状态' })
  storage!: LocalRuntimeStorageStatusDTO;

  @Field(() => LocalRuntimeTaskStatusDTO, {
    nullable: true,
    description:
      '本机后台任务计数（全设备口径）。仅一级管理员可见；二级管理员与工程师为 null，因为任务表无公司列，返回全设备计数会越过公司授权边界',
  })
  tasks?: LocalRuntimeTaskStatusDTO | null;

  @Field(() => [LocalRuntimeCompanySettingDTO], {
    description: '按查看者范围过滤后的本设备公司备份计划（首次初始化前为空）',
  })
  companies!: LocalRuntimeCompanySettingDTO[];

  @Field(() => [LocalRuntimeAuthorizationSummaryDTO], {
    description: '按查看者范围过滤后的业务同步授权事实（只含计数与校验时间）',
  })
  authorizations!: LocalRuntimeAuthorizationSummaryDTO[];

  @Field(() => GraphQLISODateTime, { description: '本次状态读取时间' })
  generatedAt!: Date;
}

/** View → DTO 薄映射：只做字段搬运，不做业务判断 */
export function toLocalRuntimeStatusDTO(view: LocalRuntimeStatusView): LocalRuntimeStatusDTO {
  return {
    installationId: view.installationId,
    localSiteName: view.localSiteName,
    mappedOrganizationId: view.mappedOrganizationId,
    mappedOrganizationCode: view.mappedOrganizationCode,
    viewerRole: view.viewerRole,
    scopeOrganizationId: view.scopeOrganizationId,
    service: {
      apiStatus: view.service.apiStatus,
      databaseStatus: view.service.databaseStatus,
      taskFactSource: view.service.taskFactSource,
      taskRecovery: view.service.taskRecovery,
    },
    storage: {
      businessFileDirectory: view.storage.businessFileDirectory,
      businessFileDirectoryWritable: view.storage.businessFileDirectoryWritable,
      backupDirectory: view.storage.backupDirectory,
      backupDirectoryWritable: view.storage.backupDirectoryWritable,
    },
    tasks: view.tasks
      ? {
          pendingUploadCount: view.tasks.pendingUploadCount,
          uploadingUploadCount: view.tasks.uploadingUploadCount,
          failedUploadCount: view.tasks.failedUploadCount,
          succeededUploadCount: view.tasks.succeededUploadCount,
          runningBackupCount: view.tasks.runningBackupCount,
          lastBackupStartedAt: view.tasks.lastBackupStartedAt,
          lastBackupFinishedAt: view.tasks.lastBackupFinishedAt,
        }
      : null,
    companies: view.companies.map((company) => ({
      organizationId: company.organizationId,
      backupEnabled: company.backupEnabled,
      backupIntervalHours: company.backupIntervalHours,
      nextBackupAt: company.nextBackupAt,
      lastAutoSuccessAt: company.lastAutoSuccessAt,
      lastAutoFailureAt: company.lastAutoFailureAt,
      failureReason: company.failureReason,
      autoUploadEnabled: company.autoUploadEnabled,
      initializedAt: company.initializedAt,
    })),
    authorizations: view.authorizations.map((authorization) => ({
      organizationId: authorization.organizationId,
      activeCount: authorization.activeCount,
      revokedCount: authorization.revokedCount,
      lastVerifiedAt: authorization.lastVerifiedAt,
      // 用途如实反映（S4）：按授权声明汇总；无声明＝不可核验
      credentialPurpose:
        authorization.credentialPurposes.length > 0
          ? authorization.credentialPurposes.join(',')
          : 'UNKNOWN',
    })),
    generatedAt: view.generatedAt,
  };
}
