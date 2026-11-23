// scripts/task09-restore-selfcheck.safety.ts

/**
 * 任务 09 · 恢复自检入口的安全边界（**纯逻辑层**，可定向单测）。
 *
 * 独立验收 P1-3 的修复落点：原 `task09-restore-selfcheck.ts` 默认指向开发库、
 * 会覆盖既有设置／授权、起跑即释放既有冻结，并按数据库返回的路径递归删目录。
 * 本模块把三件事从脚本里抽出来，让它们**默认拒绝**且**可单测**：
 *
 *   1. **能不能跑**：必须显式给出一次性库、预期实例身份、一次性库标识、
 *      受控文件根、安装／公司标识与明确的测试授权；任一缺失即拒绝。
 *   2. **能改什么**：只允许改本轮创建的对象；预存冻结／既有授权／外部引用一律拦下。
 *   3. **能删什么**：文件删除限定在受控根内并逐条实名核对；
 *      数据库删除在同一事务内按"先子后父"执行，失败有可追溯结果。
 *
 * 父进程（`task09-restore-selfcheck.ts`）与中断子进程
 * （`task09-restore-interrupt-child.ts`）**共用同一份判定**：子进程独立复核，
 * 不只信任父进程传下来的参数。
 */

import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** 一次性库标识表（由建库方创建；脚本只读核对，不创建、不修改） */
export const DISPOSABLE_MARKER_TABLE = 'task09_disposable_marker';
/** 一次性库标识键名 */
export const DISPOSABLE_MARKER_KEY = 'task09-disposable-database';

/**
 * 明确的测试授权口令。
 *
 * 这是一个**不可被默认猜到**的固定串：没有显式给出它就等于没有授权，
 * 避免"顺手跑一下"落到真实库上。
 */
export const SELFCHECK_TEST_AUTHORIZATION = 'TASK09-RESTORE-SELFCHECK-ISOLATED-RUN';

/** 一次性库名约束：只允许 `lithography_task09_isolated_<后缀>` */
export const DISPOSABLE_DATABASE_PATTERN = /^lithography_task09_isolated_[a-z0-9_]{1,32}$/u;

/** 明确禁止的库名（即便命名像隔离库也拒绝） */
export const FORBIDDEN_DATABASE_NAMES: ReadonlySet<string> = new Set([
  'lithography_task09_dev',
  'lithography_task09_test',
  'lithography_e2e',
  'lithography_task09',
]);

/** 必填环境变量清单（缺任何一项都拒绝运行，不做默认值回落） */
export const REQUIRED_SELFCHECK_ENV_KEYS: ReadonlyArray<string> = [
  'TASK09_RESTORE_ENV_FILE',
  'TASK09_RESTORE_DATABASE',
  'TASK09_RESTORE_EXPECTED_HOST',
  'TASK09_RESTORE_EXPECTED_PORT',
  'TASK09_RESTORE_EXPECTED_SERVER_UUID',
  'TASK09_RESTORE_DISPOSABLE_MARKER',
  'TASK09_RESTORE_FILE_ROOT',
  'TASK09_RESTORE_INSTALLATION_ID',
  'TASK09_RESTORE_ORGANIZATION_ID',
  'TASK09_RESTORE_TEST_AUTHORIZATION',
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 自检入口的显式授权参数（全部来自环境变量，无默认值） */
export interface SelfcheckAuthorization {
  /** 环境文件路径（显式给出） */
  readonly envFile: string;
  /** 一次性隔离库名 */
  readonly database: string;
  /** 预期的数据库实例主机 */
  readonly expectedHost: string;
  /** 预期的数据库实例端口 */
  readonly expectedPort: number;
  /** 预期的数据库实例 UUID（MySQL `@@server_uuid`） */
  readonly expectedServerUuid: string;
  /** 一次性库标识（必须与库内标识表的值一致） */
  readonly disposableMarker: string;
  /** 受控文件根（本轮所有文件的唯一落点范围） */
  readonly fileRoot: string;
  /** 预期的安装标识 */
  readonly installationId: string;
  /** 预期的公司数据区 */
  readonly organizationId: number;
  /** 明确的测试授权口令（已核对为固定常量） */
  readonly testAuthorization: string;
}

/**
 * 安全边界拒绝错误。
 *
 * 单独一个错误类型，便于入口区分"被安全边界拒绝"与"执行期失败"：
 * 前者是**预期结果**（零写入），后者需要保留现场。
 */
export class SelfcheckSafetyError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SelfcheckSafetyError';
    this.code = code;
  }
}

/**
 * 从环境变量读取自检授权；缺失项一次性列全（不做部分回落）。
 */
export function readSelfcheckAuthorization(
  env: Readonly<Record<string, string | undefined>>,
): SelfcheckAuthorization {
  const missing = REQUIRED_SELFCHECK_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new SelfcheckSafetyError(
      'MISSING_AUTHORIZATION',
      `恢复自检默认拒绝运行：缺少显式授权环境变量 ${missing.join(', ')}。` +
        '必须显式给出一次性库、预期实例身份、一次性库标识、受控文件根、安装／公司标识与测试授权。',
    );
  }

  const read = (key: string): string => (env[key] ?? '').trim();
  const database = read('TASK09_RESTORE_DATABASE');
  const expectedHost = read('TASK09_RESTORE_EXPECTED_HOST');
  const expectedPortRaw = read('TASK09_RESTORE_EXPECTED_PORT');
  const expectedServerUuid = read('TASK09_RESTORE_EXPECTED_SERVER_UUID');
  const disposableMarker = read('TASK09_RESTORE_DISPOSABLE_MARKER');
  const fileRoot = read('TASK09_RESTORE_FILE_ROOT');
  const installationId = read('TASK09_RESTORE_INSTALLATION_ID');
  const organizationIdRaw = read('TASK09_RESTORE_ORGANIZATION_ID');
  const testAuthorization = read('TASK09_RESTORE_TEST_AUTHORIZATION');

  if (!DISPOSABLE_DATABASE_PATTERN.test(database)) {
    throw new SelfcheckSafetyError(
      'NOT_DISPOSABLE_DATABASE',
      `目标库 ${database} 不符合一次性库命名约束（${DISPOSABLE_DATABASE_PATTERN.source}），拒绝运行。`,
    );
  }
  if (FORBIDDEN_DATABASE_NAMES.has(database)) {
    throw new SelfcheckSafetyError(
      'FORBIDDEN_DATABASE',
      `目标库 ${database} 属于明确禁止的库名，拒绝运行。`,
    );
  }
  if (expectedHost.length === 0) {
    throw new SelfcheckSafetyError('INVALID_HOST', '预期实例主机为空，拒绝运行。');
  }
  const expectedPort = Number(expectedPortRaw);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0 || expectedPort > 65535) {
    throw new SelfcheckSafetyError(
      'INVALID_PORT',
      `预期实例端口 ${expectedPortRaw} 不是 1-65535 的整数，拒绝运行。`,
    );
  }
  if (!UUID_PATTERN.test(expectedServerUuid)) {
    throw new SelfcheckSafetyError(
      'INVALID_SERVER_UUID',
      '预期实例 UUID 必须是 UUID 形态（MySQL @@server_uuid），拒绝运行。',
    );
  }
  if (disposableMarker.length === 0) {
    throw new SelfcheckSafetyError('INVALID_MARKER', '一次性库标识为空，拒绝运行。');
  }
  if (!isAbsolute(fileRoot)) {
    throw new SelfcheckSafetyError('INVALID_FILE_ROOT', `受控文件根必须是绝对路径：${fileRoot}`);
  }
  if (!UUID_PATTERN.test(installationId)) {
    throw new SelfcheckSafetyError(
      'INVALID_INSTALLATION_ID',
      '安装标识必须是 UUID 形态，拒绝运行。',
    );
  }
  const organizationId = Number(organizationIdRaw);
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new SelfcheckSafetyError(
      'INVALID_ORGANIZATION_ID',
      `公司数据区 ${organizationIdRaw} 不是正整数，拒绝运行。`,
    );
  }
  if (testAuthorization !== SELFCHECK_TEST_AUTHORIZATION) {
    throw new SelfcheckSafetyError(
      'MISSING_TEST_AUTHORIZATION',
      '未给出正确的测试授权口令，拒绝运行（不会写库、不会删文件）。',
    );
  }

  return {
    envFile: read('TASK09_RESTORE_ENV_FILE'),
    database,
    expectedHost,
    expectedPort,
    expectedServerUuid: expectedServerUuid.toLowerCase(),
    disposableMarker,
    fileRoot,
    installationId: installationId.toLowerCase(),
    organizationId,
    testAuthorization,
  };
}

/**
 * 核对实际连接到的实例／库与声明完全一致。
 *
 * 任一维度不一致都拒绝继续：宁可零证据，也不拿"看起来对"的库开刀。
 */
export function assertServerIdentity(
  actual: {
    readonly database: string;
    readonly serverUuid: string;
    readonly host: string;
    readonly port: number;
  },
  expected: SelfcheckAuthorization,
): void {
  if (actual.database !== expected.database) {
    throw new SelfcheckSafetyError(
      'DATABASE_MISMATCH',
      `实际连接库与声明不一致：实际 ${actual.database}，声明 ${expected.database}`,
    );
  }
  if (actual.serverUuid.toLowerCase() !== expected.expectedServerUuid) {
    throw new SelfcheckSafetyError(
      'SERVER_UUID_MISMATCH',
      `实际实例 UUID 与声明不一致：实际 ${actual.serverUuid}，声明 ${expected.expectedServerUuid}`,
    );
  }
  if (actual.host !== expected.expectedHost) {
    throw new SelfcheckSafetyError(
      'HOST_MISMATCH',
      `实际实例主机与声明不一致：实际 ${actual.host}，声明 ${expected.expectedHost}`,
    );
  }
  if (actual.port !== expected.expectedPort) {
    throw new SelfcheckSafetyError(
      'PORT_MISMATCH',
      `实际实例端口与声明不一致：实际 ${actual.port}，声明 ${expected.expectedPort}`,
    );
  }
}

/** 一次性库标识行的读取结果 */
export interface DisposableMarkerRow {
  readonly markerKey: string;
  readonly markerValue: string;
}

/**
 * 核对库内的一次性标识。
 *
 * 标识表不存在、标识行缺失或值不一致都拒绝运行：说明这个库**不是**为本次
 * 隔离实测准备的一次性库。
 */
export function assertDisposableMarker(
  rows: ReadonlyArray<DisposableMarkerRow>,
  expectedMarker: string,
): void {
  const matched = rows.find((row) => row.markerKey === DISPOSABLE_MARKER_KEY);
  if (matched === undefined) {
    throw new SelfcheckSafetyError(
      'MISSING_DISPOSABLE_MARKER',
      `库内缺少一次性标识行（${DISPOSABLE_MARKER_KEY}），拒绝在该库上运行。`,
    );
  }
  if (matched.markerValue !== expectedMarker) {
    throw new SelfcheckSafetyError(
      'DISPOSABLE_MARKER_MISMATCH',
      '库内一次性标识与声明不一致，拒绝在该库上运行。',
    );
  }
}

/**
 * 受控文件根的真实路径。
 *
 * 拒绝：相对路径、不存在、符号链接本身、文件系统根目录、顶层目录
 * （如 `/tmp`、`/home`）——这些位置都可能被别的业务共用，误删代价不可接受。
 */
export function assertControlledFileRoot(fileRoot: string): string {
  if (!isAbsolute(fileRoot)) {
    throw new SelfcheckSafetyError('INVALID_FILE_ROOT', `受控文件根必须是绝对路径：${fileRoot}`);
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(fileRoot);
  } catch {
    throw new SelfcheckSafetyError('FILE_ROOT_MISSING', `受控文件根不存在：${fileRoot}`);
  }
  if (stats.isSymbolicLink()) {
    throw new SelfcheckSafetyError(
      'FILE_ROOT_IS_SYMLINK',
      `受控文件根本身是符号链接，拒绝使用：${fileRoot}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new SelfcheckSafetyError('FILE_ROOT_NOT_DIRECTORY', `受控文件根不是目录：${fileRoot}`);
  }
  const real = realpathSync(fileRoot);
  if (real === sep) {
    throw new SelfcheckSafetyError('FILE_ROOT_IS_ROOT', '受控文件根不得是文件系统根目录。');
  }
  const segments = real.split(sep).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new SelfcheckSafetyError(
      'FILE_ROOT_TOO_SHALLOW',
      `受控文件根不得是顶层目录（当前 ${real}），请使用专用子目录。`,
    );
  }
  return real;
}

/**
 * 核对某个待删路径落在受控根内，且本身不是越界的符号链接。
 *
 * 只用 `startsWith` 比对前缀是不够的（`/root/a` 与 `/root/ab`），这里按路径段比较。
 */
export function assertPathWithinRoot(root: string, candidate: string): void {
  const rootReal = assertControlledFileRoot(root);
  const resolved = resolve(candidate);
  if (!resolved.startsWith(rootReal + sep)) {
    throw new SelfcheckSafetyError(
      'PATH_OUTSIDE_ROOT',
      `待删路径越出受控根：${candidate}（受控根 ${rootReal}）`,
    );
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    // 目标已不存在：视为无需删除（幂等），不再做符号链接判定
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new SelfcheckSafetyError(
      'PATH_IS_SYMLINK',
      `待删路径本身是符号链接，拒绝按路径删除：${candidate}`,
    );
  }
  const real = realpathSync(resolved);
  if (!real.startsWith(rootReal + sep)) {
    throw new SelfcheckSafetyError(
      'PATH_ESCAPES_ROOT',
      `待删路径的真实位置越出受控根：${candidate} → ${real}（受控根 ${rootReal}）`,
    );
  }
}

/** 待删数据库对象（一个表内的一个主键） */
export interface DatabaseDeletionTarget {
  readonly table: string;
  readonly idColumn: string;
  readonly id: string;
  /** 归属核对用的说明（公司／安装／父子关系），失败时进入错误信息 */
  readonly ownership: string;
}

/**
 * 数据库删除顺序：**先子后父**。
 *
 * 顺序表按外键依赖从子到父排列；同一张表内部按主键升序，保证可复现。
 */
export const DELETION_ORDER: ReadonlyArray<string> = [
  'management_audit_event',
  'local_write_hold',
  'backup_restore_run',
  'backup_asset',
  'local_backup_run',
  'local_company_setting',
  'local_account_authorization',
];

/**
 * 把"本轮新建的对象"整理成删除计划。
 *
 * - 只接受本轮登记过的表（顺序表之外的一律拒绝，避免误删业务表）；
 * - 同一主键重复出现只保留一条；
 * - 输出顺序固定为"先子后父"。
 */
export function planDatabaseDeletion(
  targets: ReadonlyArray<DatabaseDeletionTarget>,
): ReadonlyArray<DatabaseDeletionTarget> {
  const unknown = targets.filter((target) => !DELETION_ORDER.includes(target.table));
  if (unknown.length > 0) {
    throw new SelfcheckSafetyError(
      'UNMANAGED_DELETION_TABLE',
      `拒绝删除不在受控顺序表内的对象：${[...new Set(unknown.map((item) => item.table))].join(', ')}`,
    );
  }
  const seen = new Set<string>();
  const unique: DatabaseDeletionTarget[] = [];
  for (const target of targets) {
    const key = `${target.table}::${target.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(target);
  }
  const orderIndex = new Map(DELETION_ORDER.map((table, index) => [table, index]));
  return unique.sort((left, right) => {
    const leftIndex = orderIndex.get(left.table) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.table) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.id.localeCompare(right.id);
  });
}

/** 哨兵快照：非目标对象的指纹 */
export interface SentinelSnapshot {
  readonly label: string;
  readonly fingerprint: string;
}

/**
 * 比较清理前后的哨兵快照。
 *
 * 非目标对象一旦变化就是越界副作用，必须让整轮失败而不是记一句"大概没事"。
 */
export function assertSentinelsUnchanged(
  before: ReadonlyArray<SentinelSnapshot>,
  after: ReadonlyArray<SentinelSnapshot>,
): void {
  const beforeMap = new Map(before.map((item) => [item.label, item.fingerprint]));
  const afterMap = new Map(after.map((item) => [item.label, item.fingerprint]));
  const changed: string[] = [];
  for (const [label, fingerprint] of beforeMap) {
    const current = afterMap.get(label);
    if (current === undefined) {
      changed.push(`${label}: 清理后哨兵消失`);
      continue;
    }
    if (current !== fingerprint) {
      changed.push(`${label}: 清理前后指纹不一致（${fingerprint} → ${current}）`);
    }
  }
  for (const label of afterMap.keys()) {
    if (!beforeMap.has(label)) {
      changed.push(`${label}: 清理后出现未登记的哨兵`);
    }
  }
  if (changed.length > 0) {
    throw new SelfcheckSafetyError('SENTINEL_CHANGED', `非目标哨兵发生变化：${changed.join('；')}`);
  }
}

/** 收尾阶段的结果 */
export interface CleanupOutcome {
  readonly errors: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

/**
 * 收尾阶段的失败**不得被吞掉**：主因存在时附加在主因上，无主因时单独报错。
 */
export function buildCleanupError(mainError: unknown, outcome: CleanupOutcome): unknown {
  const detail = [...outcome.errors, ...outcome.failed.map((item) => `删除失败: ${item}`)];
  if (mainError !== null && mainError !== undefined) {
    if (detail.length > 0 && mainError instanceof Error) {
      const withCleanup = mainError as Error & { cleanupErrors?: ReadonlyArray<string> };
      withCleanup.cleanupErrors = [...(withCleanup.cleanupErrors ?? []), ...detail];
    }
    return mainError;
  }
  if (detail.length > 0) {
    const error = new Error(`恢复自检收尾失败，不能视为成功：${detail.join(' | ')}`) as Error & {
      cleanupErrors?: ReadonlyArray<string>;
    };
    error.name = 'SelfcheckCleanupError';
    error.cleanupErrors = detail;
    return error;
  }
  return new Error('恢复自检未产生结果且未记录主因');
}

/* ────────────────────────────── 运行前预检 ────────────────────────────── */

/** 既有冻结事实 */
export interface ExistingHoldFact {
  readonly holdId: string;
  readonly installationId: string;
  readonly organizationId: number;
  readonly status: string;
  readonly restoreId: string | null;
}

/**
 * 运行前不得存在**不属于本轮**的活动冻结。
 *
 * 原脚本起跑即释放目标范围的全部冻结 —— 那会把上一轮的故障现场（"失败保持
 * 冻结"正是被验证的语义）直接抹掉。这里改为**拒绝运行**：冻结现场属于别人。
 */
export function assertNoForeignActiveHold(
  holds: ReadonlyArray<ExistingHoldFact>,
  installationId: string,
  organizationId: number,
): void {
  const foreign = holds.filter(
    (hold) =>
      hold.status === 'ACTIVE' &&
      hold.installationId === installationId &&
      hold.organizationId === organizationId,
  );
  if (foreign.length > 0) {
    throw new SelfcheckSafetyError(
      'PREEXISTING_ACTIVE_HOLD',
      `目标范围存在 ${foreign.length} 条非本轮的活动冻结，拒绝运行（不释放他人现场）：` +
        foreign.map((hold) => hold.holdId).join(', '),
    );
  }
}

/**
 * 只允许释放**属于本轮**的冻结。
 *
 * `ownedRestoreIds` 为本轮登记的恢复运行 ID；不在其中的冻结一律不动。
 */
export function selectReleasableHolds(
  holds: ReadonlyArray<ExistingHoldFact>,
  ownedRestoreIds: ReadonlyArray<string>,
): ReadonlyArray<ExistingHoldFact> {
  const owned = new Set(ownedRestoreIds);
  return holds.filter(
    (hold) => hold.status === 'ACTIVE' && hold.restoreId !== null && owned.has(hold.restoreId),
  );
}

/** 既有授权事实 */
export interface ExistingAuthorizationFact {
  readonly id: string;
  readonly installationId: string;
  readonly accountId: number;
  readonly organizationId: number;
  readonly authorizationStatus: string;
}

/**
 * 既有授权**不得被覆盖**。
 *
 * 唯一键是 (installation_id, account_id, organization_id)：既有一行就说明该范围
 * 已被授权过。此时脚本只复用、只读，不 UPDATE，也不把它列入删除计划。
 */
export function assertAuthorizationNotOverwritable(
  authorizations: ReadonlyArray<ExistingAuthorizationFact>,
  installationId: string,
  organizationId: number,
  accountId: number,
): void {
  const matched = authorizations.find(
    (item) =>
      item.installationId === installationId &&
      item.organizationId === organizationId &&
      item.accountId === accountId,
  );
  if (matched !== undefined) {
    throw new SelfcheckSafetyError(
      'PREEXISTING_AUTHORIZATION',
      `目标范围已存在授权行（id=${matched.id}，状态=${matched.authorizationStatus}），` +
        '不得覆盖既有授权：拒绝运行或改用一次性账号。',
    );
  }
}

/** 外部引用事实（某个对象被本轮之外的东西引用） */
export interface ExternalReferenceFact {
  readonly ownerTable: string;
  readonly ownerId: string;
  readonly referencedTable: string;
  readonly referencedId: string;
}

/**
 * 拒绝删除**被本轮之外引用**的对象。
 *
 * 这是"精确清理"的核心：只靠外键最后报错来拦误删，等于让数据库替我们做预检，
 * 既可能留下半删状态，也证明不了预检本身有效。
 */
export function assertNoExternalReference(
  references: ReadonlyArray<ExternalReferenceFact>,
  targetTable: string,
  targetId: string,
  ownedOwnerIds: ReadonlyArray<string>,
): void {
  const owned = new Set(ownedOwnerIds);
  const external = references.filter(
    (reference) =>
      reference.referencedTable === targetTable &&
      reference.referencedId === targetId &&
      !owned.has(`${reference.ownerTable}::${reference.ownerId}`),
  );
  if (external.length > 0) {
    throw new SelfcheckSafetyError(
      'EXTERNAL_REFERENCE',
      `对象 ${targetTable}#${targetId} 存在本轮之外的引用，拒绝删除：` +
        external.map((reference) => `${reference.ownerTable}#${reference.ownerId}`).join(', '),
    );
  }
}

/* ────────────────────────────── 文件清理 ────────────────────────────── */

/** 文件删除结果（文件系统不可回滚，因此失败必须逐条留痕） */
export interface FileDeletionResult {
  readonly deleted: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * 文件删除计划：只保留**受控根内**的路径，并逐条做真实路径与符号链接核对。
 *
 * 越界或符号链接路径直接抛错（不进入删除清单），避免"删到一半才发现越界"。
 */
export function planFileDeletion(
  paths: ReadonlyArray<string>,
  root: string,
): ReadonlyArray<string> {
  const planned: string[] = [];
  for (const candidate of paths) {
    assertPathWithinRoot(root, candidate);
    planned.push(resolve(candidate));
  }
  return [...new Set(planned)];
}

/**
 * 递归列出目录下的**文件**（不含目录本身）。
 *
 * 符号链接一律拒绝列出：删除清单里出现符号链接就意味着可能删到根外。
 */
export function listFilesUnder(dir: string): ReadonlyArray<string> {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SelfcheckSafetyError(
          'PATH_IS_SYMLINK',
          `受控根内出现符号链接，拒绝按文件清单删除：${full}`,
        );
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * 按**精确清单**删除文件（逐个文件删，不做递归目录删除）。
 *
 * 文件系统删除不可回滚，因此失败逐条留痕，不用事务掩盖。
 */
export function deleteFilesByList(paths: ReadonlyArray<string>, root: string): FileDeletionResult {
  const deleted: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const candidate of planFileDeletion(paths, root)) {
    try {
      rmSync(candidate, { force: true });
      deleted.push(candidate);
    } catch (error: unknown) {
      failed.push({
        path: candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
}

/**
 * 清理**空目录**（自底向上）；非空目录保留（说明还有本轮之外的内容）。
 */
export function pruneEmptyDirs(dir: string, root: string): ReadonlyArray<string> {
  const removed: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(join(current, entry.name));
      }
    }
    try {
      if (readdirSync(current).length === 0) {
        rmdirSync(current);
        removed.push(current);
      }
    } catch {
      // 目录非空或已被删除：保留，不视为失败
    }
  };
  walk(dir);
  if (!dir.startsWith(root + sep) && dir !== root) {
    throw new SelfcheckSafetyError('PATH_OUTSIDE_ROOT', `目录清理越出受控根：${dir}`);
  }
  return removed;
}
