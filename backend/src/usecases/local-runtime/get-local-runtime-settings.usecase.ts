// src/usecases/local-runtime/get-local-runtime-settings.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { GetLocalRuntimeSettingsCommand } from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * 读取单行本地安装身份与设置；单行缺失视为初始化异常。
 *
 * 设备身份本身不含任何公司业务正文，因此工程师、二级与一级管理员均可读取；
 * 公司维度的可见范围由调用方按 `LocalRuntimeViewerScope` 继续约束。
 */
@Injectable()
export class GetLocalRuntimeSettingsUsecase {
  constructor(
    private readonly localRuntimeQueryService: LocalRuntimeQueryService,
    private readonly scopeResolver: LocalRuntimeScopeResolver,
  ) {}

  async execute(command: GetLocalRuntimeSettingsCommand): Promise<LocalInstallationSnapshot> {
    await this.scopeResolver.resolve(command.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }
    return installation;
  }
}
