// src/usecases/local-runtime/export-record-package.usecase.ts

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  assertExportOrganizationAllowed,
  normalizeExportRecordIds,
  recordPackageResourceTypeEnum,
} from '@core/local-runtime/policy/record-package-export.policy';
import type { RecordPackageResourceType } from '@core/local-runtime/policy/record-package-manifest.policy';
import { Injectable } from '@nestjs/common';
import { RecordPackageExportService } from '@src/modules/lithography/record-package-export.service';
import type { RecordPackageExportResult } from '@src/modules/lithography/record-package-export.types';
import type { ExportRecordPackageCommand } from './local-runtime.command.types';
import { normalizePackageExportTarget } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * U 盘记录包导出（任务 09 R070，S2.3）。
 *
 * - 有权导出：一级管理员可指定任意公司数据区；工程师与二级管理员只能
 *   导出本公司数据区（导出命令必须显式给公司，客户端无隐式默认）；
 * - 记录归属在服务层逐条复核（数据为准，不信任命令参数）；
 * - 导出只读取已授权数据与原件，不写正式业务表；
 * - 导出产物为目录形态记录包，落盘前经导入侧同源结构自校验。
 */
@Injectable()
export class ExportRecordPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageExportService: RecordPackageExportService,
  ) {}

  async execute(command: ExportRecordPackageCommand): Promise<RecordPackageExportResult> {
    const scope = await this.scopeResolver.resolve(command.session);

    const targetPath = normalizePackageExportTarget(command.targetPath);
    const organizationId = normalizeExportOrganization(command.organizationId);
    assertExportOrganizationAllowed(scope.organizationId, organizationId);
    const recordIds = normalizeExportRecordIds(command.recordIds);
    const resourceType = normalizeExportResourceType(command.resourceType);

    return this.recordPackageExportService.exportPackage(
      {
        organizationId,
        targetPath,
        resourceType,
        recordIds,
      },
      command.session.accountId,
    );
  }
}

function normalizeExportOrganization(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '导出公司 ID 必须为正整数');
  }
  return value;
}

function normalizeExportResourceType(value: string): RecordPackageResourceType {
  const values = Object.values(recordPackageResourceTypeEnum) as readonly string[];
  if (!values.includes(value)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '资源类型不在允许清单内');
  }
  return value as RecordPackageResourceType;
}
