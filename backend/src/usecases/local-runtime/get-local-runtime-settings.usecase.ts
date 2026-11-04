// src/usecases/local-runtime/get-local-runtime-settings.usecase.ts

import { DomainError, LOCAL_RUNTIME_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { LocalInstallationSnapshot } from '@src/modules/lithography/local-runtime.types';
import { LocalRuntimeQueryService } from '@src/modules/lithography/queries/local-runtime.query.service';
import type { GetLocalRuntimeSettingsCommand } from './local-runtime.command.types';
import { assertLocalRuntimeSettingsRole } from './local-runtime-roles';

/** 读取单行本地安装身份与设置；单行缺失视为初始化异常。 */
@Injectable()
export class GetLocalRuntimeSettingsUsecase {
  constructor(private readonly localRuntimeQueryService: LocalRuntimeQueryService) {}

  async execute(command: GetLocalRuntimeSettingsCommand): Promise<LocalInstallationSnapshot> {
    assertLocalRuntimeSettingsRole(command.session);
    const installation = await this.localRuntimeQueryService.readInstallation();
    if (!installation) {
      throw new DomainError(LOCAL_RUNTIME_ERROR.INSTALLATION_NOT_FOUND, '本地安装身份未初始化');
    }
    return installation;
  }
}
