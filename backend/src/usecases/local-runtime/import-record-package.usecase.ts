// src/usecases/local-runtime/import-record-package.usecase.ts

/**
 * 记录包导入编排（任务 09 S3.2）。
 *
 * 链路：选择文件 → 安全预检（`CheckRecordPackageUsecase`）→ 明确确认 → **本用例** →
 * 受控逐项导入 → 逐项结果（`record_package_item.result`）。
 *
 * 纪律：
 * - **不自己写业务**：每条记录交给来源域的受控写入入口（中立端口
 *   `RECORD_PACKAGE_ITEM_WRITER`，由来源域提供实现、调用期惰性查找）；
 *   未注册受控写入入口 = 该条失败关闭，不静默跳过、不半写业务；
 * - **确认绑定包**：确认时必须带上检查结论的清单摘要；包内容变了旧确认即作废，
 *   要求重新检查与确认（换包即清除旧确认）；
 * - **逐条结果**：每条都落 SUCCEEDED／FAILED／SKIPPED／CONFLICT 与原因，
 *   批次终态由逐条结果汇总，不允许"看起来整体成功"；
 * - **去重**：导入前复核同键回执（与同步共用去重口径），已存在同版本即跳过。
 */

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { parseRecordPackageManifest } from '@core/local-runtime/policy/record-package-manifest.policy';
import { ModuleRef } from '@nestjs/core';
import { Inject, Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import type {
  RecordPackageImportSnapshot,
  RecordPackageItemSnapshot,
} from '@src/modules/lithography/record-package-import.types';

import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';

import {
  RECORD_PACKAGE_ITEM_WRITER,
  type RecordPackageImportResourceType,
  type RecordPackageItemWriter,
} from '@usecases/common/ports/record-package-item-writer.contract';

import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

import { LocalRuntimeScopeResolver } from './local-runtime-scope.resolver';

export type ImportRecordPackageCommand = {
  session: UsecaseSession;
  packageId: string;
  packagePath: string;
  /** 明确确认时看到的清单摘要；与检查结论不一致即旧确认作废 */
  manifestChecksum: string;
};

export type ImportRecordPackageResult = {
  outcome: 'imported' | 'existing';
  import: RecordPackageImportSnapshot;
  items: RecordPackageItemSnapshot[];
};

@Injectable()
export class ImportRecordPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageImportService: RecordPackageImportService,
    private readonly receiptService: BusinessSyncReceiptService,
    private readonly moduleRef: ModuleRef,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute(command: ImportRecordPackageCommand): Promise<ImportRecordPackageResult> {
    const scope = await this.scopeResolver.resolve(command.session);
    const facts = await this.recordPackageImportService.readImportFacts(command.packageId);
    if (facts === null || facts.import.organizationId !== scope.organizationId) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包不存在或不在授权范围内');
    }
    if (facts.import.checkStatus !== 'PASSED') {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED,
        '记录包尚未通过安全预检，不能导入',
      );
    }

    // 确认绑定：包内容必须与检查结论一致（换包 → 旧确认作废）
    const evaluation = await this.recordPackageImportService.evaluatePackage({
      packagePath: command.packagePath,
      organizationId: scope.organizationId,
      importedByAccountId: command.session.accountId,
    });
    if (
      evaluation.manifestChecksum !== facts.import.manifestChecksum ||
      evaluation.manifestChecksum !== command.manifestChecksum
    ) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED,
        '包内容与检查结论不一致，请重新检查并确认',
      );
    }

    const manifest = parseRecordPackageManifest(facts.import.manifestJson);
    const writer = this.resolveWriter();

    await this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.markImportRunning(
        command.packageId,
        command.session.accountId,
        transactionContext,
      ),
    );

    let succeeded = 0;
    let failed = 0;
    for (const item of facts.items) {
      if (item.checkResult !== 'PASSED') {
        continue;
      }
      // 中断重试：已成功或已判定跳过的条目不重做（幂等）
      if (item.result === 'SUCCEEDED' || item.result === 'SKIPPED') {
        succeeded += 1;
        continue;
      }
      const outcome = await this.importOne({
        item,
        manifestItem: manifest.items.find((candidate) => candidate.record_uuid === item.recordUuid),
        organizationId: facts.import.organizationId,
        manifestChecksum: facts.import.manifestChecksum,
        sourceInstallationId: manifest.installation_id,
        session: command.session,
        writer,
      });
      if (outcome.result === 'SUCCEEDED' || outcome.result === 'SKIPPED') {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }

    const status = failed === 0 ? 'SUCCEEDED' : succeeded === 0 ? 'FAILED' : 'PARTIAL';
    await this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.finalizeImport(
        command.packageId,
        { status, succeeded, failed },
        transactionContext,
      ),
    );

    const updated = await this.recordPackageImportService.readImportFacts(command.packageId);
    return {
      outcome: 'imported',
      import: updated?.import ?? facts.import,
      items: updated?.items ?? facts.items,
    };
  }

  /** 逐条导入：复核去重事实 → 受控写入 → 落逐条结果 */
  private async importOne(input: {
    item: RecordPackageItemSnapshot;
    manifestItem:
      | {
          content_snapshot: unknown;
          files: { sha256: string }[];
          source_account_id?: number | null;
          owner_organization_id?: number | null;
          source_status?: string | null;
        }
      | undefined;
    organizationId: number;
    manifestChecksum: string;
    sourceInstallationId: string;
    session: UsecaseSession;
    writer: RecordPackageItemWriter | null;
  }): Promise<{ result: string }> {
    const { item } = input;

    // 1. 与同步共用去重：同键回执已存在即跳过（不重复导入）
    const duplicate = await this.hasImportedOrSyncedVersion(item, input.organizationId);
    if (duplicate) {
      await this.writeItemResult(item.itemId, {
        result: 'SKIPPED',
        errorMessage: '本机已存在同一记录版本（与同步去重口径一致），本次不重复导入',
        receiptId: null,
      });
      return { result: 'SKIPPED' };
    }

    // 1b. 归属公司复核：包内登记的归属公司必须与目标公司一致（数据为准）
    const ownerOrganizationId = input.manifestItem?.owner_organization_id ?? null;
    if (ownerOrganizationId !== null && ownerOrganizationId !== input.organizationId) {
      await this.writeItemResult(item.itemId, {
        result: 'FAILED',
        errorMessage: '包内归属公司与目标公司不一致，该条未导入',
        receiptId: null,
      });
      return { result: 'FAILED' };
    }

    // 2. 没有受控写入入口 = 该条失败关闭
    if (input.writer === null) {
      await this.writeItemResult(item.itemId, {
        result: 'FAILED',
        errorMessage: '没有可用的受控写入入口，该条未导入',
        receiptId: null,
      });
      return { result: 'FAILED' };
    }
    if (!input.writer.supportedResourceTypes.includes(item.resourceType as never)) {
      await this.writeItemResult(item.itemId, {
        result: 'FAILED',
        errorMessage: `${item.resourceType} 在来源业务域没有受控写入入口，该条未导入`,
        receiptId: null,
      });
      return { result: 'FAILED' };
    }

    // 3. 受控写入
    const snapshot = input.manifestItem?.content_snapshot;
    const body =
      typeof snapshot === 'object' && snapshot !== null
        ? (snapshot as Record<string, unknown>)
        : {};
    const outcome = await input.writer.write(
      {
        resourceType: item.resourceType as RecordPackageImportResourceType,
        recordUuid: item.recordUuid,
        versionNo: item.versionNo,
        organizationId: input.organizationId,
        body,
        originals: [],
        manifestChecksum: input.manifestChecksum,
        sourceAccountId: input.manifestItem?.source_account_id ?? null,
        ownerOrganizationId,
        sourceStatus: input.manifestItem?.source_status ?? null,
      },
      input.session,
    );

    if (outcome.status === 'CREATED') {
      const receiptId = await this.transactionRunner.run((transactionContext) =>
        this.receiptService.recordImportedVersion(
          {
            organizationId: input.organizationId,
            resourceType: item.resourceType,
            recordUuid: item.recordUuid,
            versionNo: item.versionNo,
            manifestChecksum: input.manifestChecksum,
            sourceInstallationId: input.sourceInstallationId,
          },
          transactionContext,
        ),
      );
      await this.writeItemResult(item.itemId, {
        result: 'SUCCEEDED',
        errorMessage: null,
        receiptId,
      });
      return { result: 'SUCCEEDED' };
    }

    if (outcome.status === 'DUPLICATE') {
      await this.writeItemResult(item.itemId, {
        result: 'SKIPPED',
        errorMessage: '本机已存在同一记录，本次不重复导入',
        receiptId: null,
      });
      return { result: 'SKIPPED' };
    }

    await this.writeItemResult(item.itemId, {
      result: outcome.status === 'CONFLICT' ? 'CONFLICT' : 'FAILED',
      errorMessage: outcome.reason,
      receiptId: null,
    });
    return { result: outcome.status };
  }

  /** 查找同键回执（导入登记与云端回执共用同一张表、同一把键） */
  private async hasImportedOrSyncedVersion(
    item: RecordPackageItemSnapshot,
    organizationId: number,
  ): Promise<boolean> {
    const receipt = await this.recordPackageImportService.findReceipt({
      organizationId,
      resourceType: item.resourceType,
      recordUuid: item.recordUuid,
      versionNo: item.versionNo,
    });
    return receipt !== null;
  }

  /** 写逐条结果（独立短事务，避免长事务持锁） */
  private async writeItemResult(
    itemId: string,
    result: {
      result: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CONFLICT';
      errorMessage: string | null;
      receiptId: string | null;
    },
  ): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.writeItemResult(itemId, result, transactionContext),
    );
  }

  /**
   * 调用期惰性查找受控写入实现。
   *
   * 任务 09 不 import 来源域的写入实现（跨域依赖守卫），因此在**调用期**按中立令牌
   * 查找；未注册＝没有受控写入入口 → 逐条失败关闭。
   */
  private resolveWriter(): RecordPackageItemWriter | null {
    try {
      const resolved = this.moduleRef.get<RecordPackageItemWriter>(RECORD_PACKAGE_ITEM_WRITER, {
        strict: false,
      });
      return resolved ?? null;
    } catch {
      return null;
    }
  }
}
