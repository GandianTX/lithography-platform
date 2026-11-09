import * as fs from 'fs';

import type { DataSource } from 'typeorm';

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

export interface DeployCliOptions {
  readonly mode: DeployMode;
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase: string;
  readonly organizationBootstrapFile?: string;
  readonly confirmOrganizationBootstrap?: string;
  readonly adminBootstrapFile?: string;
  readonly confirmAdminBootstrap?: string;
  readonly devAccountsFile?: string;
  readonly confirmDevAccounts?: string;
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
const LEGACY_REPAIR_MANIFEST_OPTION = '--legacy-repair-manifest';
const ORGANIZATION_BOOTSTRAP_CONFIRM_VALUE = 'APPLY-ORGANIZATION-BOOTSTRAP';
const ADMIN_BOOTSTRAP_CONFIRM_VALUE = 'APPLY-ADMIN-BOOTSTRAP';
const DEV_ACCOUNTS_CONFIRM_VALUE = 'APPLY-DEV-ACCOUNTS';

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
      confirmDevAccounts
    ) {
      throw new Error(
        '初始化数据（组织/管理员/开发账号）只允许在 init 模式执行；upgrade 模式拒绝这些参数',
      );
    }
    return {
      mode,
      envFile,
      database,
      confirmDatabase,
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

  if (devAccountsFile) {
    if (confirmDevAccounts !== DEV_ACCOUNTS_CONFIRM_VALUE) {
      throw new Error(
        `启用开发账号初始化时必须提供 ${CONFIRM_DEV_ACCOUNTS_OPTION}=${DEV_ACCOUNTS_CONFIRM_VALUE}`,
      );
    }
    // 开发样例账号只允许落到明确的开发/测试目标库，正式库名直接拒绝。
    assertDevAccountTargetDatabase(database);
  } else if (confirmDevAccounts) {
    throw new Error(`${CONFIRM_DEV_ACCOUNTS_OPTION} 必须与 ${DEV_ACCOUNTS_FILE_OPTION} 一起使用`);
  }

  return {
    mode,
    envFile,
    database,
    confirmDatabase,
    ...(organizationBootstrapFile
      ? { organizationBootstrapFile, confirmOrganizationBootstrap }
      : {}),
    ...(adminBootstrapFile ? { adminBootstrapFile, confirmAdminBootstrap } : {}),
    ...(devAccountsFile ? { devAccountsFile, confirmDevAccounts } : {}),
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
}

interface InitializationDataResult {
  readonly organizations: ReadonlyArray<OrganizationBootstrapResult> | null;
  readonly admins: ReadonlyArray<AdminBootstrapResult> | null;
  readonly devAccounts: ReadonlyArray<DevAccountBootstrapResult> | null;
}

/**
 * 组织、管理员、开发账号在同一事务中应用：任一账号失败时三部分都不留半成品。
 * 三者写入顺序固定为 组织 → 管理员 → 开发账号，避免账号引用尚未创建的公司。
 */
async function applyInitializationData(
  dataSource: DataSource,
  config: MigrationDbConfig,
  initialization: InitializationDataConfig,
): Promise<InitializationDataResult> {
  const hasAny =
    initialization.organizationBootstrap !== null ||
    initialization.adminBootstrap !== null ||
    initialization.devAccounts !== null;
  if (!hasAny) {
    return { organizations: null, admins: null, devAccounts: null };
  }

  return dataSource.transaction(async (manager) => {
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

    return { organizations, admins, devAccounts };
  });
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

  const initialized = await applyInitializationData(dataSource, config, initialization);
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

  return {
    mode: 'init',
    target,
    executed,
    verification,
    noChanges: executed.length === 0,
    organizationBootstrap: initialized.organizations,
    adminBootstrap: initialized.admins,
    devAccounts: initialized.devAccounts,
  };
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
  const initialization: InitializationDataConfig = {
    organizationBootstrap: options.organizationBootstrapFile
      ? loadOrganizationBootstrapFile(options.organizationBootstrapFile)
      : null,
    adminBootstrap: options.adminBootstrapFile
      ? loadAdminBootstrapFile(options.adminBootstrapFile)
      : null,
    devAccounts: options.devAccountsFile ? loadDevAccountsFile(options.devAccountsFile) : null,
  };
  if (initialization.devAccounts !== null) {
    // 编程式调用可能绕过 CLI 解析，这里再次确认目标库不是正式库。
    assertDevAccountTargetDatabase(config.database);
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

    report =
      options.mode === 'init'
        ? await runInit(dataSource, config, logger, dependencies, initialization)
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
async function runUpgradeDeploy(
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
  };
}

export { getCleanupErrors };
