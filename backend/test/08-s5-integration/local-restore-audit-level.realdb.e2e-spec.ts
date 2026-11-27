// test/08-s5-integration/local-restore-audit-level.realdb.e2e-spec.ts

/**
 * 恢复审计的**操作者等级**：实库链路验证（任务 09 独立验收 P2）。
 *
 * 目的：把"恢复审计事件里的操作者等级"从**结构性推断**变成
 * **真实库、真实文件、真实执行入口**的实测结论。
 *
 * | 场景 | 期望行为 | 实测关注点 |
 * | --- | --- | --- |
 * | L2 二级管理员执行**成功** | 终态审计事件的 `actor_admin_level` = 2 | 任务 10 读侧看到的是 2，不是一级 |
 * | L1 一级管理员执行**成功** | 终态审计事件的 `actor_admin_level` = 1 | 一级不被误记成二级 |
 * | L3 二级管理员执行**失败**（受控写入失败） | 失败终态审计事件的 `actor_admin_level` = 2 | 失败路径同样记真实等级 |
 * | L4 授权可见 | 二级只看本公司；一级全局；外公司二级看不到 | 公司范围不回退 |
 *
 * 来源链是**真实的**：真实账号行（`admin_level`）→ 真实可信成员关系 →
 * 真实 scope 解析 → 真实恢复执行用例 → 真实执行服务 → 真实审计写入 →
 * **任务 10 的实际查询服务**读回。
 *
 * 纪律：
 * - 目标公司是**本轮新建的一次性公司**（隔离库内），范围表内没有任何既有行
 *   ⇒ 恢复的"整体替换"不触碰任何既有数据；
 * - 只写本轮创建的对象；收尾走**拥有权台账**（真实 ID ＋ 创建时确定的预期事实）：
 *   删除前对全量登记对象做预检（身份、关键字段、外部引用），预检不通过即一条都不删；
 *   全部删除在**同一事务**内完成，后续任一步失败即整体回滚；
 *   收尾受**库白名单 ＋ 显式物理清理许可**两道门禁约束（不降低全局守卫）；
 * - 受控文件根是**每轮唯一**的新建目录（带归属标记），收尾只删本轮登记的路径，
 *   **绝不**整目录删除既有固定目录。
 *
 * 默认跳过；启用时显式声明隔离库并给出物理清理许可：
 *   LOCAL_RESTORE_AUDIT_LEVEL_INTEGRATION=1 E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     LOCAL_RESTORE_AUDIT_LEVEL_ENV_FILE=<专用 env> LOCAL_RESTORE_AUDIT_LEVEL_FILE_ROOT=<专用文件根父目录> \
 *     npx jest --testPathIgnorePatterns "/node_modules/" "/dist/" \
 *     --runTestsByPath test/08-s5-integration/local-restore-audit-level.realdb.e2e-spec.ts --runInBand
 * 后两项缺省仍为仓库 e2e 配置与 `.local/task09`，不降低库/文件归属守卫。
 *
 * 收尾失败注入（仅测试用，不关闭任何守卫；注入后需按真实 ID/根标记精确回收残留）：
 *   TASK09_P2_INJECT_DB_CLEANUP_FAILURE=1   → 传错目标库，白名单在首删前拒绝；文件必须保留
 *   TASK09_P2_INJECT_FILE_CLEANUP_FAILURE=1 → 已登记 packages 内放未登记文件，预检保留字节且 runner 非零
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';

import {
  BACKUP_PAYLOAD_PATH,
  buildProtectedBackupManifest,
  encryptBackupPayload,
  parseProtectionKey,
  type BackupScopeTable,
} from '@core/local-runtime/policy/protected-backup.policy';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { BackupRestoreRunEntity } from '@src/modules/lithography/entities/backup-restore-run.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalRestoreExecutionService } from '@src/modules/lithography/local-restore-execution.service';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import { ManagementAuditEventQueryService } from '@src/modules/lithography/queries/management-audit-event.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { ExecuteLocalRestoreUsecase } from '@usecases/local-runtime/execute-local-restore.usecase';
import { LocalRuntimeScopeResolver } from '@usecases/local-runtime/local-runtime-scope.resolver';

import { LOCAL_RESTORE_RECORD_TABLES } from '@usecases/common/ports/local-restore-record-writer.contract';

import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { createOwnedResourceLedger, recordOwnedResource } from '../utils/e2e-scoped-cleanup';
import { createTestAccount } from '../utils/test-accounts';
import { seedTestMemberships, seedTestOrganizations } from '../utils/test-organizations';
import {
  cleanupOwnedFileRoot,
  createOwnedFileRoot,
  createTask09OwnedRowRegistry,
  runTask09GuardedCleanup,
  type OwnedFileRoot,
} from '../utils/task09-real-db-cleanup';

jest.setTimeout(180_000);

const ENABLED = process.env.LOCAL_RESTORE_AUDIT_LEVEL_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = process.env.LOCAL_RESTORE_AUDIT_LEVEL_ENV_FILE ?? 'env/.env.e2e';

/** 本轮固定的受保护包测试密钥（与恢复自检脚本同款；仅用于一次性隔离库） */
const TEST_KEY_HEX = '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';
const TEST_KEY_ID = 'kid-task09-p2-audit-level';

/** 受控文件根的**基目录**（每轮在其中新建唯一子目录，绝不复用既有目录） */
const FILE_BASE_DIR =
  process.env.LOCAL_RESTORE_AUDIT_LEVEL_FILE_ROOT ?? join(__dirname, '../../.local/task09');

/** 全范围空载荷（根表齐备 ⇒ 载荷范围一致性检查通过） */
function emptyPayload(): Record<string, unknown[]> {
  const payload: Record<string, unknown[]> = {};
  for (const table of LOCAL_RESTORE_RECORD_TABLES) {
    payload[table] = [];
  }
  return payload;
}

/** 全范围行数口径（空载荷 ⇒ 全为 0） */
function scopeCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of LOCAL_RESTORE_RECORD_TABLES) {
    counts[table] = 0;
  }
  return counts;
}

/** 构造一个受保护的备份包目录（真实文件、真实加密、真实清单） */
function buildPackage(
  fileRoot: OwnedFileRoot,
  createdPaths: string[],
  packageDirectories: string[],
  input: {
    dirName: string;
    backupId: string;
    organizationId: number;
    installationId: string;
    payload: Record<string, unknown[]>;
    scopeRowCounts: Record<string, number>;
  },
): string {
  const packagesDir = join(fileRoot.root, 'packages');
  mkdirSync(packagesDir, { recursive: true });
  createdPaths.push(packagesDir);
  const dir = join(packagesDir, input.dirName);
  mkdirSync(dir, { recursive: true });
  const key = parseProtectionKey(TEST_KEY_HEX);
  const encrypted = encryptBackupPayload(key, Buffer.from(JSON.stringify(input.payload), 'utf8'));
  const payloadPath = join(dir, BACKUP_PAYLOAD_PATH);
  writeFileSync(payloadPath, encrypted.data);
  const manifest = buildProtectedBackupManifest({
    backupId: input.backupId,
    organizationId: input.organizationId,
    installationId: input.installationId,
    runId: null,
    generatedAt: new Date('2026-11-25T00:00:00.000Z'),
    encryption: { keyId: TEST_KEY_ID, iv: encrypted.iv, authTag: encrypted.authTag },
    scope: Object.entries(input.scopeRowCounts).map(([table, rowCount]) => ({
      table: table as BackupScopeTable,
      rowCount,
      lastUpdatedAt: null,
    })),
    files: [
      {
        relative_path: BACKUP_PAYLOAD_PATH,
        sha256: createHash('sha256').update(encrypted.data).digest('hex'),
        byte_size: encrypted.data.byteLength,
      },
    ],
    originals: [],
  });
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  // 登记本轮真实创建的文件与包目录（收尾只删登记过的路径）
  createdPaths.push(payloadPath, manifestPath, dir);
  packageDirectories.push(dir);
  return dir;
}

/**
 * 本轮一次性公司（隔离库内新建；范围表内无既有行）。
 *
 * 登记口径：**真实 ID ＋ 创建时确定的关键字段**（不按公司范围/目标 ID 批量推断）。
 */
describeIntegration('恢复审计的操作者等级（实库链路，任务 09 独立验收 P2）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let usecase: ExecuteLocalRestoreUsecase;
  let auditQuery: ManagementAuditEventQueryService;

  /** 拥有权台账（真实 ID ＋ 预期事实）：全局清理器按它做预检与精确删除 */
  const owned = createOwnedResourceLedger();
  /** 任务 09 专属表（全局台账未覆盖）的登记清单 */
  const extraRows = createTask09OwnedRowRegistry();
  /** 本轮唯一受控文件根 ＋ 本轮真实创建的文件路径 */
  let fileRoot: OwnedFileRoot;
  const createdFilePaths: string[] = [];
  /** 本轮真实创建的包目录（引用核验覆盖目录引用及其子文件） */
  const createdPackageDirectories: string[] = [];

  /** 本轮一次性公司（隔离库内新建；范围表内无既有行） */
  let organizationId = 0;
  let organizationCode = '';
  let level1AccountId = 0;
  let level2AccountId = 0;
  let level2LoginName = '';
  let installationId = '';
  let backupRunId = 0;

  beforeAll(async () => {
    const declared = process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);

    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        TypeOrmModule.forRoot({
          type: 'mysql',
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          database: config.database,
          timezone: config.timezone,
          charset: config.charset,
          synchronize: false,
          logging: false,
          entities: [join(__dirname, '../../src/**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        LithographyModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);

    // 本轮唯一受控文件根（每轮新建；带归属标记）
    fileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-p2-audit-level-');

    // 真实 scope 解析（等级来自账号行、公司来自可信成员关系）
    const accountQueryService = new AccountQueryService(
      dataSource.getRepository(AccountEntity),
      dataSource.getRepository(UserInfoEntity),
    );
    const scopeResolver = new LocalRuntimeScopeResolver(
      accountQueryService,
      moduleRef.get(TrustedOrganizationContextQueryService),
    );
    // 真实执行服务（受保护包材料注入）
    const restoreExecutionService = new LocalRestoreExecutionService(
      dataSource.getRepository(BackupRestoreRunEntity),
      dataSource.getRepository(BackupAssetEntity),
      dataSource.getRepository(LocalInstallationEntity),
      moduleRef.get(LocalWriteHoldService),
      moduleRef.get(ManagementAuditService),
      moduleRef as never,
      new PinoLogger({}),
      { keyHex: TEST_KEY_HEX, keyId: TEST_KEY_ID },
      undefined,
    );
    usecase = new ExecuteLocalRestoreUsecase(scopeResolver, restoreExecutionService);
    auditQuery = moduleRef.get(ManagementAuditEventQueryService);

    const installation = await dataSource
      .getRepository(LocalInstallationEntity)
      .findOne({ where: { id: 1 } });
    if (installation === null) {
      throw new Error('隔离库缺少本机安装身份（local_installation.id=1）');
    }
    installationId = installation.installationId;

    // 本轮一次性公司（编码唯一 ⇒ 不可能撞既有公司；登记真实 ID 与预期事实）
    organizationCode = `TASK09-P2-${randomUUID().slice(0, 8)}`;
    const organizationIdsByCode = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode,
          name: '任务09-P2 取证隔离公司',
          kind: 'PEER',
        },
      ],
      ownership: owned,
    });
    organizationId = organizationIdsByCode.get(organizationCode) ?? 0;
    if (organizationId <= 0) {
      throw new Error('造数失败：未取得本轮一次性公司 ID');
    }

    level1AccountId = (await seedAccount(1)).accountId;
    const level2Account = await seedAccount(2);
    level2AccountId = level2Account.accountId;
    level2LoginName = level2Account.loginName;
    // 二级管理员的可信公司（唯一有效成员关系）
    await seedTestMemberships({
      dataSource,
      memberships: [
        {
          accountLoginName: level2LoginName,
          organizationCode,
          memberRole: 'SUPER_ADMIN',
          status: 'ACTIVE',
        },
      ],
      organizationIdsByCode,
      ownership: owned,
    });

    // 备份资产的外键来源（本机运行事实；不在恢复写回范围表内）
    await dataSource.query(
      'INSERT INTO local_backup_run (installation_id, organization_id, trigger_type, status, ' +
        'started_at, finished_at, manifest_path, manifest_checksum, byte_size, attachment_count, ' +
        'schema_version, error_code, error_message, created_at, updated_at) ' +
        "VALUES (?, ?, 'MANUAL', 'SUCCEEDED', NOW(3), NOW(3), ?, ?, 1024, 1, 1, NULL, NULL, NOW(3), NOW(3))",
      [installationId, organizationId, 'task09/p2/manifest.json', 'b'.repeat(64)],
    );
    backupRunId = Number((await dataSource.query('SELECT LAST_INSERT_ID() AS id'))[0]?.id ?? 0);
    // 登记本轮真实创建的备份运行行（真实 ID ＋ 创建时确定的关键字段）。
    // 全局清理器按 `backup_asset` → `local_backup_run` → `organization` 的顺序删除。
    recordOwnedResource(owned, 'localBackupRun', backupRunId, {
      installationId,
      organizationId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      manifestPath: 'task09/p2/manifest.json',
      manifestChecksum: 'b'.repeat(64),
    });
  });

  afterAll(async () => {
    const errors: Array<{ stage: string; error: unknown }> = [];
    const describeError = (error: unknown): string => {
      if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
      }
      // jest 跨 realm 抛出的 Node SystemError 可能不满足 instanceof Error ⇒ 按结构化字段取信息
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const structured = error as { code?: unknown; message?: unknown };
        const code = typeof structured.code === 'string' ? `[${structured.code}] ` : '';
        const message =
          typeof structured.message === 'string' ? structured.message : '(非字符串消息)';
        return `${code}${message}`;
      }
      return typeof error === 'string' ? error : '(非 Error/字符串错误)';
    };

    // ① 数据库收尾：预检 ＋ 同事务精确删除（失败即整体回滚，不假报零残留）。
    //    仅**测试失败注入**时故意传入错误库名，用于验证"数据库失败 ⇒ 一个字节都不删"。
    const injectDbFailure = process.env.TASK09_P2_INJECT_DB_CLEANUP_FAILURE === '1';
    let dbCleanupSucceeded = false;
    try {
      await runTask09GuardedCleanup({
        dataSource,
        helper: '恢复审计等级实库规格 afterAll 精确回收',
        owned,
        extraRows,
        expectedDatabase: injectDbFailure
          ? '__INJECTED_DB_CLEANUP_FAILURE__'
          : (process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e'),
      });
      dbCleanupSucceeded = true;
    } catch (error) {
      errors.push({ stage: '数据库清理', error });
    }

    // ② 只有数据库明确成功且**待删文件已无存活引用**时，才允许删除字节。
    //    数据库预检拒绝、事务回滚、提交结果未知或引用查询失败 ⇒ 保留唯一目录与其下所有字节，
    //    输出可定位的脱敏诊断，并让 runner 非零（不在本次捕获里吞掉主错误）。
    let filesKeptIntentionally = false;
    if (!dbCleanupSucceeded) {
      filesKeptIntentionally = true;
    } else {
      try {
        // 引用核验覆盖"包目录本身 + 其下子文件 + 单独登记的路径"，
        // 不能只按文件路径精确等值：backup_asset.local_reference 记录的是包目录。
        const referencedPaths = [...new Set(createdFilePaths)];
        const packagePrefixes = [...new Set(createdPackageDirectories)];
        const references =
          referencedPaths.length === 0
            ? []
            : await dataSource.query(
                `SELECT \`backup_id\` FROM \`backup_asset\` WHERE ` +
                  `\`local_reference\` IN (${referencedPaths.map(() => '?').join(', ')})` +
                  packagePrefixes.map(() => ' OR INSTR(`local_reference`, ?) = 1').join(''),
                [...referencedPaths, ...packagePrefixes],
              );
        if (references.length > 0) {
          filesKeptIntentionally = true;
          errors.push({
            stage: '文件引用核验',
            error: new Error(
              `待删文件/包目录仍被 ${references.length} 条 backup_asset 行引用，保留字节（不删可能仍被引用的文件）`,
            ),
          });
        }
      } catch (error) {
        filesKeptIntentionally = true;
        errors.push({ stage: '文件引用查询', error });
      }
    }

    if (filesKeptIntentionally) {
      errors.push({
        stage: '文件保留诊断',
        error: new Error(
          `数据库清理未明确成功或引用未核实 ⇒ 未执行文件清理；本轮唯一文件根=${fileRoot.root}（可据此人工核对/回收）`,
        ),
      });
    } else {
      try {
        // 仅测试失败注入：在**已登记的 packages 父目录**放入未登记文件，
        // 旧递归删除会连带删掉它；新实现必须保留字节并让 runner 非零。
        if (process.env.TASK09_P2_INJECT_FILE_CLEANUP_FAILURE === '1') {
          writeFileSync(
            join(fileRoot.root, 'packages', 'INJECTED-unregistered.bin'),
            'keep-me',
            'utf8',
          );
        }
        // 数据库与文件不能同事务：此处只删本轮登记路径；遇未登记项或非空目录即抛错。
        cleanupOwnedFileRoot(fileRoot, createdFilePaths);
      } catch (error) {
        errors.push({ stage: '文件清理', error });
      }
    }

    // ③ 连接关闭尽力执行，但不替换/吞掉任何已记录错误。
    try {
      await dataSource.destroy();
    } catch (error) {
      errors.push({ stage: '连接关闭', error });
    }

    if (errors.length > 0) {
      throw new Error(
        `本轮收尾失败（唯一文件根=${fileRoot.root}；文件${filesKeptIntentionally ? '已按安全策略保留' : '已按登记清单处理'}）：` +
          errors.map(({ stage, error }) => `[${stage}] ${describeError(error)}`).join(' | '),
        { cause: errors.map(({ stage, error }) => ({ stage, error })) },
      );
    }
  });

  /** 造数：管理员账号（等级是本轮审计事实的来源） */
  async function seedAccount(adminLevel: 1 | 2): Promise<{ accountId: number; loginName: string }> {
    const loginName = `t09p2-l${adminLevel}-${randomUUID().slice(0, 8)}`;
    const { accountId } = await createTestAccount(
      dataSource,
      null,
      {
        loginName,
        loginEmail: `${loginName}@task09.invalid`,
        loginPassword: `T09p2#${adminLevel}${randomUUID().slice(0, 8)}`,
        status: AccountStatus.ACTIVE,
        accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
        identityType: IdentityTypeEnum.SUPER_ADMIN,
      },
      owned,
    );
    // 等级事实取当前库（`base_user_account.admin_level`），不信任任何静态等级。
    await dataSource.query('UPDATE base_user_account SET admin_level = ? WHERE id = ?', [
      adminLevel,
      accountId,
    ]);
    return { accountId, loginName };
  }

  /** 造数：一次恢复（两个包资产 ＋ 一个已受理的执行中恢复运行） */
  async function seedRestore(input: {
    tag: string;
    accountId: number;
    /** 载荷（默认＝全范围空载荷） */
    payload?: Record<string, unknown[]>;
    scopeRowCounts?: Record<string, number>;
  }): Promise<string> {
    const sourceBackupId = randomUUID();
    const protectionBackupId = randomUUID();
    const restoreId = randomUUID();
    const sourceDir = buildPackage(fileRoot, createdFilePaths, createdPackageDirectories, {
      dirName: `${input.tag}-source`,
      backupId: sourceBackupId,
      organizationId,
      installationId,
      payload: input.payload ?? emptyPayload(),
      scopeRowCounts: input.scopeRowCounts ?? scopeCounts(),
    });
    const protectionDir = buildPackage(fileRoot, createdFilePaths, createdPackageDirectories, {
      dirName: `${input.tag}-protection`,
      backupId: protectionBackupId,
      organizationId,
      installationId,
      payload: emptyPayload(),
      scopeRowCounts: scopeCounts(),
    });

    for (const [backupId, localReference] of [
      [sourceBackupId, sourceDir],
      [protectionBackupId, protectionDir],
    ] as Array<[string, string]>) {
      await dataSource.getRepository(BackupAssetEntity).insert({
        backupId,
        runId: backupRunId,
        organizationId,
        localCleanupRunId: null,
        installationId,
        formatVersion: 1,
        dataVersion: 'v1',
        manifestChecksum: null,
        localReference,
        cloudReference: null,
        encryptionKeyId: TEST_KEY_ID,
        verifiedAt: null,
        retentionUntil: null,
        failureReason: null,
        deletedAt: null,
        localCleanupError: null,
        storageReference: `task09/p2/${backupId}`,
        fileSha256: 'a'.repeat(64),
        byteSize: '1024',
        cloudStatus: 'PENDING',
        localStatus: 'PENDING',
        cloudReceipt: null,
        attemptCount: 0,
        lastAttemptAt: null,
      });
      // 登记本轮真实创建的资产（真实 ID ＋ 创建时确定的关键字段）
      recordOwnedResource(owned, 'backupAsset', backupId, {
        runId: backupRunId,
        organizationId,
        storageReference: `task09/p2/${backupId}`,
        fileSha256: 'a'.repeat(64),
        localCleanupRunId: null,
      });
    }

    await dataSource.getRepository(BackupRestoreRunEntity).insert({
      restoreId,
      backupId: sourceBackupId,
      protectionBackupId,
      targetInstallationId: installationId,
      checkStatus: 'PASSED',
      confirmation: {
        accepted_at: new Date().toISOString(),
        accepted_by_account_id: input.accountId,
        restore_id: restoreId,
        backup_id: sourceBackupId,
        protection_backup_id: protectionBackupId,
        organization_id: organizationId,
      },
      organizationId,
      startedByAccountId: input.accountId,
      status: 'RUNNING',
      checkSnapshot: JSON.stringify({
        schema_version: 1,
        checked_at: new Date().toISOString(),
        findings: [],
      }),
      restoredScope: null,
      resultSummary: null,
      startedAt: new Date(),
      finishedAt: null,
    });
    // 登记本轮真实创建的恢复运行（真实 ID ＋ 创建时确定的关键字段）
    recordOwnedResource(owned, 'backupRestoreRun', restoreId, {
      backupId: sourceBackupId,
      protectionBackupId,
      organizationId,
      startedByAccountId: input.accountId,
    });

    return restoreId;
  }

  /**
   * 登记本次恢复产生的**真实运行事实**（逐条按真实主键登记，不按 restoreId/公司批量推断）：
   * - 审计事件（`management_audit_event.event_id`）；
   * - 冻结行（`local_write_hold.hold_id`）；
   * - 范围锁行（`local_write_scope_lock.id`）。
   */
  async function registerRestoreFacts(input: { restoreId: string }): Promise<void> {
    const events = await dataSource.query(
      'SELECT event_id, actor_account_id, organization_id, operation, target_type, target_id, result ' +
        'FROM `management_audit_event` WHERE `target_type` = ? AND `target_id` = ?',
      ['LOCAL_RESTORE', input.restoreId],
    );
    for (const event of events as Array<Record<string, unknown>>) {
      recordOwnedResource(owned, 'managementAuditEvent', String(event.event_id), {
        actorAccountId: Number(event.actor_account_id),
        organizationId:
          event.organization_id === null || event.organization_id === undefined
            ? null
            : Number(event.organization_id),
        operation: String(event.operation),
        targetType: String(event.target_type),
        targetId: String(event.target_id),
        result: String(event.result),
      });
    }

    const holds = await dataSource.query(
      'SELECT hold_id, installation_id, organization_id, hold_type, status, restore_id ' +
        'FROM `local_write_hold` WHERE `restore_id` = ?',
      [input.restoreId],
    );
    for (const hold of holds as Array<Record<string, unknown>>) {
      extraRows.register(
        'local_write_hold',
        { hold_id: String(hold.hold_id) },
        {
          installation_id: String(hold.installation_id),
          organization_id: Number(hold.organization_id),
          hold_type: String(hold.hold_type),
          status: String(hold.status),
          restore_id: String(hold.restore_id),
        },
      );
    }

    // 范围锁行没有 restore_id，只有 installation_id + organization_id。
    // 本轮公司是**一次性新建**的（隔离库内此前不存在）⇒ 该公司的全部范围锁行都归本轮。
    const locks = await dataSource.query(
      'SELECT id, installation_id, organization_id FROM `local_write_scope_lock` WHERE `organization_id` = ?',
      [organizationId],
    );
    for (const lock of locks as Array<Record<string, unknown>>) {
      extraRows.register(
        'local_write_scope_lock',
        { id: Number(lock.id) },
        {
          installation_id: String(lock.installation_id),
          organization_id: Number(lock.organization_id),
        },
      );
    }
  }

  /** 任务 10 的实际查询服务读回该恢复的审计事件 */
  async function readRestoreEvents(
    restoreId: string,
    scopeOrganizationId: number | null,
  ): Promise<
    Array<{
      eventId: string;
      actorAccountId: number;
      actorAdminLevel: number;
      organizationId: number | null;
      operation: string;
      targetId: string;
      result: string;
      detail: unknown;
    }>
  > {
    const page = await auditQuery.listEvents({
      organizationId: scopeOrganizationId,
      pagination: { page: 1, pageSize: 50, withTotal: true },
    });
    return page.items
      .filter((item) => item.targetType === 'LOCAL_RESTORE' && item.targetId === restoreId)
      .map((item) => ({
        eventId: item.eventId,
        actorAccountId: item.actorAccountId,
        actorAdminLevel: item.actorAdminLevel,
        organizationId: item.organizationId,
        operation: item.operation,
        targetId: item.targetId,
        result: item.result,
        detail: item.detail,
      }));
  }

  const sessionFor = (accountId: number) =>
    ({
      accountId,
      organizationId: null,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: null,
    }) as never;

  it('L2 二级管理员执行成功：终态审计事件的等级是 2（不是一级）', async () => {
    const restoreId = await seedRestore({ tag: 'l2-success', accountId: level2AccountId });

    const outcome = await usecase.execute({
      session: sessionFor(level2AccountId),
      restoreId,
    });
    // 登记本次恢复产生的真实审计/冻结/范围锁事实（收尾精确回收）
    await registerRestoreFacts({ restoreId });

    expect(outcome.status).toBe('SUCCEEDED');

    // 任务 10 读侧：本公司二级管理员看到的事件，等级必须是 2
    const events = await readRestoreEvents(restoreId, organizationId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorAccountId).toBe(level2AccountId);
      expect(event.actorAdminLevel).toBe(2);
    }
  });

  it('L1 一级管理员执行成功：终态审计事件的等级是 1', async () => {
    const restoreId = await seedRestore({ tag: 'l1-success', accountId: level1AccountId });

    const outcome = await usecase.execute({
      session: sessionFor(level1AccountId),
      restoreId,
    });
    await registerRestoreFacts({ restoreId });

    expect(outcome.status).toBe('SUCCEEDED');

    // 一级是全局范围：用 null 读回
    const events = await readRestoreEvents(restoreId, null);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorAccountId).toBe(level1AccountId);
      expect(event.actorAdminLevel).toBe(1);
    }
  });

  it('L3 二级管理员执行失败（受控写入失败）：失败终态审计事件的等级也是 2', async () => {
    // 故障注入：载荷里放一行违反库级 CHECK 的业务行 ⇒ 写回必然失败
    const payload = emptyPayload();
    payload['local_upload_task'] = [
      {
        recordUuid: null,
        sourceVersion: null,
        taskKind: 'BACKUP_UPLOAD',
        manifestChecksum: null,
        organizationId,
        accountId: level2AccountId,
        installationId,
        entityType: 'NOT_A_VALID_ENTITY_TYPE',
        entityLocalId: 900001,
        entityVersion: 'v-task09-p2',
        idempotencyKey: `task09-p2-fail-${randomUUID()}`,
        status: 'PENDING',
        attemptCount: 0,
        lastAttemptAt: null,
        remoteId: null,
        remoteReceipt: null,
        errorCode: null,
        errorMessage: null,
      },
    ];
    const scopeRowCounts = scopeCounts();
    scopeRowCounts['local_upload_task'] = 1;

    const restoreId = await seedRestore({
      tag: 'l2-failure',
      accountId: level2AccountId,
      payload,
      scopeRowCounts,
    });

    const outcome = await usecase.execute({
      session: sessionFor(level2AccountId),
      restoreId,
    });
    await registerRestoreFacts({ restoreId });

    expect(outcome.status).toBe('FAILED');

    const events = await readRestoreEvents(restoreId, organizationId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorAccountId).toBe(level2AccountId);
      expect(event.actorAdminLevel).toBe(2);
      expect(event.result).toBe('FAILED');
    }
  });

  it('L4 授权可见：外公司二级管理员看不到本公司事件；一级看得到', async () => {
    const restoreId = await seedRestore({ tag: 'l2-visibility', accountId: level2AccountId });

    await usecase.execute({ session: sessionFor(level2AccountId), restoreId });
    await registerRestoreFacts({ restoreId });

    // 本公司二级管理员：可见
    expect((await readRestoreEvents(restoreId, organizationId)).length).toBeGreaterThan(0);
    // 外公司二级管理员：不可见（外公司数据区看不到本公司事件）
    expect((await readRestoreEvents(restoreId, 999999)).length).toBe(0);
    // 一级管理员（全局）：可见
    expect((await readRestoreEvents(restoreId, null)).length).toBeGreaterThan(0);
  });
});
