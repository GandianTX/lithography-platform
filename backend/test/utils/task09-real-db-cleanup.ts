// test/utils/task09-real-db-cleanup.ts

/**
 * 任务 09 实库规格的**受控收尾**（复验 P2：新增实库规格的清理安全）。
 *
 * 纪律（与全局工具同口径，不降低任何守卫）：
 * - **库白名单**与**显式物理清理许可**两道门禁互相独立，缺任一即在第一条 DELETE 前失败关闭；
 * - 预期库与实际库逐项核验，且**实际删除连接**（同一事务 manager）必须再核一次；
 * - 归属只认**本轮登记的真实定位键 ＋ 创建时确定的预期事实**，不按包 ID／公司范围／目标 ID 批量推断；
 * - 删除前对**全部**登记对象做预检（身份、关键字段、外部引用），预检不通过即一条都不删；
 * - 全部删除在**同一事务**内完成，后续任一步失败即整体回滚（不留半清理现场）；
 * - 文件删除与数据库删除**不能同事务**：分开处理并保留可恢复诊断，**不声称跨资源完全原子**。
 *
 * 范围：
 * - 全局台账（`e2e-scoped-cleanup.ts`）经扩展已覆盖 `local_backup_run`（删除顺序：
 *   `backup_asset` → `local_backup_run` → `organization`）；
 * - 本文件**只补**两张全局台账未覆盖的本机运行事实表：
 *   `local_write_hold` 与 `local_write_scope_lock`（按 `organization_id` 外键指向公司，
 *   必须先于公司删除）；其余一律复用全局台账与全局清理器；
 * - 另外提供**每轮唯一**的受控文件根（归属标记 ＋ 路径边界 ＋ 符号链接拒绝）。
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { DataSource, EntityManager } from 'typeorm';

import {
  assertDataSourceOnAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
  assertPhysicalCleanupConsent,
  resolveExpectedE2eDatabase,
} from './e2e-db-guard';
import {
  assertOwnedFactsComplete,
  prepareGuardedSpecCleanupInTransaction,
  type OwnedResourceLedger,
} from './e2e-scoped-cleanup';

/** 全局台账未覆盖、但任务 09 规格会真实创建、且必须先于公司删除的本机运行事实表 */
export const TASK09_EXTRA_TABLES = ['local_write_hold', 'local_write_scope_lock'] as const;

export type Task09ExtraTable = (typeof TASK09_EXTRA_TABLES)[number];

/** 一条登记行：定位键 ＋ 归属证明（预期事实） */
export type Task09OwnedRow = {
  readonly table: Task09ExtraTable;
  /** 定位键（主键或等价唯一键）；删除只按它定位，不做范围推断 */
  readonly where: Readonly<Record<string, string | number>>;
  /** 归属证明：删除前必须逐字段匹配的预期值（来自本轮造数输入） */
  readonly expected: Readonly<Record<string, string | number | null>>;
};

export type Task09OwnedRowRegistry = {
  /** 登记一条本轮真实创建的运行事实行（同一对象重复登记只更新事实，不产生重复条目） */
  register(
    table: Task09ExtraTable,
    where: Record<string, string | number>,
    expected: Record<string, string | number | null>,
  ): void;
  /** 登记清单（按登记顺序） */
  list(): readonly Task09OwnedRow[];
  /** 是否为空（空清单 ⇒ 纯 no-op，不开事务、不删任何东西） */
  isEmpty(): boolean;
};

export const createTask09OwnedRowRegistry = (): Task09OwnedRowRegistry => {
  const rows: Task09OwnedRow[] = [];
  /** 定位键 → 行下标（同一对象多次登记时只更新预期事实，不产生重复条目） */
  const byKey = new Map<string, number>();
  return {
    register(table, where, expected) {
      const key = `${table}:${JSON.stringify(where)}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        rows[existing] = { table, where: { ...where }, expected: { ...expected } };
        return;
      }
      byKey.set(key, rows.length);
      rows.push({ table, where: { ...where }, expected: { ...expected } });
    },
    list() {
      return rows;
    },
    isEmpty() {
      return rows.length === 0;
    },
  };
};

const toColumnList = (columns: Readonly<Record<string, unknown>>): string =>
  Object.keys(columns)
    .map((column) => `\`${column}\` = ?`)
    .join(' AND ');

const toValues = (columns: Readonly<Record<string, unknown>>): unknown[] =>
  Object.values(columns).map((value) => value);

/** 数据库列值 → 文本（只接受标量；对象/数组一律拒绝，避免默认字符串化掩盖事实）。 */
const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
};

/** 预检不通过时的统一失败口径（带定位信息，便于复盘） */
const refuse = (helper: string, stage: string, detail: string): never => {
  throw new Error(`[${helper}] 阶段=${stage} 拒绝执行删除：${detail}`);
};

/**
 * 删除前预检：逐条核对身份与关键字段。
 *
 * - 行不存在 ⇒ 无法证明归属 ⇒ 拒绝（不按名单盲删）；
 * - 关键字段漂移 ⇒ 归属存疑 ⇒ 拒绝。
 *
 * 外部引用（公司入向引用）由全局台账的 `collectOwnedGraph` 统一核验，不在此重复。
 */
const precheckTask09Rows = async (
  manager: EntityManager,
  registry: Task09OwnedRowRegistry,
  helper: string,
): Promise<void> => {
  for (const row of registry.list()) {
    const found = await manager.query(
      `SELECT * FROM \`${row.table}\` WHERE ${toColumnList(row.where)} FOR UPDATE`,
      toValues(row.where),
    );
    const records = found as Record<string, unknown>[];
    if (records.length !== 1) {
      refuse(
        helper,
        '删除前预检',
        `${row.table} ${JSON.stringify(row.where)} 命中 ${records.length} 行（期望恰好 1 行），无法证明归属`,
      );
    }
    const actual = records[0];
    for (const [column, expected] of Object.entries(row.expected)) {
      const value = asText(actual?.[column]);
      const normalized = value ?? '';
      if (normalized !== String(expected ?? '')) {
        refuse(
          helper,
          '删除前预检',
          `${row.table} ${JSON.stringify(row.where)} 的 ${column} 实际=${
            normalized || '(空)'
          } 预期=${String(expected ?? '')}（归属漂移）`,
        );
      }
    }
  }
};

/** 按登记清单精确删除（只按定位键删，不做范围推断） */
const deleteTask09Rows = async (
  manager: EntityManager,
  registry: Task09OwnedRowRegistry,
  helper: string,
): Promise<void> => {
  for (const row of registry.list()) {
    const outcome = await manager.query(
      `DELETE FROM \`${row.table}\` WHERE ${toColumnList(row.where)}`,
      toValues(row.where),
    );
    const affected = Number(
      (outcome as { affectedRows?: number }).affectedRows ??
        (outcome as { affected?: number }).affected ??
        0,
    );
    if (affected !== 1) {
      refuse(
        helper,
        '精确删除',
        `${row.table} ${JSON.stringify(row.where)} 影响 ${affected} 行（期望 1 行）`,
      );
    }
  }
};

/**
 * 任务 09 实库规格的收尾入口。
 *
 * 执行顺序（**同一事务**）：
 * 1. 物理清理许可门禁 ＋ 预期/实际库核验（连接池口径）；
 * 2. 全局台账完整性检查（缺事实即不开事务、不删任何东西）；
 * 3. 事务内：实际删除连接再核库名 → 全局台账预检 → 本助手专属行预检；
 * 4. 删冻结行/范围锁行（必须先于公司）→ 全局台账删除（含 `backup_asset` →
 *    `local_backup_run` → `organization` 的正确顺序）；
 * 5. 任一步失败 ⇒ 整体回滚并抛出（不吞异常、不假报零残留）。
 */
export const runTask09GuardedCleanup = async (params: {
  readonly dataSource: DataSource;
  readonly helper: string;
  readonly owned: OwnedResourceLedger;
  readonly extraRows: Task09OwnedRowRegistry;
  /** 显式预期目标库；缺省时取 DataSource.options.database */
  readonly expectedDatabase?: string;
}): Promise<void> => {
  const { dataSource, helper, owned, extraRows } = params;

  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }

  const expected = resolveExpectedE2eDatabase(dataSource, params.expectedDatabase);
  await assertDataSourceOnAllowedE2eDatabase(dataSource, expected);

  // 纯内存完整性检查：缺事实时不开启事务、不执行任何 DELETE。
  assertOwnedFactsComplete(owned, helper);

  if (extraRows.isEmpty() && owned.organizationIds.length === 0 && owned.accountIds.length === 0) {
    return;
  }

  await dataSource.transaction(async (manager) => {
    // 实际删除连接（同一事务 manager）必须再次核对预期库名。
    await assertManagerOnExpectedE2eDatabase(manager, expected);

    // 预检（不删除）：全局台账覆盖的对象。
    const prepared = await prepareGuardedSpecCleanupInTransaction(manager, { helper, owned });
    // 预检（不删除）：本助手专属表。
    await precheckTask09Rows(manager, extraRows, helper);

    // 删除顺序（全部在同一事务内，任一步失败整体回滚）：
    // 1) 冻结行/范围锁行（只依赖公司，必须先于公司删除）；
    await deleteTask09Rows(manager, extraRows, helper);
    // 2) 全局台账对象：`backup_asset` → `local_backup_run` → 其余 → `organization`。
    if (prepared) {
      await prepared.execute();
    }
  });
};

// ── 受控文件根（本轮唯一根 ＋ 归属标记 ＋ 路径边界） ────────────────────────────

export type OwnedFileRoot = {
  /** 受控基目录（本轮唯一根的父目录） */
  readonly baseDir: string;
  /** 本轮唯一根（每轮新建，绝不复用既有目录） */
  readonly root: string;
  /** 归属标记（写在根下的标记文件里，用于删除前核对"这个根确实是本轮建的"） */
  readonly token: string;
};

const OWNER_MARKER_FILE = '.task09-owner.json';

const isEnoent = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

/** 清理阶段失败关闭：文案带受控根与阶段，便于从 runner 输出直接定位现场。 */
const refuseFileCleanup = (
  root: OwnedFileRoot,
  stage: string,
  detail: string,
  cause?: unknown,
): never => {
  throw new Error(
    `[cleanupOwnedFileRoot] 受控根=${root.root} 阶段=${stage} 拒绝执行文件清理：${detail}`,
    { cause },
  );
};

/** 由深到浅（路径段多者优先），保证先子后父。 */
const byDepthDesc = (left: string, right: string): number =>
  right.split(sep).length - left.split(sep).length;

type FileStat = Stats;

/** 必须存在的 lstat：任何错误都失败关闭（保留 cause）。 */
const statOrRefuse = (
  root: OwnedFileRoot,
  target: string,
  stage: string,
  detail = `无法核验路径：${target}`,
): FileStat => {
  try {
    return lstatSync(target);
  } catch (error) {
    return refuseFileCleanup(root, stage, detail, error);
  }
};

/** 允许 ENOENT 的 lstat（幂等跳过），其余错误失败关闭。 */
const statOrNull = (root: OwnedFileRoot, target: string, stage: string): FileStat | null => {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    return refuseFileCleanup(root, stage, `无法核验路径：${target}`, error);
  }
};

const readdirOrRefuse = (root: OwnedFileRoot, directory: string): string[] => {
  try {
    return readdirSync(directory);
  } catch (error) {
    return refuseFileCleanup(root, '未登记项预检', `无法列举目录：${directory}`, error);
  }
};

const readMarkerOrRefuse = (root: OwnedFileRoot, markerPath: string): { token?: string } => {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8')) as { token?: string };
  } catch (error) {
    return refuseFileCleanup(root, '归属标记', `归属标记无法解析：${markerPath}`, error);
  }
};

/**
 * 逐段核验目标及其祖先：拒绝符号链接（不跟随、不穿过），拒绝类型异常。
 *
 * - 基目录与受控根自身都必须是真实目录；
 * - 从受控根到目标的每一段都必须是真实条目；
 * - ENOENT 段允许跳过（目标可能已在本轮前序回收），后续分类阶段按实际情况决定幂等或失败。
 */
const assertNoSymlinkOnPath = (root: OwnedFileRoot, target: string): void => {
  const base = resolve(root.baseDir);
  const baseStat = statOrRefuse(root, base, '祖先核验', `无法核验基目录：${base}`);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    refuseFileCleanup(root, '祖先核验', `基目录不是真实目录（可能是符号链接）：${base}`);
  }

  const rootStat = statOrRefuse(root, root.root, '根核验', `无法核验受控根：${root.root}`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    refuseFileCleanup(root, '根核验', `受控根不是真实目录（可能是符号链接）：${root.root}`);
  }

  const absolute = resolve(target);
  const rel = relative(root.root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    refuseFileCleanup(root, '路径边界', `目标不在受控根内：${absolute}`);
  }
  let cursor = root.root;
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    cursor = join(cursor, segment);
    const stat = statOrNull(root, cursor, '祖先核验');
    if (stat !== null && stat.isSymbolicLink()) {
      refuseFileCleanup(root, '祖先核验', `拒绝穿过符号链接：${cursor}`);
    }
  }
};

/** 收集"受控根 + 每个登记目录"下的未登记直接子项；只读、不删除。 */
const collectUnregisteredEntries = (
  root: OwnedFileRoot,
  registered: ReadonlySet<string>,
  markerPath: string,
): string[] => {
  const markerAbsolute = resolve(markerPath);
  const directories = [root.root];
  for (const target of registered) {
    const stat = statOrNull(root, target, '未登记项预检');
    if (stat !== null && stat.isDirectory() && !stat.isSymbolicLink()) {
      directories.push(target);
    }
  }

  const unregistered: string[] = [];
  for (const directory of directories) {
    const stat = statOrNull(root, directory, '未登记项预检');
    if (stat === null) {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refuseFileCleanup(root, '未登记项预检', `登记目录不是真实目录：${directory}`);
    }
    const entries = readdirOrRefuse(root, directory);
    for (const entry of entries) {
      const child = join(directory, entry);
      if (resolve(child) === markerAbsolute) {
        continue;
      }
      if (registered.has(resolve(child))) {
        continue;
      }
      unregistered.push(child);
    }
  }
  return unregistered;
};

/**
 * 建立本轮**唯一**的受控文件根。
 *
 * - 根目录名带随机后缀（每轮不同）⇒ 不会与既有目录重合；
 * - 根下写归属标记文件 ⇒ 删除前可核对"这个根确实是本轮建的"；
 * - **绝不**复用或清空既有固定目录。
 */
export const createOwnedFileRoot = (baseDir: string, prefix: string): OwnedFileRoot => {
  mkdirSync(baseDir, { recursive: true });
  const root = mkdtempSync(join(resolve(baseDir), prefix));
  const token = `${prefix}-${process.pid}-${Date.now()}`;
  writeFileSync(
    join(root, OWNER_MARKER_FILE),
    JSON.stringify({ token, createdAt: new Date().toISOString() }),
    'utf8',
  );
  return { baseDir: resolve(baseDir), root, token };
};

/** 路径边界核对：目标必须在 root 之内（不含 root 自身）。 */
const assertInsideRoot = (root: OwnedFileRoot, target: string): void => {
  const absolute = resolve(target);
  const rel = relative(root.root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `拒绝删除受控根之外的路径：${absolute} 不在 ${root.root} 之内（相对=${rel || '(同一路径)'}）`,
    );
  }
};

/**
 * 删除本轮受控根下的**已登记路径**，最后删除根目录本身。
 *
 * - 根必须带本轮归属标记（标记文件内容与登记 token 一致）⇒ 拒绝删除别人的根；
 * - 只删登记过的路径（不按目录差集推断）：文件用 `unlink`，目录用**非递归** `rmdir`；
 * - 任何未登记项、符号链接、路径逃逸或类型异常一律失败关闭，绝不递归删除未登记内容；
 * - 全量预检在任何删除之前完成，失败时保留整场现场（包括未登记字节与归属标记）；
 * - 根目录非空即抛错（不静默留下残留）。
 *
 * 与数据库删除**不能同事务**：调用方须分开处理并保留诊断，不声称跨资源完全原子。
 */
export const cleanupOwnedFileRoot = (
  root: OwnedFileRoot,
  createdPaths: readonly string[],
): void => {
  const markerPath = join(root.root, OWNER_MARKER_FILE);

  // ① 归属标记：必须存在、是普通文件、内容与本轮 token 一致。
  const markerStat = statOrRefuse(
    root,
    markerPath,
    '归属标记',
    `缺少归属标记文件 ${markerPath}（无法证明这个根属于本轮）`,
  );
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    refuseFileCleanup(root, '归属标记', `归属标记不是普通文件：${markerPath}`);
  }
  const marker = readMarkerOrRefuse(root, markerPath);
  if (marker.token !== root.token) {
    refuseFileCleanup(root, '归属标记', `归属标记不匹配（${markerPath}）`);
  }

  // ② 登记路径：边界 + 逐段符号链接检查；按实际类型分类（目录 / 普通文件）。
  const unique = [...new Set(createdPaths)].map((target) => resolve(target));
  const files: string[] = [];
  const directories: string[] = [];
  for (const target of unique) {
    assertInsideRoot(root, target);
    assertNoSymlinkOnPath(root, target);
    const stat = statOrNull(root, target, '路径分类');
    if (stat === null) {
      continue;
    }
    if (stat.isSymbolicLink()) {
      refuseFileCleanup(root, '路径分类', `拒绝删除符号链接：${target}`);
    }
    if (stat.isFile()) {
      files.push(target);
    } else if (stat.isDirectory()) {
      directories.push(target);
    } else {
      refuseFileCleanup(root, '路径分类', `不支持的条目类型（非普通文件/目录）：${target}`);
    }
  }

  // ③ 全量预检：受控根与每个登记目录内都不得有未登记项。
  //    必须在任何删除之前完成：失败时未登记字节、登记字节与归属标记全部保留。
  const unregistered = collectUnregisteredEntries(root, new Set(unique), markerPath);
  if (unregistered.length > 0) {
    refuseFileCleanup(
      root,
      '未登记项预检',
      `发现 ${unregistered.length} 个未登记条目，已全部保留且不会递归删除：${unregistered.join(', ')}`,
    );
  }

  // ④ 精确删除：文件 unlink、目录非递归 rmdir，均由深到浅；删除前再核一次类型。
  for (const target of [...files].sort(byDepthDesc)) {
    assertNoSymlinkOnPath(root, target);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      refuseFileCleanup(root, '文件删除', `登记路径类型在删除前发生变化：${target}`);
    }
    unlinkSync(target);
  }
  for (const target of [...directories].sort(byDepthDesc)) {
    assertNoSymlinkOnPath(root, target);
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      refuseFileCleanup(root, '目录删除', `登记目录类型在删除前发生变化：${target}`);
    }
    rmdirSync(target);
  }

  // ⑤ 最后回收归属标记与根目录；根目录非空即抛错（不静默残留）。
  assertNoSymlinkOnPath(root, markerPath);
  const finalMarkerStat = lstatSync(markerPath);
  if (!finalMarkerStat.isFile() || finalMarkerStat.isSymbolicLink()) {
    refuseFileCleanup(root, '标记回收', `归属标记在删除前发生变化：${markerPath}`);
  }
  unlinkSync(markerPath);
  assertNoSymlinkOnPath(root, root.root);
  rmdirSync(root.root);
};
