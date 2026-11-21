// src/usecases/local-runtime/local-runtime-status.types.ts

import type { LocalRuntimeViewerRole } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import type {
  LocalAuthorizationSummary,
  LocalCompanySettingSnapshot,
  LocalTaskStatusSummary,
} from '@src/modules/lithography/local-runtime.types';
import type { LocalRuntimeStorageProbeResult } from './local-runtime-storage-probe.contract';

/**
 * 本机运行状态视图（本地设置只读页）。
 *
 * 只承载部署身份、查看者范围、真实服务/存储状态与后台任务计数：
 * - 不含任何凭据、密钥、Token 或包内业务正文；
 * - 不声称"备份成功"或"已上云"，这些事实属 S3/S4 的清单视图。
 */
export type LocalRuntimeServiceStatus = {
  /** 本进程已能对外提供 GraphQL 查询，故恒为 UP（真实自检位） */
  apiStatus: 'UP';
  /** 本次读库成功即 UP；读失败会以错误上抛而不是伪报降级 */
  databaseStatus: 'UP' | 'DOWN';
  /** 上传/备份任务的耐久事实源 */
  taskFactSource: 'SQL';
  /** 进程重启后的任务恢复职责：由 SQL 扫描补偿，不依赖内存队列 */
  taskRecovery: 'ON_RESTART';
};

export type LocalRuntimeStatusView = {
  installationId: string;
  localSiteName: string | null;
  /**
   * 设备映射公司（`local_installation.organization_id`）。
   *
   * 仅当查看者是该公司或为全局范围时返回；否则为 null——把映射公司返回给
   * 其他公司的管理员属于跨公司事实泄露。未映射同样为 null。
   */
  mappedOrganizationId: number | null;
  mappedOrganizationCode: string | null;
  viewerRole: LocalRuntimeViewerRole;
  /** 查看者可读取的公司范围；一级管理员为 null（全局授权） */
  scopeOrganizationId: number | null;
  service: LocalRuntimeServiceStatus;
  storage: LocalRuntimeStorageProbeResult;
  /**
   * 本机后台任务计数；口径为**全设备**。
   *
   * 仅全局范围（一级管理员）返回，二级管理员与工程师为 null：
   * `local_upload_task` 无公司列（结构缺口 G-8），返回全设备计数会越过
   * 公司授权边界；P1 落地归属列后方可放开。
   */
  tasks: LocalTaskStatusSummary | null;
  /** 按查看者范围过滤后的本设备公司配置；首次初始化前为空数组 */
  companies: LocalCompanySettingSnapshot[];
  /** 按查看者范围过滤后的业务同步授权事实（仅计数与最近校验时间，不含凭据） */
  authorizations: LocalAuthorizationSummary[];
  generatedAt: Date;
};
