import * as fs from 'fs';

import type { DataSource, EntityManager } from 'typeorm';

import {
  type AdminBootstrapConfig,
  type AdminBootstrapResult,
  applyAdminBootstrap,
  parseAdminBootstrapConfig,
} from './admin-bootstrap';
import {
  type DevAccountBootstrapConfig,
  type DevAccountBootstrapResult,
  applyDevAccountBootstrap,
  assertDevAccountTargetDatabase,
  parseDevAccountBootstrapConfig,
} from './dev-account-bootstrap';
import {
  DEV_DATA_CONFIRMATION,
  type DevDataBootstrapResult,
  type DevDataConfig,
  applyDevDataBootstrap,
  containsDevSampleFiles,
  parseDevDataConfig,
} from './dev-data-bootstrap';
import {
  type DevSampleDirectoryOwnership,
  type DevSampleFileClaim,
  assertDevSampleFilesDirectory,
  assertDevSamplePublicationStable,
  claimDevSampleFilesDirectory,
  deleteDevSampleFile,
} from './dev-sample-files';
import {
  type OrganizationBootstrapConfig,
  type OrganizationBootstrapResult,
  applyOrganizationBootstrap,
  parseOrganizationBootstrapConfig,
} from './organization-bootstrap';
import {
  loadLegacyRepairIdentityManifestFile,
  resetLegacyRepairIdentityManifest,
  setLegacyRepairIdentityManifest,
} from './legacy-repair-identity-manifest';
import {
  MigrationCleanupError,
  acquireMigrationLock,
  attachCleanupErrors,
  classifyHistoryIssues,
  collectCleanupErrors,
  collectStructuralIssues,
  createMigrationDataSource,
  executePendingMigrations,
  getCleanupErrors,
  inspectMigrationState,
  loadExplicitEnvConfig,
  readAndAssertTarget,
  readBaseTableNames,
  readMigrationHistory,
  readRepositoryMigrations,
  verifyMigrationState,
  type MigrationDbConfig,
  type MigrationLogger,
  type MigrationState,
  type MigrationTarget,
  type VerificationReport,
} from './incremental-migration';

export type DeployMode = 'init' | 'upgrade';
export type DeployEnvironment = 'development' | 'production';

export interface DeployCliOptions {
  readonly mode: DeployMode;
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase: string;
  readonly environment?: DeployEnvironment;
  readonly expectServerUuid?: string;
  readonly confirmDevTarget?: string;
  readonly organizationBootstrapFile?: string;
  readonly confirmOrganizationBootstrap?: string;
  readonly adminBootstrapFile?: string;
  readonly confirmAdminBootstrap?: string;
  readonly devAccountsFile?: string;
  readonly confirmDevAccounts?: string;
  readonly devDataFile?: string;
  readonly confirmDevData?: string;
  readonly devSampleFilesDir?: string;
  readonly confirmDevSampleFiles?: string;
  readonly legacyRepairManifestFile?: string;
}

export interface DeployRunDependencies {
  readonly createDataSource: (config: MigrationDbConfig) => DataSource;
  readonly lockTimeoutSeconds: number;
  readonly migrationsDir?: string;
}

export interface DeployReport {
  readonly mode: DeployMode;
  readonly target: MigrationTarget;
  readonly executed: ReadonlyArray<string>;
  readonly verification: VerificationReport;
  readonly noChanges: boolean;
  readonly organizationBootstrap: ReadonlyArray<OrganizationBootstrapResult> | null;
  readonly adminBootstrap: ReadonlyArray<AdminBootstrapResult> | null;
  readonly devAccounts: ReadonlyArray<DevAccountBootstrapResult> | null;
  readonly devData: DevDataBootstrapResult | null;
}

const ENV_FILE_OPTION = '--config-file';
const DATABASE_OPTION = '--database';
const CONFIRM_DATABASE_OPTION = '--confirm-database';
const MODE_OPTION = '--mode';
const ORGANIZATION_BOOTSTRAP_FILE_OPTION = '--organization-bootstrap-file';
const CONFIRM_ORGANIZATION_BOOTSTRAP_OPTION = '--confirm-organization-bootstrap';
const ADMIN_BOOTSTRAP_FILE_OPTION = '--admin-bootstrap-file';
const CONFIRM_ADMIN_BOOTSTRAP_OPTION = '--confirm-admin-bootstrap';
const DEV_ACCOUNTS_FILE_OPTION = '--dev-accounts-file';
const CONFIRM_DEV_ACCOUNTS_OPTION = '--confirm-dev-accounts';
const ENVIRONMENT_OPTION = '--environment';
const EXPECT_SERVER_UUID_OPTION = '--expect-server-uuid';
const CONFIRM_DEV_TARGET_OPTION = '--confirm-dev-target';
const DEV_DATA_FILE_OPTION = '--dev-data-file';
const CONFIRM_DEV_DATA_OPTION = '--confirm-dev-data';
const DEV_SAMPLE_FILES_DIR_OPTION = '--dev-sample-files-dir';
const CONFIRM_DEV_SAMPLE_FILES_OPTION = '--confirm-dev-sample-files';
const LEGACY_REPAIR_MANIFEST_OPTION = '--legacy-repair-manifest';
const ORGANIZATION_BOOTSTRAP_CONFIRM_VALUE = 'APPLY-ORGANIZATION-BOOTSTRAP';
const ADMIN_BOOTSTRAP_CONFIRM_VALUE = 'APPLY-ADMIN-BOOTSTRAP';
const DEV_ACCOUNTS_CONFIRM_VALUE = 'APPLY-DEV-ACCOUNTS';
const SERVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NON_BUSINESS_TABLES = new Set(['migrations', 'typeorm_metadata']);

/**
 * 解析正式部署参数。
 *
 * 所有目标参数必须显式给出；init/upgrade 均要求二次确认库名；
 * 组织、管理员与开发样例初始化只能用于 init，且必须各自给出显式确认口令；
 * 开发样例还要求目标库名带开发标记。
 */
export function parseDeployCliArgs(argv: ReadonlyArray<string>): DeployCliOptions {
  const args = [...argv];
  let mode: DeployMode | undefined;
  let envFile: string | undefined;
  let database: string | undefined;
  let confirmDatabase: string | undefined;
  let organizationBootstrapFile: string | undefined;
  let confirmOrganizationBootstrap: string | undefined;
  let adminBootstrapFile: string | undefined;
  let confirmAdminBootstrap: string | undefined;
  let devAccountsFile: string | undefined;
  let confirmDevAccounts: string | undefined;
  let environment: DeployEnvironment | undefined;
  let expectServerUuid: string | undefined;
  let confirmDevTarget: string | undefined;
  let devDataFile: string | undefined;
  let confirmDevData: string | undefined;
  let devSampleFilesDir: string | undefined;
  let confirmDevSampleFiles: string | undefined;
  let legacyRepairManifestFile: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    if (typeof token !== 'string') {
      throw new Error('参数解析异常');
    }
    if (!token.startsWith('--')) {
      throw new Error(`不支持的位置参数: ${token}`);
    }
    const separatorIndex = token.indexOf('=');
    const option = separatorIndex >= 0 ? token.slice(0, separatorIndex) : token;
    const value = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : args.shift();
    if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
      throw new Error(`参数 ${option} 缺少有效值`);
    }

    switch (option) {
      case MODE_OPTION:
        if (value !== 'init' && value !== 'upgrade') {
          throw new Error('--mode 只接受 init 或 upgrade');
        }
        mode = value;
        break;
      case ENV_FILE_OPTION:
        envFile = value;
        break;
      case DATABASE_OPTION:
        database = value;
        break;
      case CONFIRM_DATABASE_OPTION:
        confirmDatabase = value;
        break;
      case ORGANIZATION_BOOTSTRAP_FILE_OPTION:
        organizationBootstrapFile = value;
        break;
      case CONFIRM_ORGANIZATION_BOOTSTRAP_OPTION:
        confirmOrganizationBootstrap = value;
        break;
      case ADMIN_BOOTSTRAP_FILE_OPTION:
        adminBootstrapFile = value;
        break;
      case CONFIRM_ADMIN_BOOTSTRAP_OPTION:
        confirmAdminBootstrap = value;
        break;
      case DEV_ACCOUNTS_FILE_OPTION:
        devAccountsFile = value;
        break;
      case CONFIRM_DEV_ACCOUNTS_OPTION:
        confirmDevAccounts = value;
        break;
      case ENVIRONMENT_OPTION:
        if (value !== 'development' && value !== 'production') {
          throw new Error(`${ENVIRONMENT_OPTION} 只接受 development 或 production`);
        }
        environment = value;
        break;
      case EXPECT_SERVER_UUID_OPTION:
        if (!SERVER_UUID_PATTERN.test(value.trim())) {
          throw new Error(`${EXPECT_SERVER_UUID_OPTION} 必须是 MySQL @@server_uuid 格式的 UUID`);
        }
        expectServerUuid = value.trim().toLowerCase();
        break;
      case CONFIRM_DEV_TARGET_OPTION:
        confirmDevTarget = value;
        break;
      case DEV_DATA_FILE_OPTION:
        devDataFile = value;
        break;
      case CONFIRM_DEV_DATA_OPTION:
        confirmDevData = value;
        break;
      case DEV_SAMPLE_FILES_DIR_OPTION:
        devSampleFilesDir = value;
        break;
      case CONFIRM_DEV_SAMPLE_FILES_OPTION:
        confirmDevSampleFiles = value;
        break;
      case LEGACY_REPAIR_MANIFEST_OPTION:
        legacyRepairManifestFile = value;
        break;
      default:
        throw new Error(`不支持的参数: ${option}`);
    }
  }

  if (!mode) {
    throw new Error(`必须显式指定 ${MODE_OPTION}=init 或 ${MODE_OPTION}=upgrade`);
  }
  if (!envFile) {
    throw new Error(`必须显式指定 ${ENV_FILE_OPTION}，不会自动回落其他环境文件`);
  }
  if (!database) {
    throw new Error(`必须显式指定 ${DATABASE_OPTION}`);
  }
  if (!confirmDatabase || confirmDatabase !== database) {
    throw new Error(`必须提供一致的 ${CONFIRM_DATABASE_OPTION} 再次确认目标库`);
  }

  if (mode === 'upgrade') {
    if (
      organizationBootstrapFile ||
      confirmOrganizationBootstrap ||
      adminBootstrapFile ||
      confirmAdminBootstrap ||
      devAccountsFile ||
      confirmDevAccounts ||
      devDataFile ||
      confirmDevData ||
      devSampleFilesDir ||
      confirmDevSampleFiles ||
      confirmDevTarget
    ) {
      throw new Error(
        '初始化数据（组织/管理员/开发账号/开发样例）只允许在 init 模式执行；upgrade 模式拒绝这些参数',
      );
    }
    return {
      mode,
      envFile,
      database,
      confirmDatabase,
      ...(environment ? { environment } : {}),
      ...(expectServerUuid ? { expectServerUuid } : {}),
      ...(legacyRepairManifestFile ? { legacyRepairManifestFile } : {}),
    };
  }

  if (organizationBootstrapFile) {
    if (confirmOrganizationBootstrap !== ORGANIZATION_BOOTSTRAP_CONFIRM_VALUE) {
      throw new Error(
        `启用组织初始化时必须提供 ${CONFIRM_ORGANIZATION_BOOTSTRAP_OPTION}=${ORGANIZATION_BOOTSTRAP_CONFIRM_VALUE}`,
      );
    }
  } else if (confirmOrganizationBootstrap) {
    throw new Error(
      `${CONFIRM_ORGANIZATION_BOOTSTRAP_OPTION} 必须与 ${ORGANIZATION_BOOTSTRAP_FILE_OPTION} 一起使用`,
    );
  }

  if (adminBootstrapFile) {
    if (confirmAdminBootstrap !== ADMIN_BOOTSTRAP_CONFIRM_VALUE) {
      throw new Error(
        `启用管理员初始化时必须提供 ${CONFIRM_ADMIN_BOOTSTRAP_OPTION}=${ADMIN_BOOTSTRAP_CONFIRM_VALUE}`,
      );
    }
  } else if (confirmAdminBootstrap) {
    throw new Error(
      `${CONFIRM_ADMIN_BOOTSTRAP_OPTION} 必须与 ${ADMIN_BOOTSTRAP_FILE_OPTION} 一起使用`,
    );
  }

  const hasDevInitialization = Boolean(devAccountsFile || devDataFile);
  if (
    environment === 'production' &&
    (hasDevInitialization || confirmDevTarget || devSampleFilesDir || confirmDevSampleFiles)
  ) {
    throw new Error('production 环境不允许开发账号、开发联调样例或开发目标确认');
  }
  if (hasDevInitialization && environment !== 'development') {
    throw new Error(
      `开发账号/开发联调样例必须显式提供 ${ENVIRONMENT_OPTION}=development；生产入口拒绝开发数据`,
    );
  }
  if (confirmDevTarget && environment !== 'development') {
    throw new Error(
      `${CONFIRM_DEV_TARGET_OPTION} 只能与 ${ENVIRONMENT_OPTION}=development 一起使用`,
    );
  }
  if (hasDevInitialization) {
    if (!expectServerUuid) {
      throw new Error(
        `开发账号/开发联调样例必须提供 ${EXPECT_SERVER_UUID_OPTION}，以实例 UUID 独立核对目标`,
      );
    }
    if (confirmDevTarget !== database) {
      throw new Error(
        `开发账号/开发联调样例必须提供与目标库一致的 ${CONFIRM_DEV_TARGET_OPTION}=${database}`,
      );
    }
    // 开发样例只允许落到明确的开发/测试目标库；现有共享验收库在写入前直接拒绝。
    assertDevAccountTargetDatabase(database);
  }

  if (devAccountsFile) {
    if (confirmDevAccounts !== DEV_ACCOUNTS_CONFIRM_VALUE) {
      throw new Error(
        `启用开发账号初始化时必须提供 ${CONFIRM_DEV_ACCOUNTS_OPTION}=${DEV_ACCOUNTS_CONFIRM_VALUE}`,
      );
    }
  } else if (confirmDevAccounts) {
    throw new Error(`${CONFIRM_DEV_ACCOUNTS_OPTION} 必须与 ${DEV_ACCOUNTS_FILE_OPTION} 一起使用`);
  }

  if (devDataFile) {
    if (confirmDevData !== DEV_DATA_CONFIRMATION) {
      throw new Error(
        `启用开发联调样例时必须提供 ${CONFIRM_DEV_DATA_OPTION}=${DEV_DATA_CONFIRMATION}`,
      );
    }
  } else if (confirmDevData) {
    throw new Error(`${CONFIRM_DEV_DATA_OPTION} 必须与 ${DEV_DATA_FILE_OPTION} 一起使用`);
  }

  if (devSampleFilesDir) {
    if (!devDataFile) {
      throw new Error(`${DEV_SAMPLE_FILES_DIR_OPTION} 只能与 ${DEV_DATA_FILE_OPTION} 一起使用`);
    }
    if (confirmDevSampleFiles !== devSampleFilesDir) {
      throw new Error(
        `启用开发样例原件时必须提供与 ${DEV_SAMPLE_FILES_DIR_OPTION} 一致的 ${CONFIRM_DEV_SAMPLE_FILES_OPTION}`,
      );
    }
  } else if (confirmDevSampleFiles) {
    throw new Error(
      `${CONFIRM_DEV_SAMPLE_FILES_OPTION} 必须与 ${DEV_SAMPLE_FILES_DIR_OPTION} 一起使用`,
    );
  }

  return {
    mode,
    envFile,
    database,
    confirmDatabase,
    ...(environment ? { environment } : {}),
    ...(expectServerUuid ? { expectServerUuid } : {}),
    ...(confirmDevTarget ? { confirmDevTarget } : {}),
    ...(organizationBootstrapFile
      ? { organizationBootstrapFile, confirmOrganizationBootstrap }
      : {}),
    ...(adminBootstrapFile ? { adminBootstrapFile, confirmAdminBootstrap } : {}),
    ...(devAccountsFile ? { devAccountsFile, confirmDevAccounts } : {}),
    ...(devDataFile ? { devDataFile, confirmDevData } : {}),
    ...(devSampleFilesDir ? { devSampleFilesDir, confirmDevSampleFiles } : {}),
    ...(legacyRepairManifestFile ? { legacyRepairManifestFile } : {}),
  };
}

function loadAdminBootstrapFile(filePath: string): AdminBootstrapConfig {
  return parseConfigFile(filePath, '管理员映射', parseAdminBootstrapConfig);
}

function loadOrganizationBootstrapFile(filePath: string): OrganizationBootstrapConfig {
  return parseConfigFile(filePath, '组织映射', parseOrganizationBootstrapConfig);
}

function loadDevAccountsFile(filePath: string): DevAccountBootstrapConfig {
  return parseConfigFile(filePath, '开发账号映射', parseDevAccountBootstrapConfig);
}

function loadDevDataFile(filePath: string): DevDataConfig {
  return parseConfigFile(filePath, '开发联调样例', parseDevDataConfig);
}

function parseConfigFile<T>(filePath: string, label: string, parse: (raw: string) => T): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}文件不存在: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`${label}文件为空: ${filePath}`);
  }
  return parse(content);
}

interface InitializationDataConfig {
  readonly organizationBootstrap: OrganizationBootstrapConfig | null;
  readonly adminBootstrap: AdminBootstrapConfig | null;
  readonly devAccounts: DevAccountBootstrapConfig | null;
  readonly devData: DevDataConfig | null;
  readonly devSampleFilesDir: string | null;
}

/**
 * 同一批次三个映射文件必须共享唯一的登录邮箱：管理员与开发账号之间也不能冲突。
 * 在写入前整体校验，避免依赖数据库唯一索引才在事务末段报错。
 */
export function assertInitializationEmailConflicts(
  adminBootstrap: AdminBootstrapConfig | null,
  devAccounts: DevAccountBootstrapConfig | null,
): void {
  const seen = new Map<string, string>();
  const add = (email: string | null, label: string): void => {
    if (email === null) {
      return;
    }
    const key = email.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(`初始化映射邮箱冲突 ${email}：${prior} 与 ${label}`);
    }
    seen.set(key, label);
  };

  for (const entry of adminBootstrap?.accounts ?? []) {
    add(entry.loginEmail, `管理员 ${entry.loginName}`);
  }
  for (const entry of devAccounts?.customers ?? []) {
    add(entry.loginEmail, `开发客户 ${entry.loginName}`);
  }
  for (const entry of devAccounts?.engineers ?? []) {
    add(entry.loginEmail, `开发工程师 ${entry.loginName}`);
  }
}

interface InitializationDataResult {
  readonly organizations: ReadonlyArray<OrganizationBootstrapResult> | null;
  readonly admins: ReadonlyArray<AdminBootstrapResult> | null;
  readonly devAccounts: ReadonlyArray<DevAccountBootstrapResult> | null;
  readonly devData: DevDataBootstrapResult | null;
}

export type InitializationTransactionState =
  'NOT_STARTED' | 'ROLLBACK_CONFIRMED' | 'COMMIT_CONFIRMED' | 'UNKNOWN';

export type InitializationTransactionPhase =
  'CONNECT' | 'BEGIN' | 'CALLBACK' | 'COMMIT' | 'ROLLBACK' | 'RELEASE';

export interface InitializationQueryRunner {
  readonly manager: EntityManager;
  connect(): Promise<void>;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
  /** 可选：销毁本轮专用连接；BEGIN 未确认时禁止普通归池。 */
  destroy?(): Promise<void> | void;
}

export interface InitializationTransactionOptions<T> {
  readonly dataSource: Pick<DataSource, 'createQueryRunner'>;
  readonly database: string;
  readonly logger: MigrationLogger;
  readonly sampleFilesDir: string | null;
  /** 本轮成功取得句柄并登记对象身份的原件；只按事务终局报告，不自动删除。 */
  readonly claims: ReadonlyArray<DevSampleFileClaim>;
  readonly run: (manager: EntityManager) => Promise<T>;
  /** 回调完成后、发出 COMMIT 之前的核对；失败时不发 COMMIT，走既有回滚与保留策略。 */
  readonly assertPreCommit?: () => Promise<void> | void;
  readonly probeReference?: (
    storageReference: string,
    queryRunner: InitializationQueryRunner,
  ) => Promise<boolean>;
  readonly removeSampleFile?: (claim: DevSampleFileClaim) => Promise<'DELETED' | 'RETAINED'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error });
}

async function probeSampleFileReference(
  storageReference: string,
  queryRunner: InitializationQueryRunner,
): Promise<boolean> {
  const rows: unknown = await queryRunner.manager.query(
    'SELECT 1 FROM `reference_document` WHERE `storage_reference` = ? LIMIT 1',
    [storageReference],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 用本轮独占 QueryRunner 执行初始化事务，并按可证明的终局报告原件处置。
 *
 * 事务终局只有四种：未开始、已确认回滚、已确认提交、结果未知。
 * - 共享原件目录没有可证明的独占删除边界，任何终局都不按路径自动删除原件；
 * - 明确回滚且引用探测未命中时仍保留文件，输出路径、事务终局与人工处置原因；
 * - COMMIT 已发出但回执丢失时，即使随后 ROLLBACK 返回成功，也不得当作原提交未生效；
 * - 回滚抛错、状态未知时保留原件，输出库名、事务阶段、待处置引用与主错误；
 * - 状态未知的连接不归还连接池；关闭/清理失败单独诊断，不覆盖主错误。
 */
export async function runInitializationDataTransaction<T>(
  options: InitializationTransactionOptions<T>,
): Promise<T> {
  const queryRunner = options.dataSource.createQueryRunner() as InitializationQueryRunner;
  let state: InitializationTransactionState = 'NOT_STARTED';
  let phase: InitializationTransactionPhase = 'CONNECT';
  let connected = false;
  let beginAttempted = false;
  let transactionStarted = false;
  let commitAttempted = false;
  let mainError: unknown = null;
  let result: T | null = null;
  const cleanupErrors: string[] = [];

  try {
    await queryRunner.connect();
    connected = true;
    phase = 'BEGIN';
    // 记录已尝试必须早于调用：BEGIN 可能已在服务端生效而调用方未收到回执。
    beginAttempted = true;
    await queryRunner.startTransaction();
    transactionStarted = true;
    phase = 'CALLBACK';
    result = await options.run(queryRunner.manager);
    // 回调完成后、标记 COMMIT 已尝试之前核对文件系统前提：
    // 目录绑定、归属标记与已发布正式目录项任一变化即失败，不发出 COMMIT。
    await options.assertPreCommit?.();
    phase = 'COMMIT';
    commitAttempted = true;
    await queryRunner.commitTransaction();
    state = 'COMMIT_CONFIRMED';
  } catch (error) {
    mainError = error;
    if (beginAttempted && !transactionStarted && !commitAttempted) {
      // BEGIN 可能已在服务端生效：进入 UNKNOWN / BEGIN，禁止普通归池。
      // 不能以 isTransactionActive 或退出后事务数反推 BEGIN 未生效。
      state = 'UNKNOWN';
      cleanupErrors.push(
        `BEGIN 已尝试但未取得确认回执 connection=${connected ? 'ESTABLISHED' : 'NOT_ESTABLISHED'} ` +
          `begin=ATTEMPTED_UNCONFIRMED transaction=UNCONFIRMED ` +
          `state=UNKNOWN phase=BEGIN`,
      );
    } else if (transactionStarted && !commitAttempted) {
      phase = 'ROLLBACK';
      try {
        await queryRunner.rollbackTransaction();
        state = 'ROLLBACK_CONFIRMED';
      } catch (rollbackError) {
        state = 'UNKNOWN';
        cleanupErrors.push(`ROLLBACK 未取得成功回执：${errorMessage(rollbackError)}`);
      }
    } else if (transactionStarted && commitAttempted) {
      // COMMIT 已发出，回执丢失：提交是否生效不可证明，禁止再以任何回滚结果反推。
      state = 'UNKNOWN';
      cleanupErrors.push('COMMIT 已发出但结果未知，禁止用其他连接或回滚结果推断未提交');
    } else {
      state = 'NOT_STARTED';
    }
  }

  if (mainError !== null && options.claims.length > 0 && options.sampleFilesDir !== null) {
    if (state !== 'ROLLBACK_CONFIRMED') {
      const retainedPaths = options.claims.map((claim) => claimPaths(claim).join('|')).join(', ');
      cleanupErrors.push(
        `初始化事务未确认，保留本轮样例原件 state=${state} phase=${phase} paths=[${retainedPaths}] ` +
          `原因=事务终局未确认且共享原件目录无独占删除边界，须人工核对后处置`,
      );
      options.logger.error(
        `初始化事务未确认，保留本轮样例原件 database=${options.database} ` +
          `state=${state} phase=${phase} refs=[${options.claims
            .map((claim) => claim.storageReference)
            .join(', ')}] paths=[${retainedPaths}] ` +
          `原因=事务终局未确认且共享原件目录无独占删除边界，须人工核对后处置 ` +
          `mainError=${errorMessage(mainError)}`,
      );
    } else {
      const removeSampleFile = options.removeSampleFile ?? deleteDevSampleFile;
      const probeReference = options.probeReference ?? probeSampleFileReference;
      for (const claim of options.claims) {
        let referenced: boolean;
        try {
          referenced = await probeReference(claim.storageReference, queryRunner);
        } catch (probeError) {
          cleanupErrors.push(
            `原件引用探测失败，已保留现场 ${claim.filePath}：${errorMessage(probeError)}`,
          );
          options.logger.error(
            `开发样例原件引用探测失败，保留文件待人工核查 storageReference=${claim.storageReference}：${errorMessage(
              probeError,
            )}`,
          );
          continue;
        }
        if (referenced) {
          cleanupErrors.push(
            `原件仍被正式资料引用，已保留现场 ${claim.filePath}（storageReference=${claim.storageReference}）`,
          );
          options.logger.error(
            `已确认回滚但原件仍被引用，保留文件待人工核查 storageReference=${claim.storageReference}`,
          );
          continue;
        }
        try {
          const removal = await removeSampleFile(claim);
          const paths = claimPaths(claim).join('|');
          if (removal === 'RETAINED') {
            cleanupErrors.push(
              `共享原件目录无独占删除边界，按安全策略保留原件 state=ROLLBACK_CONFIRMED ` +
                `phase=ROLLBACK paths=[${paths}]；数据库已确认不再引用，仍须人工核对后处置`,
            );
            options.logger.error(
              `开发样例原件按安全策略保留，待人工处置 database=${options.database} ` +
                `state=ROLLBACK_CONFIRMED phase=ROLLBACK ` +
                `storageReference=${claim.storageReference} paths=[${paths}] ` +
                `原因=共享原件目录无法证明核对与删除之间目录项未被其他写入方替换`,
            );
          } else {
            options.logger.info(
              `初始化事务已确认回滚，未发现待处置的开发样例原件 ` +
                `storageReference=${claim.storageReference}`,
            );
          }
        } catch (deleteError) {
          cleanupErrors.push(
            `原件收尾处置失败，已保留现场 ${claim.filePath}：${errorMessage(deleteError)}`,
          );
          options.logger.error(
            `开发样例原件收尾处置失败，存在需人工处置的路径 file=${claim.filePath}：${errorMessage(
              deleteError,
            )}`,
          );
        }
      }
    }
  }

  if (state === 'COMMIT_CONFIRMED' && options.claims.length > 0) {
    // 成功发布后的暂存硬链接不再自动 unlink：共享目录同样没有独占删除边界。
    // 已确认提交时不把该保留计入清理失败，只报告路径供人工处置。
    const stagingPaths = [...new Set(options.claims.map((claim) => claim.stagingPath))];
    options.logger.info(
      `初始化数据已确认提交，开发样例原件暂存硬链接按安全策略保留 ` +
        `database=${options.database} state=COMMIT_CONFIRMED phase=COMMIT ` +
        `paths=[${stagingPaths.join('|')}]`,
    );
  }

  // 关闭句柄与删除文件是两件事：所有分支都在收尾决定后关闭本轮句柄。
  for (const claim of options.claims) {
    try {
      await claim.close();
    } catch (closeError) {
      cleanupErrors.push(
        `关闭原件句柄失败，已保留现场 ${claimPaths(claim).join('|')}：${errorMessage(closeError)}`,
      );
    }
  }

  if (state === 'UNKNOWN') {
    const message = `初始化事务状态未确认，连接不归还连接池 database=${options.database} phase=${phase}`;
    cleanupErrors.push(message);
    options.logger.error(message);
    await disposeUnconfirmedConnection(queryRunner, cleanupErrors, options.logger);
  } else {
    phase = 'RELEASE';
    try {
      await queryRunner.release();
    } catch (releaseError) {
      cleanupErrors.push(`释放初始化查询连接失败：${errorMessage(releaseError)}`);
    }
  }

  if (mainError !== null) {
    throw attachCleanupErrors(mainError, cleanupErrors);
  }
  if (state !== 'COMMIT_CONFIRMED') {
    throw attachCleanupErrors(
      new Error(`初始化事务终局未确认：state=${state} phase=${phase}`),
      cleanupErrors,
    );
  }
  if (cleanupErrors.length > 0) {
    // 数据已确认提交，但连接收尾失败必须单独诊断，不能静默当作成功。
    const message = `初始化数据已确认提交，但连接收尾失败 database=${options.database} phase=${phase}`;
    for (const cleanupError of cleanupErrors) {
      options.logger.error(`${message}：${cleanupError}`);
    }
    throw attachCleanupErrors(new Error(message), cleanupErrors);
  }
  return result as T;
}

function claimPaths(claim: DevSampleFileClaim): string[] {
  const paths = [claim.stagingPath, claim.finalPath].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return [...new Set(paths)];
}

/**
 * BEGIN 未确认或终局未知时，本轮专用连接不得普通 release 回池。
 *
 * 优先使用 QueryRunner 自身销毁能力，其次销毁其独占 databaseConnection；
 * 两者都不可用时仅记录诊断并保留连接，由进程退出处置。
 */
async function disposeUnconfirmedConnection(
  queryRunner: InitializationQueryRunner,
  cleanupErrors: string[],
  logger: MigrationLogger,
): Promise<void> {
  const ownDestroy =
    typeof queryRunner.destroy === 'function' ? () => queryRunner.destroy?.() : null;
  const connection = (
    queryRunner as unknown as {
      readonly databaseConnection?: { destroy?: () => Promise<void> | void };
    }
  ).databaseConnection;
  const destroy =
    ownDestroy ?? (typeof connection?.destroy === 'function' ? () => connection.destroy?.() : null);
  if (destroy === null) {
    const message = '无法销毁未确认的初始化专用连接，已保留连接不归池';
    cleanupErrors.push(message);
    logger.error(message);
    return;
  }
  try {
    await destroy();
    logger.info('已销毁未确认的初始化专用连接，未执行普通归池');
  } catch (destroyError) {
    const message = `销毁未确认的初始化专用连接失败：${errorMessage(destroyError)}`;
    cleanupErrors.push(message);
    logger.error(message);
  }
}

/**
 * 组织、管理员、开发账号与开发联调样例在同一事务中应用：任一步失败时都不留半成品。
 * 写入顺序固定为 组织 → 管理员 → 开发账号 → 业务样例，避免样例引用尚未创建的账号/公司。
 *
 * 样例原件只在取得排他句柄并登记对象身份后计入本轮；事务失败时由
 * `runInitializationDataTransaction` 保留文件并报告路径、终局与人工处置原因。
 */
async function applyInitializationData(
  dataSource: DataSource,
  config: MigrationDbConfig,
  initialization: InitializationDataConfig,
  logger: MigrationLogger,
  serverUuid: string | null,
): Promise<InitializationDataResult> {
  const hasAny =
    initialization.organizationBootstrap !== null ||
    initialization.adminBootstrap !== null ||
    initialization.devAccounts !== null ||
    initialization.devData !== null;
  if (!hasAny) {
    return { organizations: null, admins: null, devAccounts: null, devData: null };
  }

  assertInitializationEmailConflicts(initialization.adminBootstrap, initialization.devAccounts);

  const hasSampleFiles =
    initialization.devData !== null && containsDevSampleFiles(initialization.devData);
  let directoryOwnership: DevSampleDirectoryOwnership | null = null;
  if (hasSampleFiles) {
    if (initialization.devSampleFilesDir === null) {
      throw new Error('开发样例声明了资料原件，但未提供目标库专属原件目录');
    }
    // 目录守卫与归属认领先于事务与文件写入：共享根、符号链接、非目标库目录、
    // 无可信归属的非空旧目录都在此失败关闭。
    assertDevSampleFilesDirectory(initialization.devSampleFilesDir, config.database);
    if (serverUuid === null) {
      throw new Error('开发样例原件写入前必须核对实际实例 UUID 并认领目录归属');
    }
    directoryOwnership = await claimDevSampleFilesDirectory(
      initialization.devSampleFilesDir,
      config.database,
      serverUuid,
    );
  }

  const createdSampleFiles: DevSampleFileClaim[] = [];
  const claimedOwnership = directoryOwnership;
  let mainError: unknown = null;
  let result: InitializationDataResult | null = null;
  try {
    result = await runInitializationDataTransaction({
      dataSource,
      database: config.database,
      logger,
      sampleFilesDir: initialization.devSampleFilesDir,
      claims: createdSampleFiles,
      assertPreCommit:
        claimedOwnership === null
          ? undefined
          : () => assertDevSamplePublicationStable(claimedOwnership, createdSampleFiles),
      run: async (manager) => {
        const organizations = initialization.organizationBootstrap
          ? await applyOrganizationBootstrap(manager, initialization.organizationBootstrap)
          : null;

        const admins =
          initialization.adminBootstrap === null
            ? null
            : await applyAdminBootstrap(
                dataSource,
                initialization.adminBootstrap,
                {
                  fieldEncryptionKey: config.fieldEncryptionKey,
                  fieldEncryptionIv: config.fieldEncryptionIv,
                },
                manager,
              );

        const devAccounts =
          initialization.devAccounts === null
            ? null
            : await applyDevAccountBootstrap(manager, initialization.devAccounts, {
                fieldEncryptionKey: config.fieldEncryptionKey,
                fieldEncryptionIv: config.fieldEncryptionIv,
              });

        const devData =
          initialization.devData === null
            ? null
            : await applyDevDataBootstrap(manager, initialization.devData, {
                sampleFilesDir: initialization.devSampleFilesDir,
                directoryOwnership,
                createdSampleFiles,
              });

        return { organizations, admins, devAccounts, devData };
      },
    });
  } catch (error) {
    mainError = error;
  }

  let ownershipCloseError: unknown = null;
  if (directoryOwnership !== null) {
    try {
      await directoryOwnership.close();
    } catch (error) {
      ownershipCloseError = error;
    }
  }

  if (mainError !== null) {
    if (ownershipCloseError !== null) {
      throw toError(
        attachCleanupErrors(mainError, [
          `关闭开发样例原件目录句柄失败：${errorMessage(ownershipCloseError)}`,
        ]),
      );
    }
    throw toError(mainError);
  }
  if (ownershipCloseError !== null) {
    throw new MigrationCleanupError([
      `关闭开发样例原件目录句柄失败：${errorMessage(ownershipCloseError)}`,
    ]);
  }
  if (result === null) {
    throw new Error('初始化数据未产生结果且未记录主因');
  }
  return result;
}

function businessTableNames(tables: ReadonlyArray<string>): ReadonlyArray<string> {
  return tables.filter((table) => !NON_BUSINESS_TABLES.has(table));
}

function assertNoUnknownBusinessTables(warnings: ReadonlyArray<string>): void {
  const unknown = warnings.filter((warning) => warning.startsWith('存在预期之外的业务表'));
  if (unknown.length > 0) {
    throw new Error(`目标库存在未知业务对象，拒绝 init：\n- ${unknown.join('\n- ')}`);
  }
}

/**
 * init：只接受“空库”或“已完整迁移且终态校验通过”的库。
 *
 * - 空库：执行全部迁移；
 * - 已有完整历史且 pending 为 0：终态校验通过后无变化返回；
 * - 非空但无历史、未知对象、半迁移、历史不完整：失败关闭，不猜测、不清库。
 */
async function runInit(
  dataSource: DataSource,
  config: MigrationDbConfig,
  logger: MigrationLogger,
  dependencies: DeployRunDependencies,
  initialization: InitializationDataConfig,
  serverUuid: string | null,
): Promise<DeployReport> {
  const target = await readAndAssertTarget(dataSource, config.database);
  const repository = readRepositoryMigrations(dataSource);
  const { history } = await readMigrationHistory(dataSource, config.database);
  const tables = await readBaseTableNames(dataSource, config.database);
  const businessTables = businessTableNames(tables);

  if (history.length > 0) {
    const historyIssues = classifyHistoryIssues(repository, history);
    if (historyIssues.length > 0) {
      throw new Error(`init 预检失败：\n- ${historyIssues.join('\n- ')}`);
    }
  }

  let state: MigrationState | null = null;
  if (businessTables.length > 0 || history.length > 0) {
    if (history.length === 0) {
      throw new Error(
        `目标库已存在业务表但没有任何迁移历史（${businessTables.join(', ')}），拒绝把“有旧表”推断为“迁移已执行”`,
      );
    }
    state = await inspectMigrationState(dataSource, config.database, dependencies.migrationsDir);
    if (state.issues.length > 0) {
      throw new Error(`init 预检发现半迁移/结构异常：\n- ${state.issues.join('\n- ')}`);
    }
    if (state.pending.length > 0) {
      throw new Error(
        `目标库已有迁移历史但仍有 pending（${state.pending.map((item) => item.name).join(', ')}），请使用 upgrade 模式`,
      );
    }
  }

  let executed: ReadonlyArray<string> = [];
  if (state === null) {
    logger.info(`目标为空库，准备执行 ${String(repository.length)} 条迁移`);
    executed = await executePendingMigrations(dataSource, repository);
    logger.info(`已执行 ${String(executed.length)} 条迁移`);
  } else {
    logger.info(`目标已完成迁移（历史 ${String(state.history.length)} 条），进入终态复核`);
  }

  const verification = await verifyMigrationState(dataSource, config.database);
  for (const warning of verification.warnings) {
    logger.warn(warning);
  }
  if (verification.issues.length > 0) {
    throw new Error(`init 终态校验失败：\n- ${verification.issues.join('\n- ')}`);
  }
  const structural = await collectStructuralIssues(dataSource, config.database);
  assertNoUnknownBusinessTables(structural.warnings);

  const afterState = await inspectMigrationState(
    dataSource,
    config.database,
    dependencies.migrationsDir,
  );
  if (afterState.pending.length !== 0) {
    throw new Error(
      `init 完成后仍存在 pending：${afterState.pending.map((item) => item.name).join(', ')}`,
    );
  }

  const initialized = await applyInitializationData(
    dataSource,
    config,
    initialization,
    logger,
    serverUuid,
  );
  for (const item of initialized.organizations ?? []) {
    logger.info(`组织初始化 ${item.organizationCode}（${item.kind}）：${item.outcome}`);
    if (item.nameMismatch) {
      logger.warn(
        `组织 ${item.organizationCode} 已存在但名称/简称与配置不同；已保留既有名称，未覆盖，请人工核对`,
      );
    }
  }
  for (const item of initialized.admins ?? []) {
    logger.info(
      `管理员映射 ${item.loginName} → 等级 ${String(item.adminLevel)} / 公司 ${item.organizationCode}：${item.outcome}`,
    );
  }
  for (const item of initialized.devAccounts ?? []) {
    logger.info(
      `开发样例账号 ${item.loginName}（${item.role}）/ 公司 ${item.organizationCode}：${item.outcome}`,
    );
  }
  if (initialized.devData !== null) {
    for (const item of initialized.devData.equipmentModels) {
      logger.info(`开发样例机型 ${item.key}：${item.outcome}`);
    }
    for (const item of initialized.devData.repairRequests) {
      logger.info(`开发样例工单 ${item.key}：${item.outcome}`);
    }
    for (const item of initialized.devData.maintenanceReports) {
      logger.info(`开发样例报告 ${item.key}：${item.outcome}`);
    }
    for (const item of initialized.devData.referenceDocuments) {
      logger.info(`开发样例资料 ${item.key}：${item.outcome}`);
      if (item.file !== null) {
        logger.info(
          `开发样例原件 ${item.key}：${item.file.state}，storageReference=${
            item.file.storageReference ?? '(无)'
          }，byteSize=${String(item.file.byteSize)}，sha256=${item.file.sha256}`,
        );
        if (
          item.file.state === 'MISSING' ||
          item.file.state === 'ABSENT' ||
          item.file.state === 'MISMATCH'
        ) {
          logger.warn(
            `开发样例资料 ${item.key} 的原件与模板不一致或缺失，已保留既有记录与文件，请人工核对`,
          );
        }
      }
    }
  }

  return {
    mode: 'init',
    target,
    executed,
    verification,
    noChanges: executed.length === 0,
    organizationBootstrap: initialized.organizations,
    adminBootstrap: initialized.admins,
    devAccounts: initialized.devAccounts,
    devData: initialized.devData,
  };
}

/**
 * 编程式入口的环境安全门：与 CLI 解析同口径，避免绕过解析把开发样例写入生产。
 */
function assertDeployEnvironmentOptions(options: DeployCliOptions, database: string): void {
  const environment = options.environment ?? 'production';
  const hasDevAccounts = options.devAccountsFile !== undefined;
  const hasDevData = options.devDataFile !== undefined;

  if (
    environment === 'production' &&
    (hasDevAccounts || hasDevData || options.confirmDevTarget || options.devSampleFilesDir)
  ) {
    throw new Error('production 环境不允许开发账号、开发联调样例或开发目标确认');
  }
  if ((hasDevAccounts || hasDevData) && environment !== 'development') {
    throw new Error('开发账号/开发联调样例必须显式指定 environment=development');
  }
  if (options.confirmDevTarget && environment !== 'development') {
    throw new Error('confirmDevTarget 只能用于 development 环境');
  }
  if (hasDevAccounts || hasDevData) {
    if (!options.expectServerUuid) {
      throw new Error('开发账号/开发联调样例必须提供 expectServerUuid 以独立核对目标实例');
    }
    if (options.confirmDevTarget !== database) {
      throw new Error(`开发账号/开发联调样例的 confirmDevTarget 必须与目标库 ${database} 一致`);
    }
    assertDevAccountTargetDatabase(database);
  }
  if (hasDevData && options.confirmDevData !== DEV_DATA_CONFIRMATION) {
    throw new Error(`开发联调样例必须提供 confirmDevData=${DEV_DATA_CONFIRMATION}`);
  }
  if (!hasDevData && options.confirmDevData) {
    throw new Error('confirmDevData 必须与 devDataFile 一起使用');
  }
  if (options.devSampleFilesDir) {
    if (!hasDevData) {
      throw new Error('devSampleFilesDir 只能与 devDataFile 一起使用');
    }
    if (options.confirmDevSampleFiles !== options.devSampleFilesDir) {
      throw new Error('confirmDevSampleFiles 必须与 devSampleFilesDir 完全一致');
    }
  } else if (options.confirmDevSampleFiles) {
    throw new Error('confirmDevSampleFiles 必须与 devSampleFilesDir 一起使用');
  }
}

async function readServerUuid(dataSource: DataSource): Promise<string> {
  const rows: unknown = await dataSource.query('SELECT @@server_uuid AS server_uuid');
  const row =
    Array.isArray(rows) && rows.length > 0 ? (rows[0] as { readonly server_uuid?: unknown }) : null;
  const value = row?.server_uuid;
  if (typeof value !== 'string' || !SERVER_UUID_PATTERN.test(value)) {
    throw new Error('无法读取目标实例 @@server_uuid，拒绝在未核对实例的情况下继续');
  }
  return value.toLowerCase();
}

/**
 * 正式部署入口：init 负责空库初始化/终态复核，upgrade 只运行 pending。
 * 两者都复用迁移互斥锁、实际目标核验与连接/锁收尾保护；不 drop、不 drill、不伪造历史。
 */
export async function runDatabaseDeploy(
  options: DeployCliOptions,
  logger: MigrationLogger,
  dependencies: DeployRunDependencies = {
    createDataSource: createMigrationDataSource,
    lockTimeoutSeconds: 0,
  },
): Promise<DeployReport> {
  const config = loadExplicitEnvConfig(options.envFile, options.database);
  assertDeployEnvironmentOptions(options, config.database);
  if (
    options.mode === 'upgrade' &&
    (options.organizationBootstrapFile ||
      options.adminBootstrapFile ||
      options.devAccountsFile ||
      options.devDataFile ||
      options.devSampleFilesDir)
  ) {
    throw new Error('upgrade 模式只执行待执行迁移，拒绝任何初始化数据文件');
  }
  const initialization: InitializationDataConfig = {
    organizationBootstrap: options.organizationBootstrapFile
      ? loadOrganizationBootstrapFile(options.organizationBootstrapFile)
      : null,
    adminBootstrap: options.adminBootstrapFile
      ? loadAdminBootstrapFile(options.adminBootstrapFile)
      : null,
    devAccounts: options.devAccountsFile ? loadDevAccountsFile(options.devAccountsFile) : null,
    devData: options.devDataFile ? loadDevDataFile(options.devDataFile) : null,
    devSampleFilesDir: options.devSampleFilesDir ?? null,
  };
  const hasSampleFiles =
    initialization.devData !== null && containsDevSampleFiles(initialization.devData);
  if (hasSampleFiles) {
    if (initialization.devSampleFilesDir === null) {
      throw new Error(
        '开发样例声明了资料原件，必须提供 --dev-sample-files-dir 并重复确认；已拒绝在连接数据库前继续',
      );
    }
    // 连接数据库前先做目录守卫：路径、库名、共享根与符号链接问题不进入任何写入
    assertDevSampleFilesDirectory(initialization.devSampleFilesDir, config.database);
  } else if (initialization.devSampleFilesDir !== null) {
    throw new Error('devSampleFilesDir 只能在开发样例包含原件时使用');
  }
  // 每次部署先清空进程内清单，避免上一次调用残留影响其他目标库。
  resetLegacyRepairIdentityManifest();
  if (options.legacyRepairManifestFile) {
    setLegacyRepairIdentityManifest(
      loadLegacyRepairIdentityManifestFile(options.legacyRepairManifestFile),
    );
  }

  const dataSource = dependencies.createDataSource(config);
  let initialized = false;
  let actualServerUuid: string | null = null;
  let lock: { release: () => Promise<void> } | null = null;
  let hasMainError = false;
  let mainError: unknown = null;
  let cleanupErrors: ReadonlyArray<string>;
  let report: DeployReport | null = null;

  try {
    await dataSource.initialize();
    initialized = true;
    lock = await acquireMigrationLock(
      dataSource,
      config.database,
      dependencies.lockTimeoutSeconds ?? 0,
    );
    const target = await readAndAssertTarget(dataSource, config.database);
    logger.info(
      `目标：${target.host}:${target.port}/${target.database}（MySQL ${target.serverVersion}）`,
    );
    if (options.expectServerUuid) {
      actualServerUuid = await readServerUuid(dataSource);
      if (actualServerUuid !== options.expectServerUuid.toLowerCase()) {
        throw new Error(
          `目标实例 UUID 不一致：期望 ${options.expectServerUuid.toLowerCase()}，实际 ${actualServerUuid}；已在首次写入前停止`,
        );
      }
      logger.info(`目标实例 UUID 已核对：${actualServerUuid}`);
    }

    report =
      options.mode === 'init'
        ? await runInit(dataSource, config, logger, dependencies, initialization, actualServerUuid)
        : await runUpgradeDeploy(dataSource, config, logger, dependencies);
  } catch (error: unknown) {
    hasMainError = true;
    mainError = error;
  } finally {
    const activeLock = lock;
    cleanupErrors = await collectCleanupErrors([
      ...(activeLock
        ? [{ name: '释放部署互斥锁', run: async (): Promise<void> => activeLock.release() }]
        : []),
      ...(initialized
        ? [
            {
              name: '关闭数据库连接',
              run: async (): Promise<void> => {
                await dataSource.destroy();
              },
            },
          ]
        : []),
    ]);
    for (const cleanupError of cleanupErrors) {
      logger.error(cleanupError);
    }
  }

  if (hasMainError) {
    throw attachCleanupErrors(mainError, cleanupErrors);
  }
  if (cleanupErrors.length > 0) {
    throw new MigrationCleanupError(cleanupErrors);
  }
  if (report === null) {
    throw new Error('部署未产生结果且未记录主因');
  }
  logger.info(
    report.noChanges
      ? `部署完成：无变化（历史完整、终态校验通过，业务表 ${String(report.verification.businessTableCount)} 张）`
      : `部署完成：执行 ${String(report.executed.length)} 条迁移，业务表 ${String(report.verification.businessTableCount)} 张`,
  );
  return report;
}

/**
 * upgrade：仅运行 pending；无 pending 时做终态校验并返回无变化。
 */
export async function runUpgradeDeploy(
  dataSource: DataSource,
  config: MigrationDbConfig,
  logger: MigrationLogger,
  dependencies: DeployRunDependencies,
): Promise<DeployReport> {
  const target = await readAndAssertTarget(dataSource, config.database);
  const state = await inspectMigrationState(
    dataSource,
    config.database,
    dependencies.migrationsDir,
  );
  for (const warning of state.warnings) {
    logger.warn(warning);
  }
  if (state.issues.length > 0) {
    throw new Error(`升级前预检失败：\n- ${state.issues.join('\n- ')}`);
  }
  logger.info(
    `历史 ${String(state.history.length)} 条，仓库 ${String(state.repository.length)} 条，pending ${String(state.pending.length)} 条`,
  );

  const executed =
    state.pending.length === 0 ? [] : await executePendingMigrations(dataSource, state.pending);
  if (executed.length > 0) {
    logger.info(`已执行 ${String(executed.length)} 条迁移`);
  }

  const verification = await verifyMigrationState(dataSource, config.database);
  for (const warning of verification.warnings) {
    logger.warn(warning);
  }
  if (verification.issues.length > 0) {
    throw new Error(`升级后校验失败：\n- ${verification.issues.join('\n- ')}`);
  }

  const afterState = await inspectMigrationState(
    dataSource,
    config.database,
    dependencies.migrationsDir,
  );
  if (afterState.pending.length !== 0) {
    throw new Error(
      `升级完成后仍存在 pending：${afterState.pending.map((item) => item.name).join(', ')}`,
    );
  }

  return {
    mode: 'upgrade',
    target,
    executed,
    verification,
    noChanges: executed.length === 0,
    organizationBootstrap: null,
    adminBootstrap: null,
    devAccounts: null,
    devData: null,
  };
}

export { getCleanupErrors };
