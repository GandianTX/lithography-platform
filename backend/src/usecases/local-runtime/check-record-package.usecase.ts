// src/usecases/local-runtime/check-record-package.usecase.ts

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import type {
  CheckRecordPackageCommand,
  GetRecordPackageResultCommand,
} from './local-runtime.command.types';
import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';
import { RecordPackageImportQueryService } from '@src/modules/lithography/queries/record-package-import.query.service';
import type {
  RecordPackageCheckResult,
  RecordPackageImportSnapshot,
  RecordPackageItemSnapshot,
} from '@src/modules/lithography/record-package-import.types';
import { normalizePackagePath } from './local-runtime.input.normalize';

/**
 * 记录包检查（任务 09 R071，S2.3）。
 *
 * - 工程师与二级管理员只能检查本公司包（包公司必须与可信公司一致）；
 *   一级管理员为全局范围；
 * - **跨安装公司对齐**（任务 09 S1-2）：包清单携带公司业务编码时按**编码**核对
 *   （源机的公司自增 id 在本机无意义），缺编码的旧包回退数字 id 比较；
 * - 检查不写正式业务（R071），只落检查事实；
 * - 同包重复检查返回既有批次（R073"同包重复操作一个事实"）；
 * - 包路径必须是本机绝对路径（U盘挂载点或本机目录），只读取包内相对路径文件。
 */
@Injectable()
export class CheckRecordPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageImportService: RecordPackageImportService,
    private readonly organizationQueryService: OrganizationQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: CheckRecordPackageCommand): Promise<RecordPackageCheckResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    const packagePath = normalizePackagePath(command.packagePath);

    // 查看者公司的稳定业务编码（跨安装对齐公司身份；读取失败即 null）
    const organizationCode =
      scope.organizationId === null
        ? null
        : ((
            await this.organizationQueryService.findOrganizationIdentityById({
              organizationId: scope.organizationId,
            })
          )?.organizationCode ?? null);

    // 评估阶段无 DB 写入；落库阶段用短事务保证批次＋逐条事实一起可见
    const evaluation = await this.recordPackageImportService.evaluatePackage({
      packagePath,
      organizationId: scope.organizationId,
      organizationCode,
      importedByAccountId: command.session.accountId,
    });

    return this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.persistCheckOutcome(
        evaluation,
        command.session.accountId,
        transactionContext,
      ),
    );
  }
}

/**
 * 记录包处理结果查询（任务 09 R073，S2.3）。
 * 只看本公司本包；范围外与不存在同码返回。
 */
@Injectable()
export class GetRecordPackageResultUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageImportQueryService: RecordPackageImportQueryService,
  ) {}

  async execute(
    command: GetRecordPackageResultCommand,
  ): Promise<{ import: RecordPackageImportSnapshot; items: RecordPackageItemSnapshot[] }> {
    const scope = await this.scopeResolver.resolve(command.session);
    const record = await this.recordPackageImportQueryService.readImport(
      command.packageId,
      scope.organizationId,
    );
    if (!record) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND,
        '记录包处理结果不存在或不在授权范围内',
      );
    }
    const items = await this.recordPackageImportQueryService.listItems(command.packageId);
    return { import: record, items };
  }
}
