// src/modules/lithography/record-package-import.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';
import {
  assertManifestSnapshotHasNoSecretMaterial,
  assertPackageCompanyAllowedByIdentity,
  parseRecordPackageManifest,
  recordPackageManifestChecksum,
  resolvePackageFilePath,
  type RecordPackageItemRejection,
  type RecordPackageManifest,
} from '@core/local-runtime/policy/record-package-manifest.policy';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as nodePath from 'node:path';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { IsNull, Repository } from 'typeorm';
import { OrganizationQueryService } from './queries/organization.query.service';
import { RecordPackageImportEntity } from './entities/record-package-import.entity';
import { RecordPackageItemEntity } from './entities/record-package-item.entity';
import { SyncReceiptEntity } from './entities/sync-receipt.entity';
import {
  type RecordPackageCheckCommand,
  type RecordPackageCheckResult,
  type RecordPackageImportSnapshot,
  type RecordPackageItemCheckOutcome,
  type RecordPackageItemSnapshot,
} from './record-package-import.types';
import {
  toRecordPackageImportSnapshot,
  toRecordPackageItemSnapshot,
} from './queries/record-package-import.query.service';
import { sha256FileDigest } from '@core/common/digest/file-digest';

export type RecordPackageEvaluation = {
  manifest: RecordPackageManifest;
  manifestRaw: string;
  manifestChecksum: string;
  /**
   * 本机的**目标公司数据区 id**（落库到 `record_package_import.organization_id`）。
   *
   * 跨设备时清单里的 `organization_id` 是**源机**的自增主键，不能直接落库；
   * 本机落库的必须是"本机对同一公司的 id"，否则导入批次会挂到不存在的公司上。
   */
  targetOrganizationId: number;
  outcomes: RecordPackageItemCheckOutcome[];
};

/**
 * 记录包检查执行层（任务 09 R071，S2.3）。
 *
 * 分两段以缩短事务：
 * 1) `evaluatePackage`：读包目录、结构校验、逐文件流式 SHA-256、重复判定——
 *    无 DB 写入，放在事务外，避免长事务持锁；
 * 2) `persistCheckOutcome`：事务内复查既有批次 → 插入 import＋item 检查事实。
 *
 * 检查**不写正式业务**：status 保持 PENDING，item.result 保持 NULL。
 * 硬阻断：清单非法、路径逃逸、缺文件、字节/SHA-256 不符、错公司、包内重复。
 * 已存在同键回执不是硬阻断：逐条保留"重复"提示并列入可确认范围，
 * 导入时再按本机权威事实裁决跳过或冲突（R071 检查重复冲突、R072 不默认覆盖）。
 * 同包重复检查返回既有批次（主键即 package_id，天然一个事实）。
 * 换包（同一 package_id 下清单校验值变化）时旧预检失效：按新内容重新落检查事实，
 * 不保留旧逐条结论，避免"旧预检结论被套用到新包内容上"。
 *
 * **归属边界（任务 09 审查 P1）**：`record_package_import.package_id` 是**全局主键**
 * （公司维度不进主键/唯一键）⇒ 同一个编号在库里只能有一行、只属于一个公司。
 * 因此落检查事实时必须先核对"本次可信目标公司"与"既有批次归属公司"一致：
 * - 一致 ⇒ 保留既有语义（同摘要幂等；不同摘要合法换包重检）；
 * - 不一致 ⇒ **受控拒绝**（不改写归属、不删除对方逐条事实、不返回对方任何明细）；
 * - 批次正在导入（RUNNING）时不得换包重检（不覆盖正在执行的事实）。
 * 并发插入同一编号时，用**当前读 + 行锁**回读赢家后按同一口径处理，
 * 不依赖 MySQL 默认隔离级别下的旧一致性快照。
 */
@Injectable()
export class RecordPackageImportService {
  constructor(
    @InjectRepository(RecordPackageImportEntity)
    private readonly importRepository: Repository<RecordPackageImportEntity>,
    @InjectRepository(RecordPackageItemEntity)
    private readonly itemRepository: Repository<RecordPackageItemEntity>,
    @InjectRepository(SyncReceiptEntity)
    private readonly receiptRepository: Repository<SyncReceiptEntity>,
    private readonly organizationQueryService: OrganizationQueryService,
  ) {}

  private pickImportRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageImportEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageImportEntity)
      : this.importRepository;
  }

  private pickItemRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<RecordPackageItemEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(RecordPackageItemEntity)
      : this.itemRepository;
  }

  private pickReceiptRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<SyncReceiptEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(SyncReceiptEntity)
      : this.receiptRepository;
  }

  private readManifestRaw(packagePath: string): { manifestPath: string; raw: string } {
    if (packagePath === '' || !nodePath.isAbsolute(packagePath) || !existsSync(packagePath)) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包目录不存在');
    }
    const manifestPath = nodePath.join(packagePath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包缺少 manifest.json');
    }
    return { manifestPath, raw: readFileSync(manifestPath, 'utf8') };
  }

  private async hasDuplicateReceipt(
    organizationId: number,
    resourceType: string,
    recordUuid: string,
    versionNo: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<boolean> {
    const found = await this.pickReceiptRepository(transactionContext).findOne({
      where: { organizationId, resourceType, recordUuid, versionNo },
      select: { receiptId: true },
    });
    return found !== null;
  }

  private async checkItemFiles(
    packagePath: string,
    files: { relative_path: string; sha256: string; byte_size: number }[],
  ): Promise<{ rejection: RecordPackageItemRejection | null; message: string | null }> {
    for (const file of files) {
      let absolutePath: string;
      try {
        absolutePath = resolvePackageFilePath(packagePath, file.relative_path);
      } catch {
        return { rejection: 'PATH_ESCAPED', message: `文件路径逃逸：${file.relative_path}` };
      }
      if (!existsSync(absolutePath)) {
        return { rejection: 'FILE_MISSING', message: `缺少原件文件：${file.relative_path}` };
      }
      const size = statSync(absolutePath).size;
      if (size !== file.byte_size) {
        return {
          rejection: 'FILE_CHECKSUM_MISMATCH',
          message: `字节数不符：${file.relative_path}（清单 ${file.byte_size}，实际 ${size}）`,
        };
      }
      const digest = await sha256FileDigest(absolutePath);
      if (digest !== file.sha256.toLowerCase()) {
        return {
          rejection: 'FILE_CHECKSUM_MISMATCH',
          message: `SHA-256 不符：${file.relative_path}`,
        };
      }
    }
    return { rejection: null, message: null };
  }

  /** 第一段：包目录评估（无 DB 写入）。清单级问题直接抛错，条目级问题逐条记录。 */
  async evaluatePackage(command: RecordPackageCheckCommand): Promise<RecordPackageEvaluation> {
    const { raw } = this.readManifestRaw(command.packagePath);
    const manifest = parseRecordPackageManifest(raw);

    // 错公司先拒绝：不进入数据库，也不给其他公司包留任何处理事实
    // （跨安装口径：清单携带公司业务编码时按编码对齐，不再比较源机自增 id）
    assertPackageCompanyAllowedByIdentity({
      viewerOrganizationId: command.organizationId,
      viewerOrganizationCode: command.organizationCode,
      manifestOrganizationId: manifest.organization_id,
      manifestOrganizationCode: manifest.organization_code ?? null,
    });

    // 本机目标公司数据区 id（落库口径）：查看者有可信公司时即取该公司；
    // 一级管理员（全局范围）按清单携带的公司编码在本机定位，定位不到即失败关闭。
    const targetOrganizationId = await this.resolveTargetOrganizationId(command, manifest);

    const manifestChecksum = recordPackageManifestChecksum(raw);

    // 清单级结构错误：(package_id, record_uuid, resource_type, version_no) 在
    // `record_package_item` 上是唯一键，不能落两条同键逐条事实。在任何逐条检查、
    // 回执读取或落库之前先整包受控拒绝，不能靠数据库重复键异常兜底。
    const seenKeys = new Set<string>();
    for (const item of manifest.items) {
      const key = `${item.resource_type}:${item.record_uuid}:${item.version_no}`;
      if (seenKeys.has(key)) {
        throw new DomainError(
          RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
          `包清单包含重复条目（资源类型=${item.resource_type}，稳定编号=${item.record_uuid}，版本=${item.version_no}），请重新导出后再检查`,
        );
      }
      seenKeys.add(key);
    }

    const outcomes: RecordPackageItemCheckOutcome[] = [];
    for (const item of manifest.items) {
      try {
        assertManifestSnapshotHasNoSecretMaterial(item.content_snapshot);
      } catch (error) {
        outcomes.push({
          recordUuid: item.record_uuid,
          resourceType: item.resource_type,
          versionNo: item.version_no,
          passed: false,
          rejection: 'STRUCTURE_INVALID',
          message: error instanceof DomainError ? error.message : '条目结构非法',
        });
        continue;
      }

      const fileResult = await this.checkItemFiles(command.packagePath, item.files);
      if (fileResult.rejection !== null) {
        outcomes.push({
          recordUuid: item.record_uuid,
          resourceType: item.resource_type,
          versionNo: item.version_no,
          passed: false,
          rejection: fileResult.rejection,
          message: fileResult.message,
        });
        continue;
      }

      const duplicated = await this.hasDuplicateReceipt(
        targetOrganizationId,
        item.resource_type,
        item.record_uuid,
        item.version_no,
      );
      outcomes.push(
        duplicated
          ? {
              recordUuid: item.record_uuid,
              resourceType: item.resource_type,
              versionNo: item.version_no,
              // 重复项进入"可确认范围"，但只授权导入期做受控裁决：
              // 同包同源且本机权威版本可证明相同才跳过，否则冲突，绝不覆盖。
              passed: true,
              rejection: 'DUPLICATE_RECORD',
              message: '已存在同资源同版本的同步回执；导入时按本机权威事实裁决，证据不足判冲突',
            }
          : {
              recordUuid: item.record_uuid,
              resourceType: item.resource_type,
              versionNo: item.version_no,
              passed: true,
              rejection: null,
              message: null,
            },
      );
    }

    return { manifest, manifestRaw: raw, manifestChecksum, targetOrganizationId, outcomes };
  }

  /**
   * 本机目标公司数据区 id 的解析。
   *
   * - 查看者有可信公司（工程师／二级管理员）→ 即该公司在本机的 id；
   * - 一级管理员（全局范围，无所属公司）→ 按清单携带的**公司业务编码**在本机定位；
   *   清单未携带编码（旧包）或本机不存在该公司 ⇒ 失败关闭（不猜本地 id）。
   */
  private async resolveTargetOrganizationId(
    command: RecordPackageCheckCommand,
    manifest: RecordPackageManifest,
  ): Promise<number> {
    if (command.organizationId !== null) {
      return command.organizationId;
    }
    if (manifest.organization_code === null || manifest.organization_code === undefined) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
        '记录包未携带公司业务编码，无法在本机确定目标公司数据区',
      );
    }
    const identity = await this.organizationQueryService.findOrganizationIdentityByCode({
      organizationCode: manifest.organization_code,
    });
    if (identity === null) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.FOREIGN_COMPANY,
        '本机不存在记录包所属公司（按公司业务编码核对），拒绝检查',
      );
    }
    return identity.id;
  }

  /**
   * 读取导入批次事实（确认与执行共用）。
   *
   * 返回 null 表示该 package_id 没有本机的检查事实（未检查过或不是本机包的批次）。
   *
   * 注意：这是**按编号读原始事实**的入口，不做公司过滤
   * （`package_id` 是全局主键，同一编号只可能有一行、只属于一个公司）；
   * 公司范围的判定由调用方（导入用例）按可信 scope 完成。
   */
  async readImportFacts(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<{
    import: RecordPackageImportSnapshot;
    items: RecordPackageItemSnapshot[];
  } | null> {
    const importRepository = this.pickImportRepository(transactionContext);
    const itemRepository = this.pickItemRepository(transactionContext);
    const batch = await importRepository.findOne({ where: { packageId } });
    if (batch === null) {
      return null;
    }
    const items = await itemRepository.find({ where: { packageId } });
    return {
      import: toRecordPackageImportSnapshot(batch),
      items: items.map((item) => toRecordPackageItemSnapshot(item)),
    };
  }

  /**
   * 查找同键回执（导入登记与云端回执共用同一张表、同一把键）。
   *
   * 用于导入前的去重复核：同键已存在（云端回执或先前的导入登记）即跳过，
   * 不重复导入，也不与同步链路各算各的。
   */
  async findReceipt(key: {
    organizationId: number;
    resourceType: string;
    recordUuid: string;
    versionNo: number;
  }): Promise<{
    receiptId: string;
    /** 回执登记时的整包摘要；仅用于证明"同一份包"，不冒充单条内容摘要 */
    manifestChecksum: string | null;
    /** 回执登记的来源安装标识；与当前包一致才可能构成同包证明 */
    sourceInstallationId: string | null;
  } | null> {
    const repository = this.pickReceiptRepository();
    const receipt = await repository.findOne({
      where: {
        organizationId: key.organizationId,
        resourceType: key.resourceType,
        recordUuid: key.recordUuid,
        versionNo: key.versionNo,
      },
    });
    return receipt === null
      ? null
      : {
          receiptId: receipt.receiptId,
          manifestChecksum: receipt.manifestChecksum ?? null,
          sourceInstallationId: receipt.sourceInstallationId ?? null,
        };
  }

  /**
   * 占用导入批次（**绑定本次确认的版本**，任务 09 复验 P1）。
   *
   * 时序反例（修复前真实可发生）：
   * - A 导入读取并确认旧摘要 V1、旧 items，暂停在标记 RUNNING 前；
   * - B 用同一公司、同一编号的不同摘要 V2 重检并提交（换包重检会替换批次与 items）；
   * - A 继续**按编号**把（此时已是 V2 的）批次标成 RUNNING，却用内存里的 V1/items 执行与收敛
   *   ⇒ 把 V1 的执行记在 V2 批次上。
   *
   * 因此占用必须在**短事务**内、以**当前读 + 排他行锁**重新核对数据库当前事实：
   * - 批次存在、归属公司与本次可信目标公司一致；
   * - 清单摘要 == 本次确认的摘要（版本未变）；
   * - 检查状态为 PASSED；
   * - 状态允许占用（仅 PENDING；RUNNING 一律拒绝，见下方说明）。
   * 任一项不成立 ⇒ 受控拒绝（**不暴露**占用方的公司、摘要、状态与明细），
   * 调用方不得继续任何业务写入、逐条结果与终态更新。
   *
   * 返回**锁内刚确认的同一版本**批次与逐条事实：调用方必须以它为执行依据，
   * 不得继续使用占用前读到的旧快照。
   *
   * **RUNNING 一律失败关闭（无自动中断恢复）**：
   * 短事务的行锁在占用提交后即释放，无法覆盖其后跨多个事务/连接的整个导入执行期；
   * 现有表结构也没有"占用令牌/尝试行"，无法区分"仍有活跃执行"与"进程中断残留"。
   * 账号只是操作者身份，**不是本次执行的独占证明**：同一账号的两个活跃请求同样会被拒绝。
   *
   * 因此：
   * - PENDING ⇒ 首次占用，正常推进；
   * - RUNNING（**任何人，包括同账号本人**）⇒ `IMPORT_IN_PROGRESS` 受控拒绝，
   *   不暴露占用人身份；**不提供自动接管**，也不声称命名锁具备 fencing 能力。
   *
   * 受控处置：若首个进程已中断、批次长期停在 RUNNING，先由有权限的维护方核实
   * 无活跃导入，再按新编号重新导出；新编号包仍须走正式检查/确认，且同键记录在
   * 无法证明同一来源包与本机权威版本时会按冲突处理、需人工裁决，**不是自动续跑**。
   * 需要原位自动恢复必须先有产品/架构决定（占用令牌/尝试行＋失锁停止写入），属新增迁移，
   * 本轮不擅自引入。
   */
  async claimImportRun(input: {
    packageId: string;
    importedByAccountId: number;
    /** 本次可信目标公司（批次归属公司必须与它一致） */
    organizationId: number;
    /** 本次确认的清单摘要（版本凭据） */
    manifestChecksum: string;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<{
    import: RecordPackageImportSnapshot;
    items: RecordPackageItemSnapshot[];
  }> {
    const repository = this.pickImportRepository(input.transactionContext);
    // 当前读 + 排他行锁：读到的是最新已提交事实，且判定期间不会被并发方改写。
    const batch = await this.lockBatch(input.packageId, input.transactionContext);
    if (batch === null) {
      throw new DomainError(RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND, '记录包不存在或不在授权范围内');
    }
    // 归属核对：不一致时受控拒绝，不暴露占用方的公司与摘要。
    if (batch.organizationId !== input.organizationId) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT,
        '记录包编号已被占用，请使用原记录包的编号重新检查',
      );
    }
    // 版本核对：本次确认的摘要必须仍是批次当前摘要（换包重检已提交 ⇒ 旧确认作废）。
    if (batch.manifestChecksum !== input.manifestChecksum) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
        '记录包内容已变更，本次确认已失效，请重新检查并确认',
      );
    }
    if (batch.checkStatus !== 'PASSED') {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED,
        '记录包尚未通过安全预检，不能导入',
      );
    }
    if (batch.status === 'RUNNING') {
      // 在途与中断无法无歧义区分，短事务行锁也不覆盖整个执行期 ⇒ 任何人（含同账号本人）
      // 一律受控拒绝：不自动接管、不把账号当成独占凭据、不暴露占用人身份。
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
        '记录包正在导入中，未自动接管；若执行进程已中断，请先核实无活跃导入，再用新编号重新导出检查，同键记录可能需人工裁决',
      );
    }

    await repository.update(
      { packageId: input.packageId, manifestChecksum: input.manifestChecksum },
      { status: 'RUNNING', importedByAccountId: input.importedByAccountId, completedAt: null },
    );

    // 以锁内刚确认的同一版本事实作为执行依据（不沿用占用前的旧快照）。
    const claimed = await this.lockBatch(input.packageId, input.transactionContext);
    if (claimed === null || claimed.manifestChecksum !== input.manifestChecksum) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
        '记录包内容已变更，本次确认已失效，请重新检查并确认',
      );
    }
    return {
      import: toRecordPackageImportSnapshot(claimed),
      items: await this.listItems(input.packageId, input.transactionContext),
    };
  }

  /**
   * 写单条导入结果（**版本绑定**：条目行必须仍在本次占用的版本上）。
   *
   * 条目主键是版本凭据（换包重检会删除旧条目并插入新条目）：
   * 更新 0 行既可能是"值未变化"（MySQL 只报**变更**行数），也可能是"版本已被替换"。
   * 因此 0 行时必须**再回读一次**确认条目是否还在：
   * - 还在 ⇒ 只是值未变化，按幂等处理；
   * - 不在 ⇒ 版本已被替换 ⇒ 受控拒绝（不把旧版本的执行记到新版本上）。
   */
  async writeItemResult(
    itemId: string,
    result: {
      result: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CONFLICT';
      errorMessage: string | null;
      receiptId: string | null;
    },
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickItemRepository(transactionContext);
    const outcome = await repository.update(
      { id: itemId },
      {
        result: result.result,
        errorMessage: result.errorMessage,
        receiptId: result.receiptId,
      },
    );
    if (outcome.affected !== undefined && outcome.affected > 0) {
      return;
    }
    const still = await repository.findOne({ where: { id: itemId } });
    if (still === null) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
        '记录包内容已变更，本次确认已失效，请重新检查并确认',
      );
    }
  }

  /**
   * 确认期新鲜检查失败：只把**尚未执行**的条目改判为检查未通过（result 保持 NULL）。
   *
   * - 已有导入结果的条目不覆盖：历史结果仍是事实，且 DB CHECK 禁止
   *   `check_result=REJECTED` 与非空 `result` 共存；
   * - 条目主键仍是版本凭据：0 行时回读，消失即受控拒绝，仍在则按幂等处理。
   */
  async markItemCheckRejected(
    itemId: string,
    message: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickItemRepository(transactionContext);
    const outcome = await repository.update(
      { id: itemId, result: IsNull() },
      { checkResult: 'REJECTED', result: null, errorMessage: message },
    );
    if (outcome.affected !== undefined && outcome.affected > 0) {
      return;
    }
    const still = await repository.findOne({ where: { id: itemId } });
    if (still === null) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
        '记录包内容已变更，本次确认已失效，请重新检查并确认',
      );
    }
  }

  /**
   * 收敛批次终态并写成功／失败计数（**版本绑定**：只更新本次占用的那个摘要）。
   *
   * 终态是"这次执行的结果"，必须落在**本次占用的版本**上：
   * 条件更新带清单摘要，命中 0 行即说明批次已被换成别的版本 ⇒ 受控拒绝，
   * 不得把旧版本的执行结果记到新版本批次上（也不静默吞掉 0 行）。
   */
  async finalizeImport(
    packageId: string,
    summary: { status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'; succeeded: number; failed: number },
    manifestChecksum: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<void> {
    const repository = this.pickImportRepository(transactionContext);
    const outcome = await repository.update(
      { packageId, manifestChecksum },
      {
        status: summary.status,
        itemSucceeded: summary.succeeded,
        itemFailed: summary.failed,
        completedAt: new Date(),
      },
    );
    if (outcome.affected !== undefined && outcome.affected === 0) {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED,
        '记录包内容已变更，本次确认已失效，请重新检查并确认',
      );
    }
  }

  async persistCheckOutcome(
    evaluation: RecordPackageEvaluation,
    importedByAccountId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageCheckResult> {
    const { manifest, manifestRaw, manifestChecksum, outcomes, targetOrganizationId } = evaluation;
    const repository = this.pickImportRepository(transactionContext);
    const packageId = manifest.package_id;

    // ① 存在性初查：**快照读**（刻意不加锁）。
    //    对"不存在的行"加排他锁（FOR UPDATE）在 REPEATABLE READ 下会拿到间隙锁，
    //    两个并发插入会互相等待成死锁 ⇒ 这里不加锁，
    //    并发正确性改由"插入唯一键冲突后用当前读回读"承担（见 ③）。
    const observed = await repository.findOne({ where: { packageId } });

    if (observed !== null) {
      // ② 已有批次：**当前读 + 排他行锁**（事务边界正确）后再判定归属。
      //    行锁随事务释放 ⇒ 判定期间不会被别人改写归属或删掉逐条事实。
      const locked = await this.lockBatch(packageId, transactionContext);
      if (locked === null) {
        throw new DomainError(
          RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT,
          '记录包批次状态已变化，请重试',
        );
      }
      return await this.settleExistingBatch({
        batch: locked,
        manifest,
        manifestRaw,
        manifestChecksum,
        outcomes,
        targetOrganizationId,
        importedByAccountId,
        transactionContext,
      });
    }

    return await this.insertBatchAndItems({
      manifest,
      manifestRaw,
      manifestChecksum,
      outcomes,
      targetOrganizationId,
      importedByAccountId,
      transactionContext,
    });
  }

  /**
   * 首次落库：插入批次 ＋ 逐条检查事实（同一事务内）。
   *
   * 唯一键冲突 ⇒ 并发方已占用同一编号：必须用**当前读**（FOR UPDATE）回读赢家
   * ——MySQL 默认 REPEATABLE READ 下普通读会退回事务旧快照，看不到赢家刚提交的行
   * ⇒ 不能用快照读判定归属，也不能直接把重复键当作"可返回对方记录"。
   */
  private async insertBatchAndItems(input: {
    manifest: RecordPackageManifest;
    manifestRaw: string;
    manifestChecksum: string;
    outcomes: RecordPackageItemCheckOutcome[];
    targetOrganizationId: number;
    importedByAccountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<RecordPackageCheckResult> {
    const {
      manifest,
      manifestRaw,
      manifestChecksum,
      outcomes,
      targetOrganizationId,
      importedByAccountId,
      transactionContext,
    } = input;
    const repository = this.pickImportRepository(transactionContext);
    const packageId = manifest.package_id;
    // 合格范围：passed=true 的条目可进入受控确认；硬阻断条目只在逐条结果里显示。
    // 空包或全部硬阻断不得伪报检查通过。
    const executableCount = outcomes.filter((outcome) => outcome.passed).length;
    const checkStatus = executableCount > 0 ? 'PASSED' : 'REJECTED';

    // 与 DB CHECK 对齐：REJECTED ⇒ status 必须保持 PENDING；检查阶段 result 一律 NULL。
    // item_failed 是**导入结果**计数，检查阶段没有执行过导入，必须为 0。
    const importRow = repository.create({
      packageId,
      organizationId: targetOrganizationId,
      importedByAccountId,
      manifestJson: manifestRaw,
      manifestChecksum,
      status: 'PENDING',
      checkStatus,
      itemTotal: outcomes.length,
      itemSucceeded: 0,
      itemFailed: 0,
    });

    try {
      await repository.insert(importRow);
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
      const raced = await this.lockBatch(packageId, transactionContext);
      if (raced === null) {
        throw new DomainError(
          RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT,
          '记录包批次状态已变化，请重试',
        );
      }
      return await this.settleExistingBatch({
        batch: raced,
        manifest,
        manifestRaw,
        manifestChecksum,
        outcomes,
        targetOrganizationId,
        importedByAccountId,
        transactionContext,
      });
    }

    const itemRows = outcomes.map((outcome) =>
      this.pickItemRepository(transactionContext).create({
        packageId,
        recordUuid: outcome.recordUuid,
        resourceType: outcome.resourceType,
        versionNo: outcome.versionNo,
        checkResult: outcome.passed ? 'PASSED' : 'REJECTED',
        result: null,
        receiptId: null,
        errorMessage: outcome.message,
      }),
    );
    if (itemRows.length > 0) {
      await this.pickItemRepository(transactionContext).insert(itemRows);
    }

    return {
      outcome: 'checked',
      import: toRecordPackageImportSnapshot(importRow),
      items: itemRows.map(toRecordPackageItemSnapshot),
    };
  }

  /**
   * 已有批次的归属核对与落事实（**在行锁内**执行）。
   *
   * 归属边界（任务 09 审查 P1）：
   * - `record_package_import.package_id` 是**全局主键**（公司维度不进主键/唯一键），
   *   同一个编号在库里只能有一行、只属于一个公司；
   * - 既有批次的归属公司与本次**可信目标公司**不一致 ⇒ 一律受控拒绝：
   *   不改写归属、不删除对方逐条事实、不返回对方的批次/摘要/状态/明细；
   * - 一级管理员的全局查看范围**不等于**可以把既有公司的记录重归属：
   *   归属核对用的是"本次包按可信映射确定的目标公司"，不是查看者的可见范围。
   */
  private async settleExistingBatch(input: {
    batch: RecordPackageImportEntity;
    manifest: RecordPackageManifest;
    manifestRaw: string;
    manifestChecksum: string;
    outcomes: RecordPackageItemCheckOutcome[];
    targetOrganizationId: number;
    importedByAccountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<RecordPackageCheckResult> {
    const {
      batch,
      manifest,
      manifestRaw,
      manifestChecksum,
      outcomes,
      targetOrganizationId,
      importedByAccountId,
      transactionContext,
    } = input;
    const packageId = manifest.package_id;

    // 归属核对先于任何读取/返回 items、更新批次、删除旧 items。
    if (batch.organizationId !== targetOrganizationId) {
      // 受控拒绝：不暴露占用方的公司、摘要、状态与明细。
      throw new DomainError(
        RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT,
        '记录包编号已被占用，请使用原记录包的编号重新检查',
      );
    }

    if (batch.manifestChecksum === manifestChecksum) {
      // 同公司同摘要 ⇒ 幂等：返回既有批次与既有逐条事实，不产生第二个事实。
      // 注意：不会刷新确认期标记的"检查未通过，未执行"。文件恢复后旧编号重检
      // 只会拿到旧结论；受控处置是用新包编号重新导出检查（同键记录仍受 F2
      // 人工裁决限制），不得提示用户"重复检查即可恢复"。
      return {
        outcome: 'existing',
        import: toRecordPackageImportSnapshot(batch),
        items: await this.listItems(packageId, transactionContext),
      };
    }

    // 换包：同一 package_id 下清单校验值变化，说明包内容已被替换。
    // 旧预检结论随之失效，必须按新内容重新落检查事实（不保留旧逐条结论）。
    // 但批次**正在导入**（RUNNING）时不得覆盖：正在执行的事实不容重检改写。
    if (batch.status === 'RUNNING') {
      throw new DomainError(
        RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS,
        '记录包正在导入中，未自动接管；请核实旧执行确已停止后再用新编号检查，不能覆盖在途事实',
      );
    }

    const executableCount = outcomes.filter((outcome) => outcome.passed).length;
    const checkStatus = executableCount > 0 ? 'PASSED' : 'REJECTED';
    const repository = this.pickImportRepository(transactionContext);
    const refreshed = repository.create({
      ...batch,
      // 归属已核对一致（batch.organizationId === targetOrganizationId），此处只是显式回写。
      organizationId: targetOrganizationId,
      importedByAccountId,
      manifestJson: manifestRaw,
      manifestChecksum,
      status: 'PENDING',
      checkStatus,
      itemTotal: outcomes.length,
      itemSucceeded: 0,
      itemFailed: 0,
      completedAt: null,
    });
    await repository.update({ packageId }, refreshed);
    await this.pickItemRepository(transactionContext).delete({ packageId });

    const refreshedItems = outcomes.map((outcome) =>
      this.pickItemRepository(transactionContext).create({
        packageId,
        recordUuid: outcome.recordUuid,
        resourceType: outcome.resourceType,
        versionNo: outcome.versionNo,
        checkResult: outcome.passed ? 'PASSED' : 'REJECTED',
        result: null,
        receiptId: null,
        errorMessage: outcome.message,
      }),
    );
    if (refreshedItems.length > 0) {
      await this.pickItemRepository(transactionContext).insert(refreshedItems);
    }

    // 回读用**当前读**：本事务的快照可能早于并发方的提交，普通读会拿到旧值。
    const reloaded = await this.lockBatch(packageId, transactionContext);
    return {
      outcome: 'checked',
      import: toRecordPackageImportSnapshot(reloaded ?? refreshed),
      items: refreshedItems.map(toRecordPackageItemSnapshot),
    };
  }

  /**
   * 取批次的**当前读 + 排他行锁**（`SELECT ... FOR UPDATE`）。
   *
   * - 当前读：读的是**最新已提交**的行，不受事务旧快照回退影响
   *   （MySQL 默认 REPEATABLE READ 下普通读会退回快照）；
   * - 行锁：判定与随后的写入之间不会被别人插队改写归属或删除逐条事实；
   * - 无事务上下文时（单测直调）退化为普通读——此时本就没有可持有的行锁。
   */
  private async lockBatch(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageImportEntity | null> {
    const repository = this.pickImportRepository(transactionContext);
    return await repository.findOne({
      where: { packageId },
      ...(transactionContext === undefined ? {} : { lock: { mode: 'pessimistic_write' as const } }),
    });
  }

  private async listItems(
    packageId: string,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<RecordPackageItemSnapshot[]> {
    const rows = await this.pickItemRepository(transactionContext).find({
      where: { packageId },
      order: { id: 'ASC' },
    });
    return rows.map(toRecordPackageItemSnapshot);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ER_DUP_ENTRY'
    );
  }
}
