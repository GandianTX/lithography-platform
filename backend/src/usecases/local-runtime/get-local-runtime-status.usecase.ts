// src/usecases/local-runtime/get-local-runtime-status.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { LocalCompanySettingQueryService } from '@src/modules/lithography/queries/local-company-setting.query.service';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { GetLocalRuntimeStatusCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import {
  LOCAL_RUNTIME_STORAGE_PROBE,
  type LocalRuntimeStorageProbe,
} from './local-runtime-storage-probe.contract';
import type { LocalRuntimeStatusView } from './local-runtime-status.types';

/**
 * 读取本机运行状态（本地设置只读页，R064）。
 *
 * 只读：不创建公司配置、不触发备份、不写任何表。首次初始化建计划属 S3 写入用例。
 * 范围：工程师与二级管理员只看本公司配置，一级管理员看本设备全部公司配置。
 * 存储位置只来自部署配置，不遍历文件系统（R064 约束）。
 */
@Injectable()
export class GetLocalRuntimeStatusUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly localCompanySettingQueryService: LocalCompanySettingQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    @Inject(LOCAL_RUNTIME_STORAGE_PROBE)
    private readonly storageProbe: LocalRuntimeStorageProbe,
  ) {}

  async execute(command: GetLocalRuntimeStatusCommand): Promise<LocalRuntimeStatusView> {
    const scope = await this.scopeResolver.resolve(command.session);

    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }

    const [companies, authorizations, installationWideTasks, storage] = await Promise.all([
      this.localCompanySettingQueryService.listForScope(
        installation.installationId,
        scope.organizationId,
      ),
      this.localRuntimeQueryService.readAuthorizationSummary(
        installation.installationId,
        scope.organizationId,
      ),
      this.localRuntimeQueryService.readTaskStatusSummary(installation.installationId),
      this.storageProbe.probe(),
    ]);

    /**
     * 任务计数是**全设备口径**：`local_upload_task` 没有公司列（结构缺口 G-8），
     * 因此无法按公司归属过滤。把它返回给二级管理员或工程师，等于把其他公司的
     * 待传/失败数量暴露给非授权范围，违背 R065 的授权边界。故仅全局范围返回，
     * 其余范围返回 null，由页面显式说明"无法按公司归属统计"。
     * 该限制在 P1（枚举/归属列迁移）落地后可放开。
     */
    const tasks = scope.organizationId === null ? installationWideTasks : null;

    /**
     * 设备映射公司只在"查看者就是该公司或全局范围"时可见：二级管理员/工程师
     * 不属于设备映射公司时，把映射公司编号返回给他们属于跨公司事实泄露。
     */
    const canSeeMapping =
      scope.organizationId === null || scope.organizationId === installation.organizationId;

    return {
      installationId: installation.installationId,
      localSiteName: installation.localSiteName,
      mappedOrganizationId: canSeeMapping ? installation.organizationId : null,
      mappedOrganizationCode: canSeeMapping ? installation.organizationCodeSnapshot : null,
      viewerRole: scope.role,
      scopeOrganizationId: scope.organizationId,
      service: {
        // 能执行到这里说明本次请求已被 API 处理，且三条数据库读取均已成功返回，
        // 因此两个 UP 是本次请求的真实结果，不是静态配置值
        apiStatus: 'UP',
        databaseStatus: 'UP',
        taskFactSource: 'SQL',
        taskRecovery: 'ON_RESTART',
      },
      storage,
      tasks,
      companies,
      authorizations,
      generatedAt: new Date(),
    };
  }
}
