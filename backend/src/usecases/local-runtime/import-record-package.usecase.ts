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
 * - **结果未知先核对再重试**：重试前复核本机来源事实——同一身份/版本但无可信回执或
 *   内容证明时保守冲突，不补写回执、不重复写业务与原件；删除下架仍失败关闭；
 * - **确认期新鲜检查**：确认时对包重新评估，按资源类型＋稳定编号＋版本及同键出现序号
 *   与初检条目一一对应；新鲜硬失败的条目不执行、不跳过，只更新逐条检查结论；
 * - **去重**：导入前复核同键回执；只有"同一来源包＋本机权威版本可证明同一事实"
 *   才安全跳过，跨包/历史摘要不可判定一律冲突，不按整包摘要推断单条内容相同。
 * - **冻结与占用**：占用前先做只读冻结检查；占用后若遇到正常冻结拒绝，按已完成
 *   条目事实受控收敛批次终态，不留"零写入但 RUNNING"的假在途。
 */

import { RECORD_PACKAGE_ERROR, DomainError, SYNC_ERROR } from '@core/common/errors/domain-error';
import { parseRecordPackageManifest } from '@core/local-runtime/policy/record-package-manifest.policy';
import { ModuleRef } from '@nestjs/core';
import { Inject, Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { RecordPackageImportService } from '@src/modules/lithography/record-package-import.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { RecordPackageOriginalStagingService } from './record-package-original-staging.service';
import {
  SYNC_SOURCE_RESOURCE_TYPES,
  SyncSourceRecordQueryService,
} from '@src/modules/lithography/queries/sync-source-record.query.service';
import type {
  RecordPackageImportSnapshot,
  RecordPackageItemCheckOutcome,
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

type ExistingReceiptDecision = {
  result: 'SKIPPED' | 'CONFLICT' | 'FAILED';
  errorMessage: string;
  receiptId: string | null;
};

type RecordPackageImportManifestItem = {
  content_snapshot: unknown;
  files: { relative_path: string; sha256: string; byte_size: number }[];
  source_account_id?: number | null;
  source_account_uuid?: string | null;
  source_account_login_name?: string | null;
  source_account_name?: string | null;
  owner_organization_id?: number | null;
  source_equipment_model_code?: string | null;
  related_record_uuid?: string | null;
  related_record_type?: string | null;
  source_status?: string | null;
};

@Injectable()
export class ImportRecordPackageUsecase {
  constructor(
    private readonly scopeResolver: LocalRuntimeScopeResolver,
    private readonly recordPackageImportService: RecordPackageImportService,
    private readonly organizationQueryService: OrganizationQueryService,
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
    // 范围复核：查看者有可信公司时，批次必须落在**本公司**数据区；
    // 一级管理员为全局授权范围（`scope.organizationId = null`），不按公司收窄。
    // （修复：一级管理员此前因"批次公司 id ≠ null"被恒定拒绝，检查能过、导入不能过。）
    const outsideScope =
      scope.organizationId !== null && facts !== null
        ? facts.import.organizationId !== scope.organizationId
        : false;
    if (facts === null || outsideScope) {
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
      organizationCode: await this.readOrganizationCode(scope.organizationId),
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

    // 归属复核（写入生命周期，任务 09 审查 P1）：
    // 落检查事实时批次已锁定在"本次包按可信映射确定的目标公司"上，
    // 这里再核一次，确保**写入的数据区**与**批次归属公司**是同一个公司，
    // 不出现"拿 A 公司的批次 + 另一份清单"往别家数据区写的情况。
    if (evaluation.targetOrganizationId !== facts.import.organizationId) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FOREIGN_COMPANY,
        '记录包所属公司与批次归属公司不一致，拒绝导入',
      );
    }

    const manifest = parseRecordPackageManifest(facts.import.manifestJson);
    const writer = this.resolveWriter();

    // 占用前的只读冻结检查：冻结已生效时直接受控拒绝，**绝不先把批次占为 RUNNING**。
    // 写入前仍保留逐条复核，覆盖"占用后才冻结"的窗口。
    await this.localWriteHoldService.assertCompanyWritable({
      organizationId: evaluation.targetOrganizationId,
    });

    // 占用（**绑定本次确认的版本**，任务 09 复验 P1）：
    // 占用事务内以当前读＋行锁重新核对数据库当前事实（编号、归属公司、清单摘要、
    // 预检状态、可占用状态）。核对不通过 ⇒ 受控拒绝，**不进入任何业务写入**。
    // 旧确认若已失效（换包重检已提交 V2），这里直接拒绝，绝不把 V1 的执行记在 V2 批次上。
    const claimed = await this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.claimImportRun({
        packageId: command.packageId,
        importedByAccountId: command.session.accountId,
        organizationId: evaluation.targetOrganizationId,
        manifestChecksum: command.manifestChecksum,
        transactionContext,
      }),
    );

    try {
      // 执行依据＝**锁内刚确认的同一版本**批次与逐条事实（不沿用占用前的旧快照）。
      // 确认期重新评估的逐条结论必须贯穿执行：按完整身份＋同键出现序号一一对应；
      // 新鲜硬失败的条目没有执行，也没有导入失败，只改逐条检查结论。
      const freshOutcomesByKey = this.indexFreshOutcomes(evaluation.outcomes);
      const claimedOrdinals = new Map<string, number>();
      let succeeded = 0;
      let failed = 0;
      let checkRejectedCount = 0;
      let freshRejectedCount = 0;
      for (const item of claimed.items) {
        const fresh = this.takeFreshOutcome(freshOutcomesByKey, claimedOrdinals, item);
        if (item.checkResult !== 'PASSED') {
          checkRejectedCount += 1;
          continue;
        }
        if (fresh === null || !fresh.passed) {
          if (item.result === null) {
            await this.recordPackageImportService.markItemCheckRejected(
              item.itemId,
              fresh?.message ?? '确认时逐条检查缺少对应结论，未执行',
            );
          }
          freshRejectedCount += 1;
          continue;
        }
        // 中断重试：已成功或已判定跳过的条目不重做（幂等）
        if (item.result === 'SUCCEEDED' || item.result === 'SKIPPED') {
          succeeded += 1;
          continue;
        }
        // 清单回查必须用完整身份：(资源类型, 稳定编号, 版本)。
        // 仅按 UUID 会在混合包里取到同 UUID 的另一资源/版本条目，导致正文、来源与原件错配。
        const manifestItem = manifest.items.find(
          (candidate) =>
            candidate.resource_type === item.resourceType &&
            candidate.record_uuid === item.recordUuid &&
            candidate.version_no === item.versionNo,
        );
        if (manifestItem === undefined) {
          await this.writeItemResult(item.itemId, {
            result: 'FAILED',
            errorMessage: '清单条目与逐条事实无法按资源类型、稳定编号和版本精确匹配，拒绝导入',
            receiptId: null,
          });
          failed += 1;
          continue;
        }
        const outcome = await this.importOne({
          item,
          manifestItem,
          organizationId: claimed.import.organizationId,
          manifestChecksum: claimed.import.manifestChecksum,
          packagePath: command.packagePath,
          sourceInstallationId: manifest.installation_id,
          sourceOrganizationCode: manifest.organization_code ?? null,
          session: command.session,
          writer,
        });
        if (outcome.result === 'SUCCEEDED' || outcome.result === 'SKIPPED') {
          succeeded += 1;
        } else {
          failed += 1;
        }
      }

      // 没有任何可执行条目时不能报成功：计数 0/0 表示"什么也没做"，如实记 FAILED。
      // 检查阶段或确认期被硬阻断的条目也没有执行：即使合格范围全部成功，批次仍是 PARTIAL，
      // 不把"部分范围完成"冒充整包 SUCCEEDED，也不把检查失败计入导入失败。
      checkRejectedCount += freshRejectedCount;
      const status = this.resolveBatchStatus(succeeded, failed, checkRejectedCount);
      // 终态只落在**本次占用的那个摘要**上（条件更新命中 0 行 ⇒ 受控拒绝，不静默吞掉）。
      await this.transactionRunner.run((transactionContext) =>
        this.recordPackageImportService.finalizeImport(
          command.packageId,
          { status, succeeded, failed },
          claimed.import.manifestChecksum,
          transactionContext,
        ),
      );

      const updated = await this.recordPackageImportService.readImportFacts(command.packageId);
      return {
        outcome: 'imported',
        import: updated?.import ?? claimed.import,
        items: updated?.items ?? claimed.items,
      };
    } catch (error) {
      if (!this.isWriteHeldError(error)) {
        throw error;
      }
      // 占用后才发生的冻结：按已完成事实收敛本次占用，避免"零写入却 RUNNING"。
      // 原始 WRITE_HELD 仍抛给调用方；收敛自身失败时两个原因都保留，不吞错。
      try {
        await this.settleFrozenRun(command.packageId, claimed.import);
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          '恢复期冻结且批次收敛失败，保留冻结与收敛两个原因，不自动重试',
          { cause: settlementError },
        );
      }
      throw error;
    }
  }

  /** 正常恢复冻结拒绝（不是进程中断/写入结果未知），可以受控收敛本次占用。 */
  private isWriteHeldError(error: unknown): boolean {
    return error instanceof DomainError && error.code === SYNC_ERROR.WRITE_HELD;
  }

  /** 批次终态口径：未执行条目不冒充成功，也不计入导入失败。 */
  private resolveBatchStatus(
    succeeded: number,
    failed: number,
    checkRejectedCount: number,
  ): 'SUCCEEDED' | 'PARTIAL' | 'FAILED' {
    if (succeeded === 0 && failed === 0) {
      return 'FAILED';
    }
    if (failed > 0 && succeeded > 0) {
      return 'PARTIAL';
    }
    if (failed > 0) {
      return 'FAILED';
    }
    return checkRejectedCount > 0 ? 'PARTIAL' : 'SUCCEEDED';
  }

  /**
   * 占用后遇到冻结的受控收敛：由真实批次服务在**同一事务/行锁内**重读 RUNNING 状态、
   * 归属公司、清单摘要与最新逐条事实后条件更新，不盲目把 RUNNING 重置为 PENDING。
   *
   * 不把账号/摘要/超时当作本次执行的 fencing：批次一旦被换包重检、终态化或重置，
   * 条件更新即受控拒绝，不把旧版本执行写到新版本批次上。
   */
  private async settleFrozenRun(
    packageId: string,
    claimed: RecordPackageImportSnapshot,
  ): Promise<void> {
    await this.transactionRunner.run((transactionContext) =>
      this.recordPackageImportService.finalizeFrozenImport({
        packageId,
        organizationId: claimed.organizationId,
        manifestChecksum: claimed.manifestChecksum,
        transactionContext,
      }),
    );
  }

  /** 查看者公司的稳定业务编码（跨安装对齐公司身份；读取失败即 null） */
  private async readOrganizationCode(organizationId: number | null): Promise<string | null> {
    if (organizationId === null) {
      return null;
    }
    const identity = await this.organizationQueryService.findOrganizationIdentityById({
      organizationId,
    });
    return identity?.organizationCode ?? null;
  }

  /** 逐条事实的完整身份键：资源类型＋稳定编号＋版本，不用 UUID 单键。 */
  private itemIdentityKey(item: {
    resourceType: string;
    recordUuid: string;
    versionNo: number;
  }): string {
    return `${item.resourceType}\u0000${item.recordUuid}\u0000${item.versionNo}`;
  }

  /** 确认期结果按同键出现顺序分组，供包内重复条目一一对应。 */
  private indexFreshOutcomes(
    outcomes: readonly RecordPackageItemCheckOutcome[],
  ): Map<string, RecordPackageItemCheckOutcome[]> {
    const grouped = new Map<string, RecordPackageItemCheckOutcome[]>();
    for (const outcome of outcomes) {
      const key = this.itemIdentityKey(outcome);
      const list = grouped.get(key) ?? [];
      list.push(outcome);
      grouped.set(key, list);
    }
    return grouped;
  }

  /** 取出该条目在确认期评估中对应的唯一结果；缺失即返回 null（失败关闭）。 */
  private takeFreshOutcome(
    grouped: Map<string, RecordPackageItemCheckOutcome[]>,
    ordinals: Map<string, number>,
    item: RecordPackageItemSnapshot,
  ): RecordPackageItemCheckOutcome | null {
    const key = this.itemIdentityKey(item);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    return grouped.get(key)?.[ordinal] ?? null;
  }

  /** 逐条导入：复核去重事实 → 受控写入 → 落逐条结果 */
  private async importOne(input: {
    item: RecordPackageItemSnapshot;
    manifestItem: RecordPackageImportManifestItem | undefined;
    packagePath: string;
    organizationId: number;
    manifestChecksum: string;
    sourceInstallationId: string;
    /** 清单携带的来源公司稳定业务编码（跨安装对齐公司；旧包为 null） */
    sourceOrganizationCode: string | null;
    session: UsecaseSession;
    writer: RecordPackageItemWriter | null;
  }): Promise<{ result: string }> {
    const { item } = input;

    // 1. 与同步共用去重键，但**不把整包摘要当单条内容摘要**；裁决细节见
    //    `resolveExistingReceiptDecision`：同一来源包＋本机权威版本＋当前权限三证齐全
    //    才安全跳过，其余冲突/失败关闭，不覆盖既有事实。
    const existing = await this.findExistingVersion(item, input.organizationId);
    if (existing !== null) {
      const decision = await this.resolveExistingReceiptDecision({
        item,
        existing,
        organizationId: input.organizationId,
        manifestChecksum: input.manifestChecksum,
        sourceInstallationId: input.sourceInstallationId,
        manifestItem: input.manifestItem,
        sourceOrganizationCode: input.sourceOrganizationCode,
        session: input.session,
        writer: input.writer,
      });
      await this.writeItemResult(item.itemId, decision);
      return { result: decision.result };
    }

    // 1a. 本机来源事实复核（不复活已删除下架内容／不覆盖更高版本／同版本无回执不冒充同内容）
    const localDecision = await this.reconcileLocalFact({
      item,
      organizationId: input.organizationId,
    });
    if (localDecision.kind !== 'PROCEED') {
      await this.writeItemResult(item.itemId, {
        result: localDecision.kind,
        errorMessage: localDecision.reason,
        receiptId: null,
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
          portableSourceIdentity: {
            sourceAccountUuid: input.manifestItem?.source_account_uuid ?? null,
            sourceAccountLoginName: input.manifestItem?.source_account_login_name ?? null,
            sourceAccountName: input.manifestItem?.source_account_name ?? null,
            sourceOrganizationCode: input.sourceOrganizationCode,
          },
          ownerOrganizationId,
          relatedRecordUuid: input.manifestItem?.related_record_uuid ?? null,
          relatedRecordType: input.manifestItem?.related_record_type ?? null,
          sourceEquipmentModelCode: input.manifestItem?.source_equipment_model_code ?? null,
          sourceStatus: input.manifestItem?.source_status ?? null,
        },
        input.session,
      );
    } catch (error) {
      // 写入抛错：先精确补偿本条暂存原件，再如实登记失败原因。
      // 业务事务已由写入方回滚，暂存行若不释放就会变成永远不会被绑定的孤儿行。
      const compensationError = await this.releaseStagedOriginals(stagedOriginals);
      if (this.isWriteHeldError(error)) {
        // 冻结不是业务失败：保留逐条 NULL（未执行），不得写 FAILED 冒充已裁决结果。
        // 只有补偿成功、可证明没有未知残留时，才把冻结交给批次级受控收敛。
        // 补偿失败时同时保留两个错误，外层不识别为“零副作用冻结”，不自动重试。
        if (compensationError !== null) {
          throw new AggregateError(
            [error, compensationError],
            '恢复期冻结且本条暂存原件补偿失败，批次保持受控状态，不允许自动重试',
            { cause: error },
          );
        }
        throw error;
      }
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
   * 普通失败路径只记日志，不掩盖主失败；冻结路径需要知道补偿是否成功，
   * 因此把补偿异常返回给调用方（行仍是 TEMPORARY，由过期暂存清理任务兜底回收）。
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
  ): Promise<unknown> {
    if (staged.length === 0) {
      return null;
    }
    try {
      await this.originalStagingService.release(staged);
      return null;
    } catch (error) {
      // 补偿失败不改变普通失败的业务结论；残留行由过期暂存清理任务兜底。
      return error;
    }
  }

  /** 查找同键回执（导入登记与云端回执共用同一张表、同一把键） */
  private async findExistingVersion(
    item: RecordPackageItemSnapshot,
    organizationId: number,
  ): Promise<{
    receiptId: string;
    manifestChecksum: string | null;
    sourceInstallationId: string | null;
  } | null> {
    return this.recordPackageImportService.findReceipt({
      organizationId,
      resourceType: item.resourceType,
      recordUuid: item.recordUuid,
      versionNo: item.versionNo,
    });
  }

  /** 本机删除下架／更高版本的硬阻断优先于任何同包证明。 */
  private rejectForLocalFact(
    localFact: {
      withdrawn: boolean;
      currentVersion: number | null;
      identityPersisted: boolean;
    } | null,
    versionNo: number,
  ): ExistingReceiptDecision | null {
    if (localFact?.withdrawn === true) {
      return {
        result: 'FAILED',
        errorMessage: '本机同编号记录已删除或下架，不导入（导入不得复活已删除下架内容）',
        receiptId: null,
      };
    }
    if (
      localFact !== null &&
      localFact.currentVersion !== null &&
      localFact.currentVersion > versionNo
    ) {
      return {
        result: 'CONFLICT',
        errorMessage: `本机同编号记录已有更高版本（v${localFact.currentVersion}），不覆盖`,
        receiptId: null,
      };
    }
    return null;
  }

  /**
   * 同键回执裁决（F2）：整包摘要只证明"同一份包"，不是单条内容摘要。
   *
   * 可证相同 = 同一来源安装 + 同一包摘要 + 本机持久化身份同版本 + 未下架；
   * 即使如此仍复核当前权限。其余情况保守冲突或失败关闭，不覆盖既有事实。
   */
  private async resolveExistingReceiptDecision(input: {
    item: RecordPackageItemSnapshot;
    existing: {
      receiptId: string;
      manifestChecksum: string | null;
      sourceInstallationId: string | null;
    };
    organizationId: number;
    manifestChecksum: string;
    sourceInstallationId: string;
    manifestItem: RecordPackageImportManifestItem | undefined;
    sourceOrganizationCode: string | null;
    session: UsecaseSession;
    writer: RecordPackageItemWriter | null;
  }): Promise<ExistingReceiptDecision> {
    const localFact = await this.readLocalSourceFact(input.item, input.organizationId);
    const blocked = this.rejectForLocalFact(localFact, input.item.versionNo);
    if (blocked !== null) {
      return blocked;
    }

    const sameAuthoritativeVersion =
      localFact !== null &&
      localFact.identityPersisted &&
      localFact.currentVersion === input.item.versionNo;
    const samePackageProof =
      input.existing.manifestChecksum !== null &&
      input.existing.sourceInstallationId !== null &&
      input.existing.manifestChecksum === input.manifestChecksum &&
      input.existing.sourceInstallationId === input.sourceInstallationId;

    if (!samePackageProof) {
      return {
        result: 'CONFLICT',
        errorMessage:
          input.existing.manifestChecksum === null
            ? '旧回执摘要不可判定，需人工裁决（不按同键跳过，也不覆盖既有事实）'
            : '同键回执来自不同来源包或历史摘要不可判定；整包摘要不能证明单条内容相同，需人工裁决（不覆盖）',
        receiptId: null,
      };
    }
    if (!sameAuthoritativeVersion) {
      return {
        result: 'CONFLICT',
        errorMessage:
          '同键回执与当前包一致，但本机权威版本或稳定身份不可核验，需人工裁决（不覆盖）',
        receiptId: null,
      };
    }

    const precondition = await this.resolveWritePrecondition({
      item: input.item,
      manifestItem: input.manifestItem,
      organizationId: input.organizationId,
      sourceOrganizationCode: input.sourceOrganizationCode,
      session: input.session,
      writer: input.writer,
    });
    if (precondition.kind === 'FAILED') {
      return { result: 'FAILED', errorMessage: precondition.reason, receiptId: null };
    }
    return {
      result: 'SKIPPED',
      errorMessage: '同一来源包同键回执＋本机权威版本可证同一事实，当前权限已复核，本次不重复导入',
      receiptId: input.existing.receiptId,
    };
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
          source_account_uuid?: string | null;
          source_account_login_name?: string | null;
          source_account_name?: string | null;
          owner_organization_id?: number | null;
          source_equipment_model_code?: string | null;
        }
      | undefined;
    organizationId: number;
    /** 清单携带的来源公司稳定业务编码（跨安装对齐公司；旧包为 null） */
    sourceOrganizationCode: string | null;
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
    // 公司归属核对由**来源域核验器**按公司业务编码完成（跨设备时源机公司 id 无意义），
    // 编排侧不再按数字 id 比较（那会把"同公司不同 id"误判为错公司）。
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
      portableSourceIdentity: {
        sourceAccountUuid: input.manifestItem?.source_account_uuid ?? null,
        sourceAccountLoginName: input.manifestItem?.source_account_login_name ?? null,
        sourceAccountName: input.manifestItem?.source_account_name ?? null,
        sourceOrganizationCode: input.sourceOrganizationCode,
      },
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
   * - 已删除／下架 → 失败关闭（导入不得复活已删除下架内容）；
   * - 本机已有更高版本 → 冲突（不覆盖更高版本）；
   * - 无回执但本机同持久化身份同版本 → **受控冲突**：同一稳定身份与版本不能证明
   *   当前包的正文/原件与本机记录相同，也不能凭此补写来源回执；交人工裁决。
   * - 本机无记录或身份不可核验且版本更低/不可判定 → 正常受控新增。
   */
  private async reconcileLocalFact(input: {
    item: RecordPackageItemSnapshot;
    organizationId: number;
  }): Promise<
    { kind: 'PROCEED' } | { kind: 'FAILED'; reason: string } | { kind: 'CONFLICT'; reason: string }
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
      return {
        kind: 'CONFLICT',
        reason:
          '本机已有同稳定身份同版本记录，但无同键回执可证明当前包正文与原件相同；不补写回执、不覆盖业务，需人工裁决',
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
