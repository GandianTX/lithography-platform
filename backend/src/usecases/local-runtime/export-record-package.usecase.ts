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
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { RecordPackageExportResult } from '@src/modules/lithography/record-package-export.types';
import type { ExportRecordPackageCommand } from './local-runtime.command.types';
import { normalizePackageExportTarget } from './local-runtime.input.normalize';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

/**
 * U 盘记录包导出（任务 09 R070，S2.3）。
 *
 * - 有权导出：一级管理员可指定任意公司数据区；工程师与二级管理员只能
 *   导出本公司数据区（导出命令必须显式给公司，客户端无隐式默认）；
 * - **逐条记录级授权**（任务 09 S1-3）：导出服务按来源域真实读取权限逐条裁决
 *   （工程师：报告／资料须本人创建；二级：本公司范围；一级：全局范围），
 *   导出账号与查看者范围由服务端按会话复核，不接受客户端传入；
 * - 记录归属在服务层逐条复核（数据为准，不信任命令参数）；
 * - 导出只读取已授权数据与原件，不写正式业务表；
 * - 导出产物为目录形态记录包，落盘前经导入侧同源结构自校验。
 */
@Injectable()
export class ExportRecordPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageExportService: RecordPackageExportService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(command: ExportRecordPackageCommand): Promise<RecordPackageExportResult> {
    const scope = await this.scopeResolver.resolve(command.session);

    const targetPath = normalizePackageExportTarget(command.targetPath);
    // 来源页导出入口省略公司时，按可信 session 范围取本公司（不接受客户端自报公司）
    const organizationId =
      command.organizationId === undefined
        ? normalizeExportOrganization(scope.organizationId)
        : normalizeExportOrganization(command.organizationId);
    assertExportOrganizationAllowed(scope.organizationId, organizationId);
    const recordIds = normalizeExportRecordIds(command.recordIds);
    const resourceType = normalizeExportResourceType(command.resourceType);

    return this.recordPackageExportService.exportPackage({
      organizationId,
      targetPath,
      resourceType,
      recordIds,
      exporterAccountId: command.session.accountId,
      exporterScope: scope,
      // 跨域读取提升到 usecase 层（账号域与业务域并列，模块间不得直接依赖）
      resolveSourceIdentity: async (accountId: number) => {
        const identity = await this.accountQueryService.findCrossInstallationIdentityByAccountId({
          accountId,
        });
        if (identity === null) {
          return { accountUuid: null, loginName: null, name: null };
        }
        return {
          accountUuid: identity.accountUuid,
          loginName: identity.loginName,
          name: identity.realName,
        };
      },
    });
  }
}

function normalizeExportOrganization(value: number | null | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    throw new DomainError(
      RECORD_PACKAGE_ERROR.INVALID_PARAMS,
      '导出公司必须由服务端按可信会话范围确定（或显式给出正整数公司 ID）',
    );
  }
  return value as number;
}

function normalizeExportResourceType(value: string): RecordPackageResourceType {
  const values = Object.values(recordPackageResourceTypeEnum) as readonly string[];
  if (!values.includes(value)) {
    throw new DomainError(RECORD_PACKAGE_ERROR.INVALID_PARAMS, '资源类型不在允许清单内');
  }
  return value as RecordPackageResourceType;
}
