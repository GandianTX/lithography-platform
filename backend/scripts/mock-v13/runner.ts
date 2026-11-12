// scripts/mock-v13/runner.ts

/**
 * 运行编排：守卫 -> 连接核对 -> 结构核对 -> 单事务执行数据包 -> 定向校验 -> 提交。
 * 任何失败都在事务内回滚，并只回收本次创建的文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataSource } from 'typeorm';

import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { hashPasswordWithTimestamp } from '@core/account/policy/password-hashing.policy';

import {
  MockQueryRunner,
  acquireRunLock,
  findOne,
  listTableColumns,
  listTableNames,
  readTargetFacts,
  releaseRunLock,
  asRows,
} from './db';
import {
  GuardViolationError,
  MockConflictError,
  MockVerificationError,
  MockWriteError,
  PostCommitError,
  exitCodeOf,
} from './errors';
import { FileRegistry, writeCredentialsFile } from './files';
import {
  assertCredentialsPathOutsideRepository,
  assertGuardConfig,
  assertMockDirectories,
  assertSchemaColumns,
  assertSchemaTables,
  assertTargetFacts,
  parseCliArgs,
  parseMockEnv,
} from './guard';
import { ACCOUNTS, FIXED_ACCOUNT_CREATED_AT, ORGANIZATIONS, mockEmail, mockUuid } from './manifest';
import { PackContext, buildFieldEncryptionCodec, readInstallationIdentity } from './packs-shared';
import { PackDefinition, selectPacks } from './packs';
import { RunReport, formatHelp, formatSummary } from './report';

export interface TransactionQueryRunner extends MockQueryRunner {
  connect(): Promise<void>;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
}

export interface RunDependencies {
  createQueryRunner(source: DataSource): Promise<TransactionQueryRunner>;
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
}

/** 单事务执行；失败回滚并回收本次文件。抽成独立函数以便离线验证 A6。 */
export async function executePacks(
  queryRunner: TransactionQueryRunner,
  packs: readonly PackDefinition[],
  context: PackContext,
  options: ExecutePacksOptions,
): Promise<void> {
  const acquired = await acquireRunLock(queryRunner, options.database);
  try {
    if (!acquired) {
      throw new MockWriteError('未获取到运行锁（可能有并发 Mock 正在执行）');
    }
    await queryRunner.startTransaction();
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
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      context.files.cleanupCreated();
      throw error;
    }
  } finally {
    if (acquired) {
      try {
        await releaseRunLock(queryRunner, options.database);
      } catch {
        // 释放失败不掩盖主错误。
      }
    }
    try {
      // 连接由本函数独占释放；调用方（main）不再重复释放，避免双重 release。
      await queryRunner.release();
    } catch {
      // 连接可能已释放，不掩盖主错误。
    }
  }
}

function asReferenceText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function verifyP0(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
  const usable = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM base_user_account a JOIN base_user_info i ON i.account_id=a.id JOIN organization_membership m ON m.account_id=a.id AND m.status='ACTIVE' WHERE a.status='ACTIVE' AND i.user_state='ACTIVE' AND LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(usable?.total ?? 0) < 8) {
    const actual = Number(usable?.total ?? 0);
    throw new MockVerificationError(`可用账号不足 8 个（实际统计=${actual}）`);
  }
  const level1 = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM base_user_account a JOIN organization_membership m ON m.account_id=a.id AND m.status='ACTIVE' JOIN organization o ON o.id=m.organization_id AND o.is_managed_company=0 WHERE a.status='ACTIVE' AND a.identity_hint='SUPER_ADMIN' AND a.admin_level=1 AND LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(level1?.total ?? 0) < 2) {
    throw new MockVerificationError('平台组织下的一级管理员不足 2 个');
  }
  const level2 = asRows(
    await queryRunner.query(
      "SELECT COUNT(*) AS total FROM base_user_account a JOIN organization_membership m ON m.account_id=a.id AND m.status='ACTIVE' JOIN organization o ON o.id=m.organization_id AND o.is_managed_company=1 WHERE a.status='ACTIVE' AND a.identity_hint='SUPER_ADMIN' AND a.admin_level=2 AND LEFT(a.login_name, 9)='mock_v13_'",
    ),
  )[0];
  if (Number(level2?.total ?? 0) < 2) {
    throw new MockVerificationError('受管公司下的二级管理员不足 2 个');
  }
  for (const code of ORGANIZATIONS.map((item) => item.code)) {
    const organization = await findOne(queryRunner, 'organization', { organization_code: code });
    if (!organization || Number(organization.is_managed_company) !== 1) {
      throw new MockVerificationError(`受管公司 ${code} 缺失或未启用`);
    }
  }
  report.note('定向校验：账号/组织满足最低数量');
}

async function verifyP0Business(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
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
  report.note('定向校验：工单/报告满足最低数量且版本一致');
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
  const reference = document ? asReferenceText(document.storage_reference) : '';
  if (!reference || !fs.existsSync(path.join(referenceStorageDir, reference))) {
    throw new MockVerificationError('资料声称可下载但实际文件缺失');
  }
  report.note('定向校验：资料在线状态与真实文件一致');
}

async function verifyP1(queryRunner: MockQueryRunner, report: RunReport): Promise<void> {
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
  report.note('定向校验：AI/同步/包样例满足最低数量');
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
  let packsOwnRelease = false;
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
    const selected = selectPacks(options.packs);
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

    const credentialsPath = options.credentialsOut
      ? assertCredentialsPathOutsideRepository(options.credentialsOut)
      : null;
    assertMockDirectories(options.mockFileDir, options.referenceStorageDir);

    source = new DataSource({
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
    });
    await source.initialize();
    queryRunner = await dependencies.createQueryRunner(source);

    const facts = await readTargetFacts(queryRunner);
    assertTargetFacts(guard, facts);
    const tables = await listTableNames(queryRunner);
    assertSchemaTables(tables);
    const columnsByTable = await listTableColumns(queryRunner);
    assertSchemaColumns(columnsByTable);

    const report = new RunReport();
    const fileRoots = [options.mockFileDir, options.referenceStorageDir];
    const context: PackContext = {
      qr: queryRunner,
      report,
      files: new FileRegistry(fileRoots),
      mockFileDir: options.mockFileDir,
      referenceStorageDir: options.referenceStorageDir,
      passwordHash: hashPasswordWithTimestamp(env.mockPassword, FIXED_ACCOUNT_CREATED_AT),
      encryption: buildFieldEncryptionCodec(env.fieldEncryptionKey, env.fieldEncryptionIv),
    };

    if (!options.write) {
      process.stdout.write(
        [
          '[mock:v13] dry-run：守卫与目标核对通过，未写入任何数据。',
          `目标库=${guard.database} 实例=${facts.instanceUuid} 数据包=${selected.map((pack) => pack.id).join(', ')}`,
          '如需写入，追加 --write，并在环境文件中设置 MOCK_V13_WRITE_ACK。',
        ].join('\n') + '\n',
      );
      return 0;
    }

    fs.mkdirSync(options.mockFileDir, { recursive: true });
    fs.mkdirSync(options.referenceStorageDir, { recursive: true });

    if (options.failAfterPack !== null) {
      process.stdout.write(`[mock:v13] 已启用失败注入：${options.failAfterPack}\n`);
    }

    const verifier = async (): Promise<void> => {
      const ids = new Set(selected.map((pack) => pack.id));
      if (ids.has('p0-org-accounts')) await verifyP0(queryRunner as MockQueryRunner, report);
      if (ids.has('p0-repair') || ids.has('p0-reports')) {
        await verifyP0Business(queryRunner as MockQueryRunner, report);
      }
      if (ids.has('p0-documents')) {
        await verifyDocuments(queryRunner as MockQueryRunner, report, options.referenceStorageDir);
      }
      if (ids.has('p1-ai') || ids.has('p1-packages')) {
        await verifyP1(queryRunner as MockQueryRunner, report);
      }
      if (ids.has('p1-backup')) await verifyBackup(queryRunner as MockQueryRunner, report);
    };

    packsOwnRelease = true;
    await executePacks(queryRunner, selected, context, {
      database: guard.database,
      failAfterPack: options.failAfterPack,
      verify: verifier,
    });

    // 至此事务已提交；下面的收尾失败不得再以“已回滚”的退出码 4 表达。
    process.stdout.write(
      `${formatSummary(report, {
        database: guard.database,
        instanceUuid: facts.instanceUuid,
        mode: 'write',
        durationMs: Date.now() - startedAt,
      })}\n`,
    );

    try {
      if (credentialsPath) {
        const written = writeCredentialsFile(credentialsPath, {
          generated_at: new Date().toISOString(),
          mock: true,
          warning: '仅限开发联调；请通过受控渠道交付，不得提交到 Git。',
          password: env.mockPassword,
          accounts: ACCOUNTS.map((account) => ({
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
          `[mock:v13] 凭据索引${written ? '已写入' : '已存在（未覆盖）'}: ${credentialsPath}\n`,
        );
      } else {
        process.stdout.write('[mock:v13] 未写凭据文件；测试密码未持久化，请通过受控渠道交付。\n');
      }

      if (options.jsonOut) {
        const jsonPath = path.resolve(options.jsonOut);
        if (!fs.existsSync(path.dirname(jsonPath))) {
          throw new MockWriteError(`--json-out 父目录不存在: ${path.dirname(jsonPath)}`);
        }
        fs.writeFileSync(
          jsonPath,
          `${JSON.stringify(
            {
              mode: 'write',
              database: guard.database,
              instanceUuid: facts.instanceUuid,
              durationMs: Date.now() - startedAt,
              exitCode: 0,
              packs: report.packStats(),
              scenarios: report.scenarioIndex(),
              fileRoots,
              credentialsFile: credentialsPath,
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
        process.stdout.write(`[mock:v13] 运行统计已写入: ${jsonPath}\n`);
      }
    } catch (error) {
      const postCommitError = new PostCommitError(
        `数据已提交，但收尾文件写入失败: ${(error as Error).message}`,
      );
      process.stderr.write(`[mock:v13] ${postCommitError.message}（退出码 6，不回滚）\n`);
      return postCommitError.exitCode;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mock:v13] 失败: ${message}\n`);
    if (error instanceof MockConflictError) {
      process.stderr.write('[mock:v13] 已有数据归属不明，本次未覆盖；事务已回滚。\n');
    }
    return exitCodeOf(error);
  } finally {
    if (queryRunner && !packsOwnRelease) {
      try {
        await queryRunner.release();
      } catch {
        // 连接可能已释放。
      }
    }
    if (source?.isInitialized) {
      await source.destroy();
    }
  }
}
