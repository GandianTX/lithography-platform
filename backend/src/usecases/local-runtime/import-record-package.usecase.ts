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
 * - **来源身份可信**：包内自报的来源账号只是"待核验的账号 id"，导入前向来源域
 *   请求一次受控核验（账号存在且启用、资料启用、目标公司在职、导入者对它有
 *   当前权限）；核验不通过即逐条拒绝，**不静默改归属、不冒用导入人**；
 * - **跨资源失败补偿**：暂存成功但绑定／业务写失败时，按 fileId **精确释放**本条
 *   暂存原件（标记 FAILED、行保留可追踪、不删字节），不留永远不会被绑定的孤儿行，
 *   也不动已绑定原件与他人／他公司的对象；
 * - **结果未知先核对再重试**：重试前复核本机来源事实——同一持久化身份且同一版本已存在
 *   ⇒ 上次写入其实已生效，判同一事实跳过并补记回执，不重复写、不重复绑定；
 * - **去重**：导入前复核同键回执（与同步共用去重口径），已存在同版本即跳过。
 */

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import { parseRecordPackageManifest } from '@core/local-runtime/policy/record-package-manifest.policy';
import { ModuleRef } from '@nestjs/core';
import { Inject, Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import { RecordPackageOriginalStagingService } from './record-package-original-staging.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
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

import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';

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
    private readonly originalStagingService: RecordPackageOriginalStagingService,
    private readonly sourceRecordQueryService: SyncSourceRecordQueryService,
    private readonly localWriteHoldService: LocalWriteHoldService,
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
        packagePath: command.packagePath,
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
          files: { relative_path: string; sha256: string; byte_size: number }[];
          source_account_id?: number | null;
          owner_organization_id?: number | null;
          source_status?: string | null;
        }
      | undefined;
    packagePath: string;
    organizationId: number;
    manifestChecksum: string;
    sourceInstallationId: string;
    session: UsecaseSession;
    writer: RecordPackageItemWriter | null;
  }): Promise<{ result: string }> {
    const { item } = input;

    // 1. 与同步共用去重：同键回执已存在即按"同一事实"跳过；**摘要不同**判冲突
    const existing = await this.findExistingVersion(item, input.organizationId);
    if (existing !== null) {
      const sameContent =
        existing.manifestChecksum === null || existing.manifestChecksum === input.manifestChecksum;
      await this.writeItemResult(item.itemId, {
        result: sameContent ? 'SKIPPED' : 'CONFLICT',
        errorMessage: sameContent
          ? '本机已存在同一记录版本（与同步去重口径一致），本次不重复导入'
          : '同键记录版本已存在但内容摘要不同，需人工裁决（不覆盖既有事实）',
        receiptId: null,
      });
      return { result: sameContent ? 'SKIPPED' : 'CONFLICT' };
    }

    // 1a. 本机来源事实复核（不复活已删除下架内容／不覆盖更高版本／结果未知先核对再重试）
    const localDecision = await this.reconcileLocalFact(input);
    if (localDecision.kind !== 'PROCEED') {
      await this.writeItemResult(item.itemId, {
        result: localDecision.kind,
        errorMessage: localDecision.reason,
        receiptId: localDecision.kind === 'SKIPPED' ? localDecision.receiptId : null,
      });
      return { result: localDecision.kind };
    }

    // 1a0. 写入冻结闸门（任务 09 S5-2）：恢复期冻结的目标公司**不接受导入**
    await this.localWriteHoldService.assertCompanyWritable({
      organizationId: input.organizationId,
    });

    // 1b-2a. 写入前准入：归属公司一致 ＋ 有受控写入入口 ＋ 来源身份本机可信核验
    const precondition = await this.resolveWritePrecondition(input);
    if (precondition.kind === 'FAILED') {
      await this.writeItemResult(item.itemId, {
        result: 'FAILED',
        errorMessage: precondition.reason,
        receiptId: null,
      });
      return { result: 'FAILED' };
    }
    const ownerOrganizationId = precondition.ownerOrganizationId;
    const identity = precondition.identity;
    const writer = precondition.writer;

    // 3. 原件暂存（服务端读包、复核字节与摘要、登记 11 临时文件）
    let stagedOriginals: {
      fileId: string;
      uploadContextId: string;
      originalFilename: string;
      mimeType: string;
      byteSize: number;
      checksumSha256: string;
    }[] = [];
    const packageFiles = input.manifestItem?.files ?? [];
    if (packageFiles.length > 0) {
      try {
        stagedOriginals = await this.originalStagingService.stage({
          packagePath: input.packagePath,
          files: packageFiles,
          businessType: 'MAINTENANCE_REPORT',
          uploadedByAccountId: identity.sourceAccountId,
          ownerOrganizationId: input.organizationId,
        });
      } catch (error) {
        await this.writeItemResult(item.itemId, {
          result: 'FAILED',
          errorMessage:
            error instanceof Error ? `包内原件暂存失败：${error.message}` : '包内原件暂存失败',
          receiptId: null,
        });
        return { result: 'FAILED' };
      }
    }

    // 4. 受控写入
    const snapshot = input.manifestItem?.content_snapshot;
    const body =
      typeof snapshot === 'object' && snapshot !== null
        ? (snapshot as Record<string, unknown>)
        : {};
    let outcome: Awaited<ReturnType<RecordPackageItemWriter['write']>>;
    try {
      outcome = await writer.write(
        {
          resourceType: item.resourceType as RecordPackageImportResourceType,
          recordUuid: item.recordUuid,
          versionNo: item.versionNo,
          organizationId: input.organizationId,
          body,
          originals: stagedOriginals,
          manifestChecksum: input.manifestChecksum,
          sourceAccountId: identity.sourceAccountId,
          ownerOrganizationId,
          sourceStatus: input.manifestItem?.source_status ?? null,
        },
        input.session,
      );
    } catch (error) {
      // 写入抛错（未预期）：先精确补偿本条暂存原件，再如实登记失败原因。
      // 业务事务已由写入方回滚，暂存行若不释放就会变成永远不会被绑定的孤儿行。
      await this.releaseStagedOriginals(stagedOriginals);
      await this.writeItemResult(item.itemId, {
        result: 'FAILED',
        errorMessage:
          error instanceof Error ? `受控写入异常：${error.message}` : '受控写入异常，该条未导入',
        receiptId: null,
      });
      return { result: 'FAILED' };
    }

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
      await this.releaseStagedOriginals(stagedOriginals);
      await this.writeItemResult(item.itemId, {
        result: 'SKIPPED',
        errorMessage: '本机已存在同一记录，本次不重复导入',
        receiptId: null,
      });
      return { result: 'SKIPPED' };
    }

    // 写入未成功（FAILED／CONFLICT）：精确释放本条暂存原件，
    // 避免留下永远不会被绑定的孤儿行；行保留可追踪，不动字节与他人对象。
    await this.releaseStagedOriginals(stagedOriginals);
    await this.writeItemResult(item.itemId, {
      result: outcome.status === 'CONFLICT' ? 'CONFLICT' : 'FAILED',
      errorMessage: outcome.reason,
      receiptId: null,
    });
    return { result: outcome.status };
  }

  /**
   * 精确补偿：释放本条导入尝试自己登记、且尚未被绑定的暂存原件。
   *
   * 补偿失败**不掩盖**业务失败：主失败原因照常登记，补偿异常只记日志
   * （行仍是 TEMPORARY，由过期暂存清理任务兜底回收）。
   */
  private async releaseStagedOriginals(
    staged: readonly {
      fileId: string;
      uploadContextId: string;
      originalFilename: string;
      mimeType: string;
      byteSize: number;
      checksumSha256: string;
    }[],
  ): Promise<void> {
    if (staged.length === 0) {
      return;
    }
    try {
      await this.originalStagingService.release(staged);
    } catch {
      // 补偿失败不改变本条的业务结论；残留行由过期暂存清理任务兜底。
    }
  }

  /** 查找同键回执（导入登记与云端回执共用同一张表、同一把键） */
  private async findExistingVersion(
    item: RecordPackageItemSnapshot,
    organizationId: number,
  ): Promise<{ receiptId: string; manifestChecksum: string | null } | null> {
    return this.recordPackageImportService.findReceipt({
      organizationId,
      resourceType: item.resourceType,
      recordUuid: item.recordUuid,
      versionNo: item.versionNo,
    });
  }

  /**
   * 写入前准入裁决：
   * - **归属公司**：包内登记的归属公司必须与目标公司一致（数据为准）；
   * - **受控写入入口**：没有入口／不支持该资源类型 = 该条失败关闭；
   * - **来源身份本机可信核验**（S3 补丁 P4）：包内自报的来源账号只是「待核验的账号 id」，
   *   授权真源是本机数据库当前事实（账号存在且启用、资料启用、目标公司在职、
   *   导入者对它有当前权限）。裁决权在来源域（端口 `verifySourceIdentity`），
   *   编排侧不另立第二套判定。
   *   **必须在暂存原件之前**：原件暂存的「上传者」必须等于来源账号，
   *   账号不可信时暂存本身就不该发生（否则留下指向不可信账号的孤儿暂存行）。
   */
  private async resolveWritePrecondition(input: {
    item: RecordPackageItemSnapshot;
    manifestItem:
      | {
          source_account_id?: number | null;
          owner_organization_id?: number | null;
        }
      | undefined;
    organizationId: number;
    session: UsecaseSession;
    writer: RecordPackageItemWriter | null;
  }): Promise<
    | {
        kind: 'PROCEED';
        ownerOrganizationId: number | null;
        identity: { allowed: true; sourceAccountId: number };
        /** 已确认存在且支持该资源类型的受控写入入口 */
        writer: RecordPackageItemWriter;
      }
    | { kind: 'FAILED'; reason: string }
  > {
    const { item } = input;
    const ownerOrganizationId = input.manifestItem?.owner_organization_id ?? null;
    if (ownerOrganizationId !== null && ownerOrganizationId !== input.organizationId) {
      return { kind: 'FAILED', reason: '包内归属公司与目标公司不一致，该条未导入' };
    }
    if (input.writer === null) {
      return { kind: 'FAILED', reason: '没有可用的受控写入入口，该条未导入' };
    }
    if (!input.writer.supportedResourceTypes.includes(item.resourceType as never)) {
      return {
        kind: 'FAILED',
        reason: `${item.resourceType} 在来源业务域没有受控写入入口，该条未导入`,
      };
    }
    const identity = await input.writer.verifySourceIdentity({
      sourceAccountId: input.manifestItem?.source_account_id ?? null,
      ownerOrganizationId,
      targetOrganizationId: input.organizationId,
      importerAccountId: input.session.accountId,
    });
    if (!identity.allowed) {
      return { kind: 'FAILED', reason: identity.reason };
    }
    return { kind: 'PROCEED', ownerOrganizationId, identity, writer: input.writer };
  }

  /**
   * 本机来源事实复核（导入前）：
   * - 已删除／下架 → 拒绝（导入不得复活已删除下架内容）；
   * - 本机已有更高版本 → 冲突（不覆盖更高版本）；
   * - 本机已有**同一持久化身份且同一版本** → 判"同一事实"跳过
   *   （结果未知时的先核对再重试：上一次尝试其实已经写成功，
   *   不重复写、不重复绑定；并补记回执让后续重试直接命中回执去重）。
   */
  private async reconcileLocalFact(input: {
    item: RecordPackageItemSnapshot;
    organizationId: number;
    manifestChecksum: string;
    sourceInstallationId: string;
  }): Promise<
    | { kind: 'PROCEED' }
    | { kind: 'FAILED'; reason: string }
    | { kind: 'CONFLICT'; reason: string }
    | { kind: 'SKIPPED'; reason: string; receiptId: string }
  > {
    const { item } = input;
    const localFact = await this.readLocalSourceFact(item, input.organizationId);
    if (localFact === null) {
      return { kind: 'PROCEED' };
    }
    if (localFact.withdrawn) {
      return {
        kind: 'FAILED',
        reason: '本机同编号记录已删除或下架，不导入（导入不得复活已删除下架内容）',
      };
    }
    if (localFact.currentVersion !== null && localFact.currentVersion > item.versionNo) {
      return {
        kind: 'CONFLICT',
        reason: `本机同编号记录已有更高版本（v${localFact.currentVersion}），不覆盖`,
      };
    }
    if (
      localFact.identityPersisted &&
      localFact.currentVersion !== null &&
      localFact.currentVersion === item.versionNo
    ) {
      // 同一（公司, 资源类型, 记录 UUID, 版本）键在本机已存在，且该 UUID 是**持久化的
      // 跨端稳定身份**（不是按本机自增 id 派生的历史回退值）⇒ 上次写入已生效。
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
      return {
        kind: 'SKIPPED',
        reason: '本机已存在同一记录同一版本（重试前先核对，本次不重复导入，也不重复绑定原件）',
        receiptId,
      };
    }
    return { kind: 'PROCEED' };
  }

  /**
   * 读取本机同编号记录的来源事实（用于"不复活已删除下架内容"、"不覆盖更高版本"
   * 与"结果未知时先核对再重试"）。
   *
   * 查不到（本机尚无该编号的记录）＝正常新增，按 null 处理。
   */
  private async readLocalSourceFact(
    item: RecordPackageItemSnapshot,
    organizationId: number,
  ): Promise<{
    withdrawn: boolean;
    currentVersion: number | null;
    /** 记录 UUID 是否为**持久化的跨端稳定身份**（false＝按本机自增 id 派生的历史回退值） */
    identityPersisted: boolean;
  } | null> {
    const resourceType = SYNC_SOURCE_RESOURCE_TYPES.find(
      (candidate) => candidate === item.resourceType,
    );
    if (resourceType === undefined) {
      return null;
    }
    const facts = await this.sourceRecordQueryService.listFacts({
      organizationId,
      resourceType,
      recordUuids: [item.recordUuid],
    });
    const fact = facts.facts.get(item.recordUuid);
    if (fact === undefined) {
      return null;
    }
    return {
      withdrawn: fact.withdrawn === true,
      currentVersion: fact.currentVersion,
      identityPersisted: fact.identityPersisted === true,
    };
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
