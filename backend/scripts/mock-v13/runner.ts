// scripts/mock-v13/runner.ts

/**
 * 运行编排：守卫 -> 连接核对 -> 结构核对 -> 单事务执行数据包 -> 定向校验 -> 提交。
 *
 * 失败处理必须区分三种状态：
 * - COMMIT 尚未发起且 ROLLBACK 确认成功：回收本轮创建的文件后抛出原错误；
 * - COMMIT 尚未发起但 ROLLBACK 失败/无法确认：保留文件并报告回滚错误；
 * - COMMIT 已发起但响应丢失：结果未知，保留文件，禁止声称已回滚（退出码 7）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataSource, DataSourceOptions } from 'typeorm';

import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { hashPasswordWithTimestamp } from '@core/account/policy/password-hashing.policy';

import {
  MockQueryRunner,
  acquireRunLock,
  findMany,
  findOne,
  listTableColumns,
  listTableNames,
  readTargetFacts,
  releaseRunLock,
  asRows,
} from './db';
import {
  CommitOutcomeUnknownError,
  GuardViolationError,
  MockConflictError,
  MockVerificationError,
  MockWriteError,
  PostCommitError,
  RollbackUnconfirmedError,
  attachFailureDiagnostics,
  exitCodeOf,
  failureDiagnosticsOf,
} from './errors';
import {
  FileRegistry,
  MockRootClaim,
  MockRootTarget,
  RootClaimHooks,
  RootOwner,
  claimMockRoots,
  sha256Hex,
  writeCredentialsFile,
  writeJsonFileExclusive,
} from './files';
import {
  assertCredentialsPathVacant,
  assertGuardConfig,
  assertMockDirectories,
  assertDistinctOutputPaths,
  assertOutputPathsOutsideMockDirectories,
  assertOutputPathVacant,
  assertSchemaColumns,
  assertSchemaTables,
  assertTargetFacts,
  parseCliArgs,
  parseMockEnv,
} from './guard';
import { ACCOUNTS, FIXED_ACCOUNT_CREATED_AT, ORGANIZATIONS, mockEmail, mockUuid } from './manifest';
import {
  PackContext,
  buildFieldEncryptionCodec,
  collectAccountFailures,
  readInstallationIdentity,
} from './packs-shared';
import { PACK_PREREQUISITES, PackDefinition, selectPacks } from './packs';
import { mockMaterialContent, mockMaterialReference } from './packs-p0';
import { RunReport, formatHelp, formatSummary } from './report';

/** 本轮独占的底层驱动连接；只用于 DataSource.destroy() 失败时的兜底断开。 */
export interface MockDriverConnection {
  destroy(): void;
}

export interface TransactionQueryRunner extends MockQueryRunner {
  connect(): Promise<void>;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
  /**
   * TypeORM MySQL QueryRunner 在 connect() 后挂载的底层驱动连接。
   * 正常收尾仍走 release()；只有连接不能回池且 DataSource.destroy() 失败时才兜底关闭。
   */
  readonly databaseConnection?: MockDriverConnection;
}

export interface RunDependencies {
  /** 仅测试注入：默认使用真实 TypeORM DataSource。 */
  createDataSource?(options: DataSourceOptions): DataSource;
  createQueryRunner(source: DataSource): Promise<TransactionQueryRunner>;
  /** 仅测试注入：默认使用正式数据包注册表。 */
  selectPacks?(selection: readonly string[]): readonly PackDefinition[];
  /** 仅测试/验收注入：默认使用 FileRegistry(fileRoots)。 */
  createFileRegistry?(roots: readonly string[]): FileRegistry;
  /** 仅测试注入：默认使用正式原件根认领。 */
  claimRoots?(
    targets: readonly MockRootTarget[],
    owner: RootOwner,
    hooks?: RootClaimHooks,
  ): MockRootClaim[];
}

const defaultDependencies: RunDependencies = {
  createQueryRunner: async (source) => {
    const queryRunner = source.createQueryRunner();
    await queryRunner.connect();
    return queryRunner;
  },
};

export interface ExecutePacksOptions {
  readonly database: string;
  readonly failAfterPack: string | null;
  readonly verify?: () => Promise<void>;
  /** 事务状态未确认而跳过普通 release() 时回调，供上层保留兜底关闭依据。 */
  readonly onConnectionRetained?: () => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** 回滚是收尾动作：失败只作为诊断返回，绝不覆盖主错误。 */
async function attemptRollback(queryRunner: TransactionQueryRunner): Promise<Error | null> {
  try {
    await queryRunner.rollbackTransaction();
    return null;
  } catch (error) {
    return asError(error);
  }
}

/**
 * 单事务执行；失败时按事务阶段决定回滚、文件回收与连接收尾。抽成独立函数以便离线验证 A6。
 *
 * 只有事务启动成功且回滚确认成功时才允许普通 release() 把连接交回池；
 * 启动结果不明或回滚未确认时，连接可能仍带事务，必须交由持有本轮专用 DataSource 的上层关闭。
 */
export async function executePacks(
  queryRunner: TransactionQueryRunner,
  packs: readonly PackDefinition[],
  context: PackContext,
  options: ExecutePacksOptions,
): Promise<void> {
  let connectionCloseRequired = false;
  let acquired = false;
  try {
    // 放入 try 内：运行锁查询抛错时也必须走连接收尾，不能把连接留在 main 手里。
    acquired = await acquireRunLock(queryRunner, options.database);
    if (!acquired) {
      const error = new MockWriteError('未获取到运行锁（可能有并发 Mock 正在执行）');
      attachFailureDiagnostics(error, { transactionState: 'NOT_STARTED' });
      throw error;
    }

    try {
      await queryRunner.startTransaction();
    } catch (startFailure) {
      // 启动结果不明：先尝试确认回滚；无论回滚是否成功，连接都不再走普通回池路径。
      connectionCloseRequired = true;
      const primaryError = asError(startFailure);
      const rollbackError = await attemptRollback(queryRunner);
      if (rollbackError) {
        throw new RollbackUnconfirmedError({
          targetDatabase: options.database,
          phase: 'START_UNCERTAIN',
          primaryError,
          rollbackError,
          retainedFiles: context.files.createdPaths(),
        });
      }
      const cleanup = context.files.cleanupCreated();
      attachFailureDiagnostics(primaryError, {
        rollbackConfirmed: true,
        transactionState: 'START_UNCERTAIN_ROLLBACK_CONFIRMED',
        cleanupErrors: cleanup.errors,
        retainedFiles: cleanup.retained,
      });
      throw primaryError;
    }

    let commitStarted = false;
    try {
      for (const pack of packs) {
        context.report.startPack(pack.id);
        await pack.run(context);
        if (options.failAfterPack === pack.id) {
          throw new MockWriteError(`注入失败：数据包 ${pack.id} 完成后强制回滚（A6 验收）`);
        }
      }
      if (options.verify) {
        await options.verify();
      }
      // 从这里开始，任何异常都不能再断言“未提交”：COMMIT 可能已在服务端生效。
      commitStarted = true;
      await queryRunner.commitTransaction();
    } catch (error) {
      if (commitStarted) {
        connectionCloseRequired = true;
        const rollbackError = await attemptRollback(queryRunner);
        throw new CommitOutcomeUnknownError({
          targetDatabase: options.database,
          phase: 'COMMIT_SENT',
          retainedFiles: context.files.createdPaths(),
          primaryError: asError(error),
          rollbackError,
        });
      }

      const rollbackError = await attemptRollback(queryRunner);
      if (rollbackError) {
        // 回滚未确认是独立结果：保留主错误、回滚错误与本轮文件，不得声称已回滚。
        connectionCloseRequired = true;
        throw new RollbackUnconfirmedError({
          targetDatabase: options.database,
          phase: 'ROLLBACK_FAILED',
          primaryError: asError(error),
          rollbackError,
          retainedFiles: context.files.createdPaths(),
        });
      }

      const cleanup = context.files.cleanupCreated();
      attachFailureDiagnostics(error, {
        rollbackConfirmed: true,
        transactionState: 'ROLLBACK_CONFIRMED',
        cleanupErrors: cleanup.errors,
        retainedFiles: cleanup.retained,
      });
      throw error;
    }
  } finally {
    if (acquired) {
      try {
        await releaseRunLock(queryRunner, options.database);
      } catch (error) {
        reportConnectionCleanupFailure(options.database, '释放运行锁', error);
      }
    }
    if (connectionCloseRequired) {
      options.onConnectionRetained?.();
      process.stderr.write(
        `[mock:v13] 库 ${options.database}：事务启动或回滚未确认，跳过普通 release()，` +
          '交由上层关闭本轮专用连接（不把可能仍带事务的连接交回池）。\n',
      );
    } else {
      try {
        // 连接由本函数独占释放；调用方（main）不再重复释放，避免双重 release。
        await queryRunner.release();
      } catch (error) {
        reportConnectionCleanupFailure(options.database, '释放 QueryRunner', error);
      }
    }
  }
}

function reportConnectionCleanupFailure(database: string, step: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[mock:v13] 库 ${database}：${step}失败（不改变事务结论）：${reason}\n`);
}

/**
 * DataSource.destroy() 在断开前失败时的兜底：直接关闭本轮独占的驱动连接。
 *
 * 该连接从未执行普通 release()，关闭它不会把可能仍带事务的连接交回池，
 * 也不影响共享池中的其他会话。兜底失败单独记录，不覆盖主错误、回滚错误或关闭错误。
 */
function closeRetainedConnection(connection: MockDriverConnection | null): void {
  if (!connection) {
    process.stderr.write(
      '[mock:v13] 未取得本轮独占驱动连接句柄，无法兜底断开；请用独立连接核对目标库。\n',
    );
    return;
  }
  try {
    connection.destroy();
    process.stderr.write(
      '[mock:v13] 已用本轮独占驱动连接兜底断开（仅关闭本轮连接，不影响共享池或其他会话）。\n',
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[mock:v13] 兜底断开本轮独占驱动连接失败：${reason}（与上方关闭错误分别保留）。\n`,
    );
  }
}

interface PrivateConnectionPool {
  /** mysql2 回调式连接池：end(callback) 返回 undefined，关闭结果只能从回调得知。 */
  end(callback: (error?: Error | null) => void): void;
}

/**
 * DataSource.destroy() 在关闭私有池前失败时，兜底关闭本轮 CLI 自己创建的私有池。
 *
 * 只结束本轮私有池并等待关闭结果：不处理已归池的单个连接，不碰共享池；
 * 兜底结果单独返回，由调用方与原始关闭错误分别记录，不覆盖事务退出码。
 *
 * mysql2 的 `Pool.end(callback)` 返回 undefined，必须等回调触发才算关闭完成；
 * 回调报错或 `end()` 同步抛出都视为本次兜底关闭失败。
 */
async function closePrivatePool(source: DataSource): Promise<Error | null> {
  let pool: PrivateConnectionPool | undefined;
  try {
    const driver = source.driver as unknown as { pool?: PrivateConnectionPool } | undefined;
    pool = driver?.pool;
  } catch (error) {
    return asError(error);
  }
  if (!pool || typeof pool.end !== 'function') {
    return new Error('未找到本轮私有连接池');
  }
  const target = pool;
  return new Promise<Error | null>((resolve) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      resolve(error ? asError(error) : null);
    };
    try {
      target.end((error) => finish(error));
    } catch (error) {
      finish(asError(error));
    }
  });
}

function asReferenceText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 固定账号逐个核对：登录名、账号状态、资料状态、资料角色、账号角色、等级与归属。
 *
 * 只按总数判断会被“对照客户补足总数”绕过；因此这里不接受数量兜底，
 * 任一固定账号的任一事实不符都判定失败，且不自动修复、不重置密码、不覆盖昵称。
 */
export async function verifyAccounts(context: PackContext): Promise<void> {
  const queryRunner = context.qr;
  const failed: string[] = await collectAccountFailures(context, ACCOUNTS);
  const check = (condition: boolean, message: string): void => {
    if (!condition) failed.push(message);
  };

  for (const key of ['pending-engineer', 'rejected-engineer'] as const) {
    const spec = ACCOUNTS.find((account) => account.key === key);
    if (!spec) {
      failed.push(`${key}: 清单缺少固定申请账号`);
      continue;
    }
    const account = await findOne(queryRunner, 'base_user_account', {
      login_name: spec.loginName,
    });
    if (!account) {
      failed.push(`${spec.loginName}: 申请账号缺失`);
      continue;
    }
    const applications = await findMany(
      queryRunner,
      'engineer_registration_application',
      { account_id: Number(account.id) },
      'id DESC',
      1,
    );
    const expectedStatus = key === 'pending-engineer' ? 'PENDING' : 'REJECTED';
    check(
      applications.length === 1 && asReferenceText(applications[0].status) === expectedStatus,
      `${spec.loginName}: 工程师申请状态不是 ${expectedStatus}`,
    );
  }

  if (failed.length > 0) {
    throw new MockVerificationError(`固定账号定向校验失败：${failed.join('；')}`);
  }
  for (const code of ORGANIZATIONS.map((item) => item.code)) {
    const organization = await findOne(queryRunner, 'organization', { organization_code: code });
    if (!organization || Number(organization.is_managed_company) !== 1) {
      throw new MockVerificationError(`受管公司 ${code} 缺失或未启用`);
    }
  }
  context.report.note('定向校验：固定账号逐个核对登录名/账号态/资料态/角色/等级/归属');
}

async function verifyRepairBasics(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const tickets = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM repair_request WHERE request_no LIKE 'MOCK-V13-REQ-%'",
    ),
  )[0];
  if (Number(tickets?.total ?? 0) < 4) {
    throw new MockVerificationError('有效工单不足 4 组');
  }
  const unconverted = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM repair_request_intake i JOIN base_user_account a ON a.id=i.customer_account_id WHERE i.converted_request_id IS NULL AND LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(unconverted?.total ?? 0) < 2) {
    throw new MockVerificationError('未转单报修不足 2 条');
  }
  report.note('定向校验：工单与未转单报修满足最低数量');
}

async function verifyReports(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const drafts = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM maintenance_report WHERE source_type='HISTORICAL_CASE' AND status='DRAFT' AND title LIKE '[MOCK-V13]%'",
    ),
  )[0];
  if (Number(drafts?.total ?? 0) < 2) {
    throw new MockVerificationError('独立草稿不足 2 份');
  }
  const approved = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM maintenance_report WHERE status='APPROVED' AND title LIKE '[MOCK-V13]%'",
    ),
  )[0];
  if (Number(approved?.total ?? 0) < 2) {
    throw new MockVerificationError('正式报告不足 2 份');
  }
  const formalWithVersion = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM maintenance_report r JOIN maintenance_report_version v ON v.report_id=r.id AND v.version_no=r.current_version_no WHERE r.status='APPROVED' AND r.title LIKE '[MOCK-V13]%'",
    ),
  )[0];
  if (Number(formalWithVersion?.total ?? 0) < 2) {
    throw new MockVerificationError('正式报告与冻结版本不一致');
  }
  report.note('定向校验：报告草稿/正式报告满足最低数量且版本一致');
}

async function verifyDocuments(
  queryRunner: MockQueryRunner,
  report: RunReport,
  referenceStorageDir: string,
): Promise<void> {
  const onlineDocs = asRows(
    await queryRunner.query(
      "SELECT COUNT(DISTINCT owner_organization_id) AS total FROM reference_document WHERE publication_status='ONLINE' AND title LIKE '[MOCK-V13]%'",
    ),
  )[0];
  if (Number(onlineDocs?.total ?? 0) < 2) {
    throw new MockVerificationError('A/B 两家公司的在线正式资料不足');
  }
  const stored = asRows(
    await queryRunner.query(
      'SELECT COUNT(*) AS total FROM stored_file WHERE storage_reference = ? AND checksum_sha256 IS NOT NULL',
      [path.join('files', 'intake-a-in-progress.png')],
    ),
  )[0];
  if (Number(stored?.total ?? 0) < 1) {
    throw new MockVerificationError('缺少可定位的报修原件');
  }
  const document = await findOne(queryRunner, 'reference_document', {
    title: '[MOCK-V13] 星港曝光台对准漂移处置手册',
  });
  const expectedReference = mockMaterialReference();
  const expectedContent = mockMaterialContent();
  const reference = document ? asReferenceText(document.storage_reference) : '';
  const storageBackend = document ? asReferenceText(document.storage_backend) : '';
  if (!document || storageBackend !== 'LOCAL' || reference !== expectedReference) {
    throw new MockVerificationError(
      `资料原件引用与本次生成/校验不一致（backend=${storageBackend}，reference=${reference}）`,
    );
  }
  const referencePath = path.join(referenceStorageDir, reference);
  if (!fs.existsSync(referencePath)) {
    throw new MockVerificationError('资料声称可下载但实际文件缺失');
  }
  if (sha256Hex(fs.readFileSync(referencePath)) !== sha256Hex(expectedContent)) {
    throw new MockVerificationError('资料原件内容与本次校验的原件不一致');
  }
  report.note('定向校验：资料在线状态、业务引用与真实文件内容一致');
}

async function verifyAi(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const conversations = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM ai_conversation c JOIN base_user_account a ON a.id=c.engineer_account_id WHERE LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(conversations?.total ?? 0) < 2) {
    throw new MockVerificationError('AI 历史会话不足 2 个');
  }
  const failedAnalysis = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM ai_message_analysis x JOIN ai_conversation c ON c.id=x.conversation_id JOIN base_user_account a ON a.id=c.engineer_account_id WHERE x.status='FAILED' AND LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(failedAnalysis?.total ?? 0) < 1) {
    throw new MockVerificationError('缺少失败分析对照');
  }
  report.note('定向校验：AI 历史会话与失败分析对照满足最低数量');
}

async function verifyPackages(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const packageIds = [mockUuid('package:valid:b'), mockUuid('package:corrupt:b')];
  const packages = asRows(
    await queryRunner.query(
      'SELECT COUNT(*) AS total FROM record_package_import WHERE package_id IN (?, ?)',
      packageIds,
    ),
  )[0];
  if (Number(packages?.total ?? 0) < 2) {
    throw new MockVerificationError('记录包样例不足 2 份');
  }
  const rejected = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM record_package_import WHERE check_status='REJECTED' AND package_id IN (?, ?)",
      packageIds,
    ),
  )[0];
  if (Number(rejected?.total ?? 0) < 1) {
    throw new MockVerificationError('缺少损坏包拒绝对照');
  }
  report.note('定向校验：记录包合法/损坏样例满足最低数量');
}

async function verifyBackup(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const installation = await readInstallationIdentity(queryRunner);
  const runs = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM local_backup_run WHERE error_code='MOCK_V13_NO_EXECUTOR' AND installation_id=?",
      [installation.installationId],
    ),
  )[0];
  if (Number(runs?.total ?? 0) < 2) {
    throw new MockVerificationError('备份联调记录不足 2 条');
  }
  const restores = asRows(
    await queryRunner.query(
      'SELECT COUNT(*) AS total FROM backup_restore_run WHERE restore_id IN (?, ?)',
      [mockUuid('restore-run:pending'), mockUuid('restore-run:failed')],
    ),
  )[0];
  if (Number(restores?.total ?? 0) < 2) {
    throw new MockVerificationError('恢复联调记录不足 2 条');
  }
  const fakeSuccess = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM backup_asset WHERE cloud_status='SUCCEEDED' AND backup_id IN (?, ?)",
      [mockUuid('backup-asset:run-manual'), mockUuid('backup-asset:run-scheduled')],
    ),
  )[0];
  if (Number(fakeSuccess?.total ?? 0) > 0) {
    throw new MockVerificationError('检测到伪造的云端备份成功记录');
  }
  report.note('定向校验：备份/恢复均为可解释的非成功样例');
}

/** 未同时选择的前置包必须在目标库中已存在；否则在事务开始前拒绝。 */
async function assertPackPrerequisites(
  queryRunner: MockQueryRunner,
  selected: readonly PackDefinition[],
): Promise<void> {
  const selectedIds = new Set(selected.map((pack) => pack.id));
  for (const pack of selected) {
    for (const prerequisite of PACK_PREREQUISITES[pack.id]) {
      if (selectedIds.has(prerequisite)) continue;
      if (!(await prerequisiteSatisfied(queryRunner, prerequisite))) {
        throw new GuardViolationError(
          `数据包 ${pack.id} 的前置 ${prerequisite} 未选择，且目标库中未找到其数据；请先运行 ${prerequisite} 或在同一命令中一并选择`,
        );
      }
    }
  }
}

async function prerequisiteSatisfied(
  queryRunner: MockQueryRunner,
  prerequisite: PackDefinition['id'],
): Promise<boolean> {
  if (prerequisite === 'p0-org-accounts') {
    const logins = ACCOUNTS.map((account) => account.loginName);
    const placeholders = logins.map(() => '?').join(', ');
    const row = asRows(
      await queryRunner.query(
        `SELECT COUNT(*) AS total FROM base_user_account WHERE login_name IN (${placeholders})`,
        logins,
      ),
    )[0];
    return Number(row?.total ?? 0) === logins.length;
  }
  if (prerequisite === 'p0-equipment') {
    const row = asRows(
      await queryRunner.query('SELECT COUNT(*) AS total FROM equipment_model WHERE enabled=1'),
    )[0];
    return Number(row?.total ?? 0) >= 2;
  }
  if (prerequisite === 'p0-repair') {
    const row = asRows(
      await queryRunner.query(
        "SELECT COUNT(*) AS total FROM repair_request WHERE request_no LIKE 'MOCK-V13-REQ-%'",
      ),
    )[0];
    return Number(row?.total ?? 0) >= 4;
  }
  if (prerequisite === 'p0-reports') {
    const row = asRows(
      await queryRunner.query(
        "SELECT COUNT(*) AS total FROM maintenance_report WHERE status='APPROVED' AND title LIKE '[MOCK-V13]%'",
      ),
    )[0];
    return Number(row?.total ?? 0) >= 2;
  }
  return true;
}

function formatCommitOutcomeUnknown(error: CommitOutcomeUnknownError): string {
  const details = error.details;
  const lines: string[] = [
    '[mock:v13] 提交结果未知：COMMIT 已发出但未确认，不能断言已回滚。',
    `目标库=${details.targetDatabase}`,
    '执行阶段=COMMIT_SENT（COMMIT 调用已发起，响应丢失或抛错）',
  ];
  if (details.retainedFiles.length > 0) {
    lines.push(`保留本轮创建的文件 ${details.retainedFiles.length} 个（未回收）：`);
    for (const file of details.retainedFiles) {
      lines.push(`  - ${file}`);
    }
  } else {
    lines.push('本轮未创建文件；请在独立连接上核对事务是否生效。');
  }
  lines.push(`主错误=${details.primaryError.message}`);
  lines.push(
    details.rollbackError
      ? `回滚错误=${details.rollbackError.message}（回滚失败也不能证明先前未提交）`
      : '回滚调用已尝试但成功与否不能证明先前未提交。',
  );
  lines.push(
    '后续只读核对：请使用独立连接只读核对目标库中本次 Mock 样例键是否存在，再决定人工处理；不要直接重跑覆盖。',
  );
  return lines.join('\n');
}

function formatRollbackUnconfirmed(error: RollbackUnconfirmedError): string {
  const details = error.details;
  const lines: string[] = [
    `[mock:v13] 回滚未确认（退出码 8，目标库=${details.targetDatabase}，阶段=${details.phase}）：不能声称已回滚。`,
    `主错误=${details.primaryError.message}`,
    `回滚错误=${details.rollbackError.message}`,
  ];
  if (details.retainedFiles.length > 0) {
    lines.push(`保留本轮创建的文件 ${details.retainedFiles.length} 个（未回收）：`);
    for (const file of details.retainedFiles) {
      lines.push(`  - ${file}`);
    }
  } else {
    lines.push('本轮未创建文件。');
  }
  lines.push(
    '请使用独立连接只读核对目标库后再决定人工处理；不要直接重跑覆盖，也不要把本次结果改记为“已回滚”。',
  );
  return lines.join('\n');
}

export async function main(
  argv: readonly string[],
  dependencies: RunDependencies = defaultDependencies,
): Promise<number> {
  const startedAt = Date.now();
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`[mock:v13] ${(error as Error).message}\n`);
    return exitCodeOf(error);
  }
  if (options.help) {
    process.stdout.write(`${formatHelp()}\n`);
    return 0;
  }

  let source: DataSource | null = null;
  let queryRunner: TransactionQueryRunner | null = null;
  // 本轮独占驱动连接：事务未确认时 DataSource.destroy() 失败的最后兜底。
  let exclusiveConnection: MockDriverConnection | null = null;
  let connectionRetained = false;
  let packsOwnRelease = false;
  // 已确定的结果码；用于关闭连接失败时保留原结论，避免落到 CLI 通用兜底 4。
  let resultCode: number | null = null;
  let commitConfirmed = false;
  try {
    if (!options.envFile) {
      throw new GuardViolationError('必须显式提供 --env-file');
    }
    const env = parseMockEnv(options.envFile);
    const guard = assertGuardConfig(options, env);
    const policy = new PasswordPolicyService().validatePassword(env.mockPassword);
    if (!policy.isValid) {
      throw new GuardViolationError(`测试密码不符合项目密码策略: ${policy.errors.join('; ')}`);
    }
    const selected = (dependencies.selectPacks ?? selectPacks)(options.packs);
    // 失败注入必须命中本次所选包，否则事务内永远不会触发，A6 会得到“假通过”。
    if (
      options.failAfterPack !== null &&
      !selected.some((pack) => pack.id === options.failAfterPack)
    ) {
      throw new GuardViolationError(
        `--fail-after-pack=${options.failAfterPack} 不在本次所选数据包内（${selected
          .map((pack) => pack.id)
          .join(', ')}），拒绝执行`,
      );
    }
    // 凭据只属于账号包；未选择账号包时必须在任何写入前拒绝。
    if (
      options.credentialsOut !== null &&
      !selected.some((pack) => pack.id === 'p0-org-accounts')
    ) {
      throw new GuardViolationError(
        '--credentials-out 只能与 p0-org-accounts 同时使用；未选择账号包，拒绝写入凭据',
      );
    }

    // 所有路径检查都在首次数据库/文件写入之前完成。
    assertOutputPathsOutsideMockDirectories(options);
    const credentialsPath = options.credentialsOut
      ? assertCredentialsPathVacant(options.credentialsOut)
      : null;
    assertMockDirectories(options.mockFileDir, options.referenceStorageDir);
    const jsonOutPath = options.jsonOut
      ? assertOutputPathVacant(options.jsonOut, '--json-out')
      : null;
    if (credentialsPath && jsonOutPath) {
      assertDistinctOutputPaths(credentialsPath, jsonOutPath);
    }
    process.stdout.write(
      `[mock:v13] 生效时区=${env.dbTimezone ?? '未设置'}（必须与开发后端一致；不输出密钥）\n`,
    );

    const dataSourceOptions: DataSourceOptions = {
      type: 'mysql',
      host: env.dbHost,
      port: env.dbPort,
      username: env.dbUser,
      password: env.dbPassword,
      database: env.dbName,
      entities: [],
      synchronize: false,
      logging: false,
      charset: env.dbCharset ?? 'utf8mb4',
      timezone: env.dbTimezone ?? 'Z',
      extra: { connectionLimit: 1 },
    };
    source = dependencies.createDataSource
      ? dependencies.createDataSource(dataSourceOptions)
      : new DataSource(dataSourceOptions);
    await source.initialize();
    queryRunner = await dependencies.createQueryRunner(source);
    exclusiveConnection = queryRunner.databaseConnection ?? null;

    const facts = await readTargetFacts(queryRunner);
    assertTargetFacts(guard, facts);
    const tables = await listTableNames(queryRunner);
    assertSchemaTables(tables);
    const columnsByTable = await listTableColumns(queryRunner);
    assertSchemaColumns(columnsByTable);
    await assertPackPrerequisites(queryRunner, selected);

    const report = new RunReport();
    const fileRoots = [options.mockFileDir, options.referenceStorageDir];
    const createFileRegistry = dependencies.createFileRegistry ?? ((roots) => new FileRegistry(roots));
    const context: PackContext = {
      qr: queryRunner,
      report,
      files: createFileRegistry(fileRoots),
      mockFileDir: options.mockFileDir,
      referenceStorageDir: options.referenceStorageDir,
      passwordHash: hashPasswordWithTimestamp(env.mockPassword, FIXED_ACCOUNT_CREATED_AT),
      encryption: buildFieldEncryptionCodec(env.fieldEncryptionKey, env.fieldEncryptionIv),
    };

    if (!options.write) {
      process.stdout.write(
        [
          '[mock:v13] dry-run：守卫与目标核对通过，未写入任何数据。',
          `目标库=${guard.database} 实例=${facts.instanceUuid} 时区=${env.dbTimezone ?? '未设置'} 数据包=${selected.map((pack) => pack.id).join(', ')}`,
          '如需写入，追加 --write，并在环境文件中设置 MOCK_V13_WRITE_ACK。',
        ].join('\n') + '\n',
      );
      resultCode = 0;
      return 0;
    }

    // 两个原件根分别建立持久归属：在核对实际实例 UUID 与库名之后、业务写入之前。
    try {
      (dependencies.claimRoots ?? claimMockRoots)(
        [
          { flag: '--mock-file-dir', dir: options.mockFileDir },
          { flag: '--reference-storage-dir', dir: options.referenceStorageDir },
        ],
        { instanceUuid: facts.instanceUuid, database: guard.database },
      );
    } catch (error) {
      // 认领发生在事务之前；即使第一根标记已落盘，业务事务也尚未开始。
      attachFailureDiagnostics(error, { transactionState: 'NOT_STARTED' });
      throw error;
    }
    // 认领完成后按真实路径再核对一次，防止竞态中出现的链接。
    assertMockDirectories(options.mockFileDir, options.referenceStorageDir);

    if (options.failAfterPack !== null) {
      process.stdout.write(`[mock:v13] 已启用失败注入：${options.failAfterPack}\n`);
    }

    const verifier = async (): Promise<void> => {
      const ids = new Set(selected.map((pack) => pack.id));
      if (ids.has('p0-org-accounts')) await verifyAccounts(context);
      if (ids.has('p0-repair')) await verifyRepairBasics(queryRunner as MockQueryRunner, report);
      if (ids.has('p0-reports')) await verifyReports(queryRunner as MockQueryRunner, report);
      if (ids.has('p0-documents')) {
        await verifyDocuments(queryRunner as MockQueryRunner, report, options.referenceStorageDir);
      }
      if (ids.has('p1-ai')) await verifyAi(queryRunner as MockQueryRunner, report);
      if (ids.has('p1-packages')) await verifyPackages(queryRunner as MockQueryRunner, report);
      if (ids.has('p1-backup')) await verifyBackup(queryRunner as MockQueryRunner, report);
    };

    packsOwnRelease = true;
    await executePacks(queryRunner, selected, context, {
      database: guard.database,
      failAfterPack: options.failAfterPack,
      verify: verifier,
      onConnectionRetained: () => {
        connectionRetained = true;
      },
    });
    // executePacks 正常返回即代表 COMMIT 已确认成功。
    commitConfirmed = true;

    // 至此事务已提交；下面的收尾失败不得再以“已回滚”的退出码 4 表达。
    process.stdout.write(
      `${formatSummary(report, {
        database: guard.database,
        instanceUuid: facts.instanceUuid,
        mode: 'write',
        durationMs: Date.now() - startedAt,
        timezone: env.dbTimezone,
      })}\n`,
    );

    try {
      if (credentialsPath) {
        const verifiedLogins = new Set(report.verifiedAccountLoginNames());
        const accountsToExport = ACCOUNTS.filter((account) =>
          verifiedLogins.has(account.loginName),
        );
        writeCredentialsFile(credentialsPath, {
          generated_at: new Date().toISOString(),
          mock: true,
          warning: '仅限开发联调；请通过受控渠道交付，不得提交到 Git。',
          password: env.mockPassword,
          accounts: accountsToExport.map((account) => ({
            loginName: account.loginName,
            email: mockEmail(account.loginName),
            role: account.role,
            adminLevel: account.adminLevel,
            organization:
              account.organization === 'PLATFORM'
                ? '平台 CLIENT 组织'
                : (account.organization ?? '无（未授予）'),
            state: account.accountStatus,
            scenario: account.note,
          })),
        });
        process.stdout.write(
          `[mock:v13] 凭据索引已写入（${accountsToExport.length} 个本次创建/核验账号）: ${credentialsPath}\n`,
        );
      } else {
        process.stdout.write('[mock:v13] 未写凭据文件；测试密码未持久化，请通过受控渠道交付。\n');
      }

      if (jsonOutPath) {
        writeJsonFileExclusive(jsonOutPath, {
          mode: 'write',
          database: guard.database,
          instanceUuid: facts.instanceUuid,
          timezone: env.dbTimezone,
          durationMs: Date.now() - startedAt,
          packs: report.packStats(),
          scenarios: report.scenarioIndex(),
          fileRoots,
          credentialsFile: credentialsPath,
        });
        process.stdout.write(`[mock:v13] 运行统计已写入: ${jsonOutPath}\n`);
      }
    } catch (error) {
      const postCommitError = new PostCommitError(
        `数据已提交，但收尾文件写入失败: ${(error as Error).message}`,
      );
      process.stderr.write(`[mock:v13] ${postCommitError.message}（退出码 6，不回滚）\n`);
      resultCode = postCommitError.exitCode;
      return postCommitError.exitCode;
    }
    resultCode = 0;
    return 0;
  } catch (error) {
    const diagnostics = failureDiagnosticsOf(error);
    if (error instanceof CommitOutcomeUnknownError) {
      process.stderr.write(`${formatCommitOutcomeUnknown(error)}\n`);
      resultCode = error.exitCode;
      return error.exitCode;
    }
    if (error instanceof RollbackUnconfirmedError) {
      process.stderr.write(`${formatRollbackUnconfirmed(error)}\n`);
      resultCode = error.exitCode;
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mock:v13] 失败: ${message}\n`);
    // 只有确实执行过 ROLLBACK 且调用成功时才允许声称“事务已回滚”；
    // 写入前被守卫拒绝、未取得运行锁或事务启动失败但回滚已确认等情况必须逐个区分。
    if (diagnostics.transactionState === 'START_UNCERTAIN_ROLLBACK_CONFIRMED') {
      process.stderr.write(
        '[mock:v13] 事务启动结果不明，但 ROLLBACK 已确认；未提交，本轮文件可回收（退出码 4）。\n',
      );
    } else if (diagnostics.transactionState === 'NOT_STARTED') {
      process.stderr.write('[mock:v13] 事务尚未开始，未执行回滚（不得记为已回滚）。\n');
    } else if (diagnostics.rollbackConfirmed === true) {
      process.stderr.write(
        error instanceof MockConflictError
          ? '[mock:v13] 已有数据归属不明，本次未覆盖；事务已确认回滚。\n'
          : '[mock:v13] 事务已确认回滚。\n',
      );
    }
    if (diagnostics.cleanupErrors && diagnostics.cleanupErrors.length > 0) {
      process.stderr.write(
        `[mock:v13] 文件清理错误（不影响上方主错误）：${diagnostics.cleanupErrors.join('；')}\n`,
      );
    }
    if (diagnostics.retainedFiles && diagnostics.retainedFiles.length > 0) {
      process.stderr.write(
        `[mock:v13] 保留未回收的文件（无法确认仍是本轮创建对象）：${diagnostics.retainedFiles.join('；')}\n`,
      );
    }
    resultCode = exitCodeOf(error);
    return resultCode;
  } finally {
    if (queryRunner && !packsOwnRelease) {
      try {
        await queryRunner.release();
      } catch (error) {
        reportConnectionCleanupFailure(options.database ?? '(未确认)', '释放 QueryRunner', error);
      }
    }
    if (source?.isInitialized) {
      let shutdownError: Error | null = null;
      try {
        await source.destroy();
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      }
      if (shutdownError) {
        // 关闭失败单独记录，绝不覆盖已确定的事务结论。
        process.stderr.write(`[mock:v13] 关闭连接失败：${shutdownError.message}\n`);
        if (connectionRetained) {
          // 连接从未回池，destroy() 又在断开前失败：直接关闭本轮独占驱动连接。
          closeRetainedConnection(exclusiveConnection);
        }
        // destroy() 未完成关闭：兜底结束本轮私有池，并等待关闭结果。
        // 普通 release() 已成功时连接已归池，这里只关池，不再销毁该连接。
        const poolCloseError = await closePrivatePool(source);
        if (poolCloseError) {
          process.stderr.write(
            `[mock:v13] 兜底关闭本轮私有池失败：${poolCloseError.message}（与上方关闭错误分别保留）。\n`,
          );
        } else {
          process.stderr.write(
            '[mock:v13] 已兜底关闭本轮私有池（仅本轮私有连接池，不影响共享池或其他会话）。\n',
          );
        }
        if (commitConfirmed) {
          process.stderr.write(
            '[mock:v13] 数据已提交；关闭连接失败属于收尾错误（退出码 6，不回滚，本轮文件不回收）。\n',
          );
          return 6;
        }
        if (resultCode === 7) {
          process.stderr.write(
            '[mock:v13] 提交结果仍未知（退出码 7），原始错误与关闭错误均已保留，请用独立连接核对。\n',
          );
          return 7;
        }
        if (resultCode !== null) {
          process.stderr.write(
            `[mock:v13] 关闭连接失败不覆盖原结果（保持退出码 ${resultCode}）。\n`,
          );
          return resultCode;
        }
        // 没有已确定结果时不要吞掉原始异常，交由外层 CLI 处理。
      }
    }
  }
}
