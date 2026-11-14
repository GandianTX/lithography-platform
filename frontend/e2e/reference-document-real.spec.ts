// e2e/reference-document-real.spec.ts
// AI 参考资料库真实后端数据流 e2e（阶段三 T-03/T-04 + 0909 第二轮文件上传/下载链路）。
//
// 数据基础：backend seed 预置参考资料 970001~970003（未软删，含通用/指定型号/
// 有 storage 引用三种形态）与 970004（已软删，默认不可见）；seed 行只做只读断言。
// 创建链路产生的自建行以「运行级唯一标识」命名（标题含 RUN_ID，跨运行/跨开发者
// 不可能撞名）。点击创建前先注册响应监听，创建响应一返回即记录本轮预期事实
//（标题 / 创建人账号 / 存储引用 / 文件元数据），早于成功页与详情页断言——即使后续断言
// 或跳转失败，清理仍能按该 ID 执行；文件上传路径在取得 ID 后**立即登记**（引用先置
// pending，解析成功再补回；查询失败 / 引用非法一律保持 pending，绝不误记为「无引用」），
// 清理会保留并报告该精确 ID。清理只以这些精确 ID 为删除边界：先做只读归属预检（缺失 /
// 字段不符即在任何软删之前停止、保留现场），再经 API 软删（幂等）；标题反查仅用于报告
// 未记录的遗漏行，绝不并入删除目标（同标题异主行保持原样）。
// 上传文件清理由入口自行过授权门 + 严格专用库门并经同一核验 SQL 回读实际 DATABASE()，
// 再按记录引用核验目标行字段 / 文件元数据 / 引用唯一性，核验失败保留文件并让用例失败。
// 专用隔离库（严格 lithography_e2e + 显式 opt-in）内按精确 ID + 预期事实走受保护物理清理，
// 事务内核验归属 / 存储引用 / 外部引用，任一不符即零删除并让用例转红；共享开发库只软删不物删。
// 清理失败不再以警告吞掉：主断言错误保留，清理错误一并报告，专用入口只有在本轮数据库行与
// 上传文件均核验为零残留时才能通过。
// 前提不满足（无本地后端 / 无 env）时用例自动跳过，不会以失败阻塞。

import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  assertE2EReferenceDocumentOwnershipBeforeCleanup,
  deleteE2EReferenceDocumentRowsByIds,
  deleteE2EReferenceDocumentStorageFiles,
  findReferenceDocumentStorageReferenceById,
  isPhysicalCleanupEnabled,
  mysqlQuery,
  planReferenceDocumentSoftDelete,
  readBackendEnv,
  realGraphqlCall,
  realLoginAccountId,
  realRestDownload,
  REFERENCE_DOCUMENT_E2E_TITLE_PREFIX,
  type ReferenceDocumentCleanupTarget,
  type ReferenceDocumentFixtureColumnMutation,
  type ReferenceDocumentStorageFileCleanupTarget,
  type RegisteredReferenceDocument,
  registerUploadedReferenceDocument,
  requirePositiveReferenceDocumentId,
  requireResolvedStorageReference,
  resolveRealBackendPrerequisite,
  resolveReferenceDocumentStorageFilePath,
  restoreMutatedReferenceDocumentFixtureRow,
  runGuardedFixtureWrite,
} from './helpers/real-backend';

const LIST_PATH = '/reference-documents';
const NEW_PAGE_PATH = '/reference-documents/new';

const SEED_ERROR_MANUAL_TITLE = 'NXT:1980Di 常见错误代码手册（Mock）';
const SEED_MAINTENANCE_GUIDE_TITLE = 'NXE:3400C 光源维护指南（Mock）';
const SEED_SAFETY_STANDARD_TITLE = '光刻机故障诊断安全规范（Mock）';
const SEED_DEPRECATED_TITLE = '旧版 XT 系列检查表（已停用 Mock）';

/** 本次运行唯一标识：并入自建行标题，保证跨运行/并行执行永不撞名 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 自建行标题筛选关键字：仅匹配本次运行创建的行（其他运行有自己的 RUN_ID） */
const RUN_TITLE_KEYWORD = `${REFERENCE_DOCUMENT_E2E_TITLE_PREFIX}·${RUN_ID}`;

const LIST_DOCUMENTS_QUERY = `
  query ReferenceDocuments($pagination: PaginationArgs!, $filter: ReferenceDocumentFilterInput) {
    referenceDocuments(pagination: $pagination, filter: $filter) {
      items { id title }
      total
      page
      pageSize
    }
  }
`;

const SOFT_DELETE_MUTATION = `
  mutation SoftDeleteReferenceDocument($id: Int!) {
    softDeleteReferenceDocument(id: $id) { id }
  }
`;

/** 按本次运行唯一标题关键字查询未软删行 ID 列表（Node 侧真实登录后调用） */
async function findE2EDocumentIds(env: Record<string, string>): Promise<number[]> {
  const { body } = await realGraphqlCall(
    env,
    LIST_DOCUMENTS_QUERY,
    {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 50, withTotal: true },
      filter: { title: RUN_TITLE_KEYWORD },
    },
    'mock_super_admin',
  );
  const items = (
    body as {
      data?: { referenceDocuments?: { items?: Array<{ id: number; title: string }> } };
    }
  ).data?.referenceDocuments?.items;

  return (items ?? []).map((item) => item.id);
}

/**
 * 本轮登记的精确目标记录（见 helper 的 RegisteredReferenceDocument）：id 与「创建 / 上传响应一
 * 返回即记录」的预期事实一并保存，物理清理与上传文件清理的预期值由此而来（不回读目标行，否则
 * 核验退化为自证）。title 在主链路中会随编辑更新，故保持可写；存储引用为三态登记
 * （pending=尚未取得（未知）/ none=确认无引用 / resolved=已取得并通过格式校验）。
 */
type CreatedRunDocument = RegisteredReferenceDocument;

/** 构造物理清理目标：存储引用 pending（未知）即抛错并报告精确 ID，绝不当作无引用跳过 */
function toCleanupTargets(
  documents: readonly CreatedRunDocument[],
): ReferenceDocumentCleanupTarget[] {
  return documents.map(({ id, title, createdByAccountId, storageReference }) => ({
    id,
    expected: {
      title,
      createdByAccountId,
      storageReference: requireResolvedStorageReference(storageReference, id),
    },
  }));
}

/** 仅文件上传路径（有已确认存储引用）进入上传文件清理目标；缺文件元数据预期事实时拒绝清理 */
function toStorageFileTargets(
  documents: readonly CreatedRunDocument[],
): ReferenceDocumentStorageFileCleanupTarget[] {
  const targets: ReferenceDocumentStorageFileCleanupTarget[] = [];

  for (const {
    id,
    title,
    createdByAccountId,
    storageReference,
    originalFilename,
    mimeType,
  } of documents) {
    // pending（未知）在 requireResolvedStorageReference 内抛错并报告精确 ID：不跳过、不放行
    const reference = requireResolvedStorageReference(storageReference, id);

    if (reference === null) {
      continue;
    }

    if (originalFilename === null || mimeType === null) {
      throw new Error(`自建资料 ${id} 有存储引用但缺少文件元数据预期事实，拒绝清理上传文件`);
    }

    targets.push({
      id,
      expected: {
        title,
        createdByAccountId,
        storageReference: reference,
        originalFilename,
        mimeType,
      },
    });
  }

  return targets;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 主断言与清理的执行包装：主断言失败时保留原始错误，清理失败时一并报告。
 * 清理异常不再以 console.warn 吞掉——专用入口只有在本轮数据零残留时才能通过。
 */
async function runWithCleanup(
  body: () => Promise<void>,
  cleanup: () => Promise<void> | void,
): Promise<void> {
  let primaryError: unknown = null;

  try {
    await body();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown = null;

  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError !== null && cleanupError !== null) {
    throw new Error(
      `${toErrorMessage(primaryError)}；此外清理失败：${toErrorMessage(cleanupError)}`,
    );
  }

  if (cleanupError !== null) {
    throw cleanupError;
  }

  if (primaryError !== null) {
    throw primaryError;
  }
}

// ---- P3b 真实 SQL 回归夹具 ----
//
// 单测（helpers/real-backend.spec.ts）只断言入口生成的 SQL 文本；此处用本轮直接落库并「插入即登记
// 精确 ID」的真实夹具 + 存储目录真实文件执行真实 SQL：覆盖可空字段被改成 NULL 的各条失败路径——
// 核验必须把 NULL 不一致计入 field_mismatch_rows → 失败关闭 → 零软删 / 零物理删行 / 零文件删除。
// 夹具的插入 / 故意改 NULL / 恢复一律经 runGuardedFixtureWrite（复用显式授权门 + 测试库命名门 +
// 严格 lithography_e2e 库名门，并复查执行连接实际 DATABASE()）；收尾不再直接 DELETE / rmSync，而是
// 先「核验后恢复」被改坏的列，再复用受保护的文件 / 资料行清理 helper。夹具标题使用独立前缀（不含
// RUN_TITLE_KEYWORD），避免被主链路用例的标题反查命中；操作一律以本轮登记的精确 ID 为边界并校验
// 标题 / 创建人 / 当前预期字段，绝不按标题前缀认领记录。

/** SQL 回归夹具标题前缀：与主链路 RUN_TITLE_KEYWORD 区分，避免跨用例互相命中反查 */
const SQL_FIXTURE_TITLE_PREFIX = 'E2E 参考资料SQL回归';

/** 真实 SQL 夹具行：id 与「插入后立即登记」的本轮预期事实 */
interface SqlFixtureRow {
  readonly id: number;
  readonly title: string;
  readonly createdByAccountId: number;
  readonly documentType: string;
  readonly contentText: string | null;
  readonly storageBackend: string | null;
  readonly storageReference: string | null;
  readonly originalFilename: string | null;
  readonly mimeType: string | null;
}

/** 文件资料夹具：存储引用 / 文件元数据 / 磁盘路径均非空 */
interface FileSqlFixtureRow extends SqlFixtureRow {
  readonly storageBackend: string;
  readonly storageReference: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly filePath: string;
}

/** 本轮登记的夹具：原始事实 + 可选文件夹具 + 故意改成 NULL 的列（null = 未被改动） */
interface RegisteredFixture {
  readonly row: SqlFixtureRow;
  readonly fileRow: FileSqlFixtureRow | null;
  mutations: ReferenceDocumentFixtureColumnMutation[] | null;
}

/** 取文件夹具事实；非文件夹具调用即抛错，绝不降级为「无文件」而被跳过清理 */
function requireFileFixture(fixture: RegisteredFixture): FileSqlFixtureRow {
  if (fixture.fileRow === null) {
    throw new Error(`夹具 ${fixture.row.id} 不是文件夹具，拒绝按文件清理`);
  }

  return fixture.fileRow;
}

/** 单个 SQL 夹具值的字面量白名单：拒绝单引号 / 反斜杠（终止符 / 默认转义符）与超长值 */
function sqlLiteral(value: string | null): string {
  if (value === null) {
    return 'NULL';
  }

  if (!/^[^'\\]{0,255}$/.test(value)) {
    throw new Error(`真实 SQL 夹具值未通过白名单校验，拒绝拼接：${JSON.stringify(value)}`);
  }

  return `'${value}'`;
}

/**
 * 直插一条夹具行并立即取回精确 ID（写入经 runGuardedFixtureWrite 统一安全入口：
 * 授权门 + 严格 lithography_e2e 库名门 + 实际 DATABASE() 复查）。同一 mysql 进程 = 同一连接，
 * 故 INSERT 后的 LAST_INSERT_ID() 必为该行主键；取回后立即登记为本轮清理边界。
 */
function insertSqlFixtureRow(
  env: Record<string, string>,
  facts: {
    readonly title: string;
    readonly createdByAccountId: number;
    readonly documentType: string;
    readonly contentText: string | null;
    readonly storageBackend: string | null;
    readonly storageReference: string | null;
    readonly originalFilename: string | null;
    readonly mimeType: string | null;
  },
): number {
  if (!Number.isSafeInteger(facts.createdByAccountId) || facts.createdByAccountId <= 0) {
    throw new Error(
      `真实 SQL 夹具创建人账号非法，拒绝拼接：${JSON.stringify(facts.createdByAccountId)}`,
    );
  }

  const output = runGuardedFixtureWrite(
    env,
    [
      'INSERT INTO reference_document',
      '(title, document_type, content_text, storage_backend, storage_reference, original_filename, mime_type, created_by_account_id)',
      `VALUES (${sqlLiteral(facts.title)}, ${sqlLiteral(facts.documentType)}, ${sqlLiteral(
        facts.contentText,
      )}, ${sqlLiteral(facts.storageBackend)}, ${sqlLiteral(facts.storageReference)}, ${sqlLiteral(
        facts.originalFilename,
      )}, ${sqlLiteral(facts.mimeType)}, ${facts.createdByAccountId});`,
      'SELECT LAST_INSERT_ID();',
    ].join(' '),
  );

  return requirePositiveReferenceDocumentId(Number(output.split('\n').pop()), 'SQL 夹具插入');
}

/** 只读回读夹具行状态：不存在时 exists=false；存在时带回 deprecated 与当前存储引用 */
function readSqlFixtureRowState(id: number): {
  readonly exists: boolean;
  readonly deprecated: number;
  readonly storageReference: string | null;
} {
  const output = mysqlQuery(
    `SELECT CONCAT(deprecated, '|', IFNULL(storage_reference, '<null>')) FROM reference_document WHERE id = ${id}`,
  );

  if (output === '') {
    return { exists: false, deprecated: -1, storageReference: null };
  }

  const [deprecated, storageReference] = output.split('|');

  return {
    exists: true,
    deprecated: Number(deprecated),
    storageReference: storageReference === '<null>' ? null : storageReference,
  };
}

/** 只读回读本轮登记夹具中仍在库的精确 ID 集合（收尾据此跳过已在用例主体完成清理的行） */
function readExistingFixtureIds(ids: readonly number[]): Set<number> {
  if (ids.length === 0) {
    return new Set();
  }

  const output = mysqlQuery(
    `SELECT id FROM reference_document WHERE id IN (${ids.join(',')}) ORDER BY id`,
  );

  if (output === '') {
    return new Set();
  }

  return new Set(output.split('\n').map((line) => Number(line)));
}

/** 服务端生成格式的随机存储引用（32 位小写 hex + 白名单扩展名），保证不与既有文件撞名 */
function newStorageReference(ext: string): string {
  return `${randomBytes(16).toString('hex')}${ext}`;
}

/** 真实 SQL 夹具的共享上下文：环境、创建人与本轮登记清单（创建 / 收尾函数都以此为准） */
interface SqlFixtureContext {
  readonly env: Record<string, string>;
  readonly createdByAccountId: number;
  readonly fixtures: RegisteredFixture[];
}

function registerFixture(
  ctx: SqlFixtureContext,
  row: SqlFixtureRow,
  fileRow: FileSqlFixtureRow | null,
): void {
  ctx.fixtures.push({ row, fileRow, mutations: null });
}

/**
 * 创建文件夹具：先按已生成的引用解析路径（纯函数、不落库）→ 插入取得 ID → **立即**登记清理边界
 * → 最后才执行写入。写入动作可注入，便于测试「写文件失败」路径；写失败时该行与路径已在
 * ctx.fixtures 中，收尾仍能按精确 ID 清理该行与可能留下的部分文件。
 */
function createFileFixture(
  ctx: SqlFixtureContext,
  suffix: string,
  write: (filePath: string) => void = (filePath) =>
    writeFileSync(filePath, `sql fixture ${suffix}`),
): FileSqlFixtureRow {
  const storageReference = newStorageReference('.md');
  const filePath = resolveReferenceDocumentStorageFilePath(ctx.env, storageReference);
  const facts = {
    title: `${SQL_FIXTURE_TITLE_PREFIX}·${RUN_ID}·${suffix}`,
    createdByAccountId: ctx.createdByAccountId,
    documentType: 'MANUAL',
    contentText: null,
    storageBackend: 'local',
    storageReference,
    originalFilename: `${suffix}.md`,
    mimeType: 'text/markdown',
  };
  const id = insertSqlFixtureRow(ctx.env, facts);
  const row: FileSqlFixtureRow = { id, ...facts, filePath };

  registerFixture(ctx, row, row);

  write(filePath);

  return row;
}

/** 创建文本资料夹具（无存储引用 / 无文件），插入取得 ID 后立即登记 */
function createTextFixture(ctx: SqlFixtureContext, suffix: string): SqlFixtureRow {
  const facts = {
    title: `${SQL_FIXTURE_TITLE_PREFIX}·${RUN_ID}·${suffix}`,
    createdByAccountId: ctx.createdByAccountId,
    documentType: 'MANUAL',
    contentText: `SQL 夹具正文 ${suffix}`,
    storageBackend: null,
    storageReference: null,
    originalFilename: null,
    mimeType: null,
  };
  const row: SqlFixtureRow = { id: insertSqlFixtureRow(ctx.env, facts), ...facts };

  registerFixture(ctx, row, null);

  return row;
}

/** 登记某夹具本轮故意改成 NULL 的列（含制造值与原值），供收尾「先核验后恢复」使用 */
function recordFixtureMutation(
  ctx: SqlFixtureContext,
  id: number,
  mutations: ReferenceDocumentFixtureColumnMutation[],
): void {
  const fixture = ctx.fixtures.find(({ row }) => row.id === id);

  if (fixture === undefined) {
    throw new Error(`未登记的夹具 ID，拒绝记录改 NULL 状态：${id}`);
  }

  fixture.mutations = mutations;
}

/** 物理清理目标一律取登记的本轮原始事实（未被改动的值），使恢复后受保护 helper 的核验可通过 */
function cleanupTargetOf(row: SqlFixtureRow): ReferenceDocumentCleanupTarget {
  return {
    id: row.id,
    expected: {
      title: row.title,
      createdByAccountId: row.createdByAccountId,
      storageReference: row.storageReference,
    },
  };
}

function fileTargetOf(row: FileSqlFixtureRow): ReferenceDocumentStorageFileCleanupTarget {
  return {
    id: row.id,
    expected: {
      title: row.title,
      createdByAccountId: row.createdByAccountId,
      storageReference: row.storageReference,
      originalFilename: row.originalFilename,
      mimeType: row.mimeType,
    },
  };
}

/**
 * 共享收尾（创建函数与写失败用例共用同一份逻辑，不复制第二套）：只以本轮登记的精确 ID 为边界，
 * 已在用例主体清理的行据只读回读跳过；
 * 1. 对仍在库且被故意改 NULL 的夹具「先核验后恢复」（同一事务；字段被意外改动即保留行与文件）；
 * 2. 复用受保护的文件清理 helper（批量；失败即停止行清理并保留现场）；
 * 3. 文件清理成功后，复用受保护的资料行清理 helper；
 * 4. 任一步失败聚合抛错，由调用方与原测试错误一并报告。
 */
function cleanupFixtures(ctx: SqlFixtureContext): void {
  const teardownErrors: string[] = [];
  const existingIds = readExistingFixtureIds(ctx.fixtures.map(({ row }) => row.id));
  const preservedIds = new Set<number>();

  for (const fixture of ctx.fixtures) {
    if (!existingIds.has(fixture.row.id) || fixture.mutations === null) {
      continue;
    }

    try {
      restoreMutatedReferenceDocumentFixtureRow(ctx.env, {
        id: fixture.row.id,
        title: fixture.row.title,
        createdByAccountId: fixture.row.createdByAccountId,
        mutations: fixture.mutations,
      });
    } catch (error) {
      preservedIds.add(fixture.row.id);
      teardownErrors.push(
        `夹具 ${fixture.row.id} 恢复失败（保留行与文件）：${toErrorMessage(error)}`,
      );
    }
  }

  const cleanable = ctx.fixtures.filter(
    ({ row }) => existingIds.has(row.id) && !preservedIds.has(row.id),
  );

  const fileTargets = cleanable
    .filter((fixture) => fixture.fileRow !== null)
    .map((fixture) => fileTargetOf(requireFileFixture(fixture)));

  let filesCleaned = true;

  if (fileTargets.length > 0) {
    try {
      deleteE2EReferenceDocumentStorageFiles(fileTargets);
    } catch (error) {
      filesCleaned = false;
      teardownErrors.push(
        `夹具上传文件清理失败（停止资料行清理，保留现场）：${toErrorMessage(error)}`,
      );
    }
  }

  if (filesCleaned) {
    const rowTargets = cleanable.map(({ row }) => cleanupTargetOf(row));

    if (rowTargets.length > 0) {
      try {
        deleteE2EReferenceDocumentRowsByIds(rowTargets);
      } catch (error) {
        teardownErrors.push(`夹具资料行清理失败：${toErrorMessage(error)}`);
      }
    }
  }

  if (teardownErrors.length > 0) {
    throw new Error(teardownErrors.join('；'));
  }
}

/**
 * 兜底清理（仅以本轮创建响应记录的精确 ID + 预期事实为删除边界）：
 * 1. 软删前的只读归属预检（评审 P2）：按精确 ID 核对目标行存在且标题 / 创建人 / 存储引用与
 *    本轮记录一致，任一缺失或字段不符即在**任何行被修改之前**抛错停止清理、保留现场
 *    （不能先软删、再等物理删除时才报错）；
 * 2. 标题反查仅用于报告「未记录却命中本轮关键字」的遗漏行，绝不并入软删 / 物理删除目标
 *    ——同标题异主行必须保持原样；
 * 3. 仅对本轮记录的精确 ID 经 API 软删（幂等：已删/不存在返回 NOT_FOUND，网络异常记为失败）；
 * 4. 软删后按本轮唯一标题反查，仍可见即视为残留，记为失败；
 * 5. 仅当目标库严格为专用隔离库且显式授权时，按精确 ID + 预期事实走受保护物理清理
 *    （事务内核验归属 / 存储引用 / 外部引用，任一残留非零即抛错）；
 * 6. 任一步失败即聚合抛错，让用例转红，不以警告吞掉。
 */
async function cleanupE2EDocuments(
  env: Record<string, string>,
  createdDocuments: readonly CreatedRunDocument[],
): Promise<void> {
  const failures: string[] = [];
  // 归属预检（评审 P2）：引用 pending / 目标行缺失 / 字段不符都会在此抛错，
  // 在软删之前停止，绝不先改行再报错。
  const targets = toCleanupTargets(createdDocuments);

  assertE2EReferenceDocumentOwnershipBeforeCleanup(targets);

  // 反查必须在软删前完成：软删后这些行对该筛选不可见，遗漏残留无从发现
  const discoveredIds = await findE2EDocumentIds(env);
  const { softDeleteIds, unexpectedIds } = planReferenceDocumentSoftDelete(
    createdDocuments.map(({ id }) => id),
    discoveredIds,
  );

  if (unexpectedIds.length > 0) {
    failures.push(
      `反查到本轮关键字但未记录的行（不自动删除，需人工核对）：${unexpectedIds.join(',')}`,
    );
  }

  for (const id of softDeleteIds) {
    try {
      await realGraphqlCall(env, SOFT_DELETE_MUTATION, { id }, 'mock_super_admin');
    } catch (error) {
      failures.push(`自建资料 ${id} 软删异常：${toErrorMessage(error)}`);
    }
  }

  const remaining = await findE2EDocumentIds(env);

  if (remaining.length > 0) {
    failures.push(`清理后仍可见本轮自建行：${remaining.join(',')}`);
  }

  if (isPhysicalCleanupEnabled(env) && targets.length > 0) {
    try {
      deleteE2EReferenceDocumentRowsByIds(targets);
    } catch (error) {
      failures.push(`自建资料物理清理失败：${toErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`E2E 自建参考资料清理失败——${failures.join('；')}`);
  }
}

test.describe('real backend reference document flow', () => {
  test.beforeEach(async () => {
    // 共享预检：普通入口返回跳过原因（保持既有 skip 语义），专用入口严格模式直接失败
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');
  });

  // T-03 主链路：管理员登录 → 列表（种子可见、已软删不可见）→ 新增指定型号资料 →
  // 成功页 → 详情 → 编辑 → 刷新持久 → 软删回列表且消失 → API 重复软删 NOT_FOUND（不幂等）。
  // 自建行经 runWithCleanup 兜底清理；清理失败与主断言错误一并报告。
  test('super admin full journey: list, create, edit, reload persistence and soft delete', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const env = readBackendEnv();
    // 本轮创建人账号（JWT 口径，测试自身掌握）：物理清理的预期事实之一，写入前取得
    const createdByAccountId = await realLoginAccountId(env, 'mock_super_admin');
    // 本轮创建响应 / 详情 URL 给出的精确目标记录（id + 创建时立即记录的预期事实）
    const createdDocuments: CreatedRunDocument[] = [];

    await runWithCleanup(
      async () => {
        await page.goto('/login');
        await page.getByLabel('账号或邮箱').fill('mock_super_admin');
        await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
        await page.getByRole('button', { name: /登\s*录/ }).click();
        await expect(page).toHaveURL(/\/admin$/);

        // 导航入口可见（F-09）：S3 中文化后菜单标签为「参考资料」
        await expect(
          page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '参考资料' }),
        ).toBeVisible();

        // 列表：种子资料可见（按创建时间倒序），已软删的 970004 不可见
        await page.goto(LIST_PATH);
        await expect(page.getByRole('heading', { name: '参考资料库' })).toBeVisible();
        await expect(page.getByText(SEED_ERROR_MANUAL_TITLE)).toBeVisible();
        await expect(page.getByText(SEED_MAINTENANCE_GUIDE_TITLE)).toBeVisible();
        await expect(page.getByText(SEED_SAFETY_STANDARD_TITLE)).toBeVisible();
        await expect(page.getByText(SEED_DEPRECATED_TITLE)).toHaveCount(0);

        // 新增指定型号资料（标题含运行唯一标识，跨运行/并行执行永不撞名）
        await page.getByRole('button', { name: '新增资料' }).click();
        await expect(page).toHaveURL(new RegExp(NEW_PAGE_PATH));
        // 就绪判据（S3-1 修复）：URL 由 pushState 先行变更，SPA 尚未提交新路由时列表页仍在 DOM，
        // 其搜索框 aria-label「按文档标题搜索」会被 getByLabel('文档标题') 子串命中（Playwright
        // 默认非精确匹配），导致 fill 落在列表搜索框而创建表单标题为空；必须等创建页渲染完成再填表。
        // 评审修复轮 P3-2：这里连同 { exact: true } 一起收口——就绪判据管时序、精确匹配管子串歧义，
        // 两者互补；即便将来路由切换时序再变，fill 也不会落到「按文档标题搜索」上。
        await expect(page.getByRole('heading', { name: '新增参考资料' })).toBeVisible();
        await page.getByLabel('文档标题', { exact: true }).fill(`${RUN_TITLE_KEYWORD}（光闸维护）`);
        // AntD Select 交互按维修申请先例：点击 combobox 打开下拉后点 option（label 点击不展开下拉）
        await page.getByRole('combobox').nth(0).click();
        await page.locator('.ant-select-item-option', { hasText: '检查表' }).click();
        // 型号下拉选项走真实 equipmentModels 查询，加载完成前 disabled，先等可用
        await expect(page.getByRole('combobox').nth(1)).toBeEnabled({ timeout: 10_000 });
        await page.getByRole('combobox').nth(1).click();
        await page.locator('.ant-select-item-option', { hasText: 'NXT:1980Di' }).click();
        await page.getByLabel('文档说明').fill('阶段三真实后端 e2e 自建行。');
        await page.getByLabel('文本内容').fill('# 光闸维护检查表\n\n每周检查光闸联锁与急停按钮。');
        // 点击创建前先注册 GraphQL 响应监听：创建响应一返回即捕获精确 ID 并立即记录本轮预期事实，
        // 早于成功页 / 详情页任何断言——即使后续断言或跳转失败，清理仍能按该 ID 执行。
        const createResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/graphql') &&
            response.request().method() === 'POST' &&
            (response.request().postData() ?? '').includes('createReferenceDocument'),
        );

        await page.getByRole('button', { name: /创建资料/ }).click();

        const createResponse = await createResponsePromise;
        const createBody = (await createResponse.json().catch(() => null)) as {
          data?: { createReferenceDocument?: { id?: unknown } };
        } | null;

        createdDocuments.push({
          id: requirePositiveReferenceDocumentId(
            createBody?.data?.createReferenceDocument?.id,
            '创建响应',
          ),
          title: `${RUN_TITLE_KEYWORD}（光闸维护）`,
          createdByAccountId,
          // 纯文本创建：确认无存储引用（none），区别于文件路径尚未取得引用的 pending
          storageReference: { status: 'none' },
          originalFilename: null,
          mimeType: null,
        });

        // 成功页 → 查看详情（ID 已在上面按创建响应记录，不再依赖详情 URL）
        await expect(page.getByText('参考资料创建成功')).toBeVisible();
        await page.getByRole('button', { name: '查看详情' }).click();
        await expect(page).toHaveURL(/\/reference-documents\/\d+$/);

        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（光闸维护）`).first()).toBeVisible();
        // 精确匹配：正文「光闸维护检查表」含同文子串，避免 strict mode violation（memory 先例）
        await expect(page.getByText('检查表', { exact: true })).toBeVisible();
        await expect(page.getByText('ASML TWINSCAN NXT:1980Di')).toBeVisible();
        await expect(page.getByText(/每周检查光闸联锁/)).toBeVisible();

        // 编辑：改标题 → 保存后详情刷新（仍含运行唯一标识，清理反查不变）
        await page.getByRole('button', { name: /编\s*辑/ }).click();
        await page
          .getByLabel('文档标题', { exact: true })
          .fill(`${RUN_TITLE_KEYWORD}（光闸维护·已改）`);
        await page.getByRole('button', { name: /保存修改/ }).click();
        await expect(page.getByText('参考资料已保存。')).toBeVisible();
        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（光闸维护·已改）`).first()).toBeVisible();
        // 标题已变更：同步本轮预期事实，使物理清理核验的是库中当前标题
        createdDocuments[0].title = `${RUN_TITLE_KEYWORD}（光闸维护·已改）`;

        // 刷新持久（T-03：刷新仍在）
        await page.reload();
        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（光闸维护·已改）`).first()).toBeVisible();

        // 软删：二次确认 → 回列表且该行消失
        await page.getByRole('button', { name: '删 除' }).click();
        await page.getByRole('button', { name: '确认删除' }).click();
        await expect(page.getByText('参考资料已删除。')).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（光闸维护·已改）`)).toHaveCount(0);

        // 软删不幂等（区别于维修申请裁定 5）：API 重复删除返回统一 NOT_FOUND，
        // 本次运行的行已全部不可见
        const remainingIds = await findE2EDocumentIds(env);
        expect(remainingIds).toEqual([]);
      },
      () => cleanupE2EDocuments(env, createdDocuments),
    );
  });

  // T-03 筛选正确：类型等值筛选只命中目标资料；清空筛选恢复全量（种子行只读）
  test('list filter by document type narrows results and resets', async ({ page }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_super_admin');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto(LIST_PATH);
    await expect(page.getByText(SEED_ERROR_MANUAL_TITLE)).toBeVisible();

    // PR5 R2：筛选区默认收起（不渲染）；先经工具区「筛选」按钮展开，再操作类型下拉。
    // 展开前不假设 combobox 存在；下拉以 placeholder 文案锚定，不依赖 DOM 顺序。
    const filterPanel = page.locator('.reference-library-filter-panel');
    await expect(filterPanel).toHaveCount(0);
    const filterButton = page.getByRole('button', { name: '筛选' });
    await filterButton.click();
    await expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    await expect(filterPanel).toBeVisible();

    const documentTypeSelect = filterPanel.locator('.ant-select', { hasText: '文档类型' });
    await expect(documentTypeSelect).toBeVisible();
    await documentTypeSelect.getByRole('combobox').click();
    await page.locator('.ant-select-item-option', { hasText: '维护指南' }).click();

    await expect(page.getByText(SEED_MAINTENANCE_GUIDE_TITLE)).toBeVisible();
    await expect(page.getByText(SEED_ERROR_MANUAL_TITLE)).toHaveCount(0);
    await expect(page.getByText(SEED_SAFETY_STANDARD_TITLE)).toHaveCount(0);

    // 清空筛选恢复全量（AntD allowClear 的清除按钮需 hover 后出现）；选中后 placeholder
    // 已被值替换，改按选中值锚定同一控件
    const selectedTypeSelect = filterPanel.locator('.ant-select', { hasText: '维护指南' });
    await selectedTypeSelect.hover();
    await selectedTypeSelect.locator('.ant-select-clear').click();
    await expect(page.getByText(SEED_ERROR_MANUAL_TITLE)).toBeVisible();
    await expect(page.getByText(SEED_SAFETY_STANDARD_TITLE)).toBeVisible();
  });

  // T-03/T-04 工程师只读：列表与详情可达（读权限），无新增/编辑/删除入口；
  // 新增页被角色拒绝清单拦截（避免「能进页面但提交必被拒」的残缺中间态）
  test('engineer can read list and detail but has no write entry', async ({ page }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_engineer_chen');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/engineer$/);

    await page.goto(LIST_PATH);
    await expect(page.getByText(SEED_ERROR_MANUAL_TITLE)).toBeVisible();
    await expect(page.getByRole('button', { name: '新增资料' })).toHaveCount(0);

    // 详情只读：完整内容可见，无编辑/删除入口
    await page.getByText(SEED_MAINTENANCE_GUIDE_TITLE).click();
    await expect(page.getByRole('heading', { name: '参考资料详情' })).toBeVisible();
    await expect(page.getByText(SEED_MAINTENANCE_GUIDE_TITLE).first()).toBeVisible();
    await expect(page.getByText(/E-LASER-207/)).toBeVisible();
    await expect(page.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删 除' })).toHaveCount(0);

    // 下载入口三角色可见（种子 970002 带原始文件名）：工程师只读但可下载
    await expect(page.getByRole('button', { name: /下载文件/ })).toBeVisible();

    // 新增页被拒绝清单拦截，安全跳转回工程师主页
    await page.goto(NEW_PAGE_PATH);
    await expect(page).toHaveURL(/\/engineer$/);
  });

  // T-04 角色矩阵：客户页面被安全跳转回个人主页、导航无入口；
  // 越权直调 GraphQL 读/写均被后端 FORBIDDEN 拒绝（seed 行只读，无污染）
  test('customer is redirected away and blocked from graphql read and write', async ({ page }) => {
    const env = readBackendEnv();

    await page.goto('/login');
    await page.getByLabel('账号或邮箱').fill('mock_customer_alpha');
    await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/customer$/);

    // 导航无「参考资料库」入口（F-09 角色过滤）
    await expect(page.getByText('参考资料库')).toHaveCount(0);

    // 页面访问被角色根路径表拦截，安全跳转回个人主页
    await page.goto(LIST_PATH);
    await expect(page).toHaveURL(/\/customer$/);

    // 越权直调读接口 → FORBIDDEN
    const readDenied = await realGraphqlCall(
      env,
      LIST_DOCUMENTS_QUERY,
      { pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true } },
      'mock_customer_alpha',
    );
    const readErrors = (readDenied.body as { errors?: Array<{ extensions?: { code?: string } }> })
      .errors;
    expect(readErrors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    // 越权直调写接口 → FORBIDDEN（自建行不会落库）
    const writeDenied = await realGraphqlCall(
      env,
      `mutation CreateReferenceDocument($input: CreateReferenceDocumentInput!) {
        createReferenceDocument(input: $input) { id }
      }`,
      {
        input: {
          title: `${RUN_TITLE_KEYWORD}（客户越权探测）`,
          documentType: 'CHECKLIST',
          equipmentModelId: null,
          description: null,
          contentText: '越权探测正文',
        },
      },
      'mock_customer_alpha',
    );
    const writeErrors = (writeDenied.body as { errors?: Array<{ extensions?: { code?: string } }> })
      .errors;
    expect(writeErrors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    // 越权写确实未落库（列表中无本次运行创建的行）
    expect(await findE2EDocumentIds(env)).toEqual([]);
  });

  // 0909 第二轮阻塞项 1 主链路：管理员 UI 上传真实小文件创建（仅文件、正文留空）→
  // 列表「原始文件名」列 → 详情元数据（含下载入口）→ 浏览器下载事件断言文件名与字节 →
  // Node 侧 REST 下载字节比对 → 软删消失；存储物理文件按本次运行的精确引用路径清理。
  test('super admin file upload and download journey via rest multipart', async ({ page }) => {
    test.setTimeout(90_000);
    const env = readBackendEnv();
    // 本轮创建人账号（JWT 口径，测试自身掌握）：物理清理的预期事实之一，写入前取得
    const createdByAccountId = await realLoginAccountId(env, 'mock_super_admin');
    const createdDocuments: CreatedRunDocument[] = [];
    const uploadBytes = new TextEncoder().encode(
      '# 光闸联锁检修记录\n\n每周检查光闸联锁与急停按钮，异常时按 A-3 流程处置。',
    );
    const uploadFilename = `optics-check-${RUN_ID}.md`;

    await runWithCleanup(
      async () => {
        await page.goto('/login');
        await page.getByLabel('账号或邮箱').fill('mock_super_admin');
        await page.getByLabel('密码').fill(env.MOCK_SEED_PASSWORD);
        await page.getByRole('button', { name: /登\s*录/ }).click();
        await expect(page).toHaveURL(/\/admin$/);

        await page.goto(LIST_PATH);
        await expect(page.getByRole('heading', { name: '参考资料库' })).toBeVisible();
        await page.getByRole('button', { name: '新增资料' }).click();
        await expect(page).toHaveURL(new RegExp(NEW_PAGE_PATH));
        // 同 S3-1 修复：等创建页提交后再填表；并用 { exact: true } 避开列表页「按文档标题搜索」
        // 搜索框的子串命中（评审修复轮 P3-2）
        await expect(page.getByRole('heading', { name: '新增参考资料' })).toBeVisible();
        await page.getByLabel('文档标题', { exact: true }).fill(`${RUN_TITLE_KEYWORD}（文件上传）`);
        await page.getByRole('combobox').nth(0).click();
        await page.locator('.ant-select-item-option', { hasText: '检查表' }).click();

        // 仅文件创建：正文留空（双空拦截不触发，文件已提供），经 Upload 手动模式暂存
        await page.setInputFiles('input[type="file"]', {
          buffer: Buffer.from(uploadBytes),
          mimeType: 'text/markdown',
          name: uploadFilename,
        });
        await expect(page.getByText(uploadFilename)).toBeVisible();
        // 点击创建前先注册 REST 上传响应监听（文件创建走 multipart，非 GraphQL）：响应一返回
        // 即捕获精确 ID 并**立即登记**本轮清理目标（引用先置 pending），早于成功页 / 详情页任何
        // 断言——即使后续查询 / 断言 / 跳转失败，清理仍能按该精确 ID 失败关闭并报告（不按标题
        // 猜测归属，也不按前缀扩大范围）。
        const uploadResponsePromise = page.waitForResponse(
          (response) =>
            response.url().includes('/api/reference-documents/upload') &&
            response.request().method() === 'POST',
        );

        await page.getByRole('button', { name: /创建资料/ }).click();

        const uploadResponse = await uploadResponsePromise;
        const uploadBody = (await uploadResponse.json().catch(() => null)) as {
          data?: { id?: unknown };
        } | null;
        const createdId = requirePositiveReferenceDocumentId(uploadBody?.data?.id, '上传响应');
        // 先登记精确 ID（引用状态 pending=尚未取得），再解析存储引用并补回该记录：
        // 查询抛错 / 引用非法时记录保持 pending，精确 ID 始终可被清理看见（评审 P3）。
        const registered = registerUploadedReferenceDocument(
          createdDocuments,
          {
            id: createdId,
            title: `${RUN_TITLE_KEYWORD}（文件上传）`,
            createdByAccountId,
            originalFilename: uploadFilename,
            mimeType: 'text/markdown',
          },
          // 服务端生成的存储引用：创建后读取一次并记录为本轮预期事实（删除时不再回读当前行引用）
          () => findReferenceDocumentStorageReferenceById(createdId),
        );

        expect(registered.storageReference.status).toBe('resolved');

        // 成功页 → 查看详情（ID 已在上面按上传响应记录，不再依赖详情 URL）
        await expect(page.getByText('参考资料创建成功')).toBeVisible();
        await page.getByRole('button', { name: '查看详情' }).click();
        await expect(page).toHaveURL(/\/reference-documents\/\d+$/);

        // 详情元数据：原始文件名 / 文件类型落库；仅文件创建无正文；下载入口恒显
        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（文件上传）`).first()).toBeVisible();
        await expect(page.getByText(uploadFilename).first()).toBeVisible();
        await expect(page.getByText('text/markdown')).toBeVisible();
        await expect(page.getByText('该资料暂无文本内容（仅存储引用）。')).toBeVisible();
        await expect(page.getByRole('button', { name: /下载文件/ })).toBeVisible();

        // 浏览器下载：Playwright download 事件断言文件名与字节内容一致
        const downloadPromise = page.waitForEvent('download');

        await page.getByRole('button', { name: /下载文件/ }).click();

        const download = await downloadPromise;

        expect(download.suggestedFilename()).toBe(uploadFilename);
        expect(new Uint8Array(readFileSync(await download.path()))).toEqual(uploadBytes);

        // Node 侧 REST 直连下载：Content-Type 与字节与上传一致（服务端存储往返无损）
        const restDownload = await realRestDownload(env, createdId);

        expect(restDownload.status).toBe(200);
        expect(restDownload.contentType).toBe('text/markdown');
        expect(restDownload.contentDisposition).toContain(uploadFilename);
        expect(new Uint8Array(restDownload.buffer)).toEqual(uploadBytes);

        // 列表「原始文件名」列展示上传文件名
        await page.goto(LIST_PATH);
        await expect(page.getByText(uploadFilename)).toBeVisible();

        // 回到详情后软删：二次确认 → 回列表且该行消失
        await page.goto(`/reference-documents/${createdId}`);
        await expect(page.getByText(`${RUN_TITLE_KEYWORD}（文件上传）`).first()).toBeVisible();
        await page.getByRole('button', { name: '删 除' }).click();
        await page.getByRole('button', { name: '确认删除' }).click();
        await expect(page.getByText('参考资料已删除。')).toBeVisible();
        await expect(page.getByText(uploadFilename)).toHaveCount(0);
      },
      async () => {
        // 先核验再删上传文件（删除目标为本轮记录的精确引用，不回读当前行；删除前核验需要目标行
        // 仍存在，故文件清理先于物理删行），再走受保护的数据库行清理；两者错误一并报告，
        // 任一失败即让用例转红，不再以 console.warn 吞掉。
        const failures: string[] = [];
        // 顺序收紧：文件核验 / 删除失败即「失败关闭」——跳过本批资料行的软删与物理删行，
        // 保留行与文件供人工核查。否则（如文件名 / MIME 变为 NULL）修正 SQL 后文件虽被保留，
        // 行仍可能被删除，现场被破坏。
        let fileCleanupFailed = false;

        try {
          deleteE2EReferenceDocumentStorageFiles(toStorageFileTargets(createdDocuments));
        } catch (error) {
          fileCleanupFailed = true;
          failures.push(`上传文件物理清理失败：${toErrorMessage(error)}`);
        }

        if (!fileCleanupFailed) {
          try {
            await cleanupE2EDocuments(env, createdDocuments);
          } catch (error) {
            failures.push(toErrorMessage(error));
          }
        }

        if (failures.length > 0) {
          throw new Error(`E2E 自建参考资料清理失败——${failures.join('；')}`);
        }
      },
    );
  });

  // P3b 真实 SQL 回归：可空字段（storage_reference / original_filename / mime_type）被改成 NULL 时，
  // 三条受保护入口的核验 SQL 必须把不一致计入 field_mismatch_rows 并失败关闭——行保持未软删 /
  // 未物理删除、文件保留；同批一条不符时整批零删除。反向对照：预期与实际均为 NULL 的文本资料、
  // 正常文件资料必须核验通过并完成清理（NULL 安全比较不得误判）。
  //
  // 夹具写入（插入 / 故意改 NULL / 恢复）统一经 runGuardedFixtureWrite（授权门 + 严格 lithography_e2e
  // 库名门 + 实际 DATABASE() 复查）；收尾先对仍在库、被故意改 NULL 的夹具「先核验后恢复」，再复用受
  // 保护的文件 / 资料行清理 helper（不再直接 DELETE / rmSync）；文件清理失败即停止行清理，收尾错误经
  // runWithCleanup 与原测试错误一并报告。操作一律以本轮登记的精确 ID 为边界并校验标题 / 创建人。
  test('nullable column NULL mismatch fails closed with zero deletion (real sql)', async () => {
    test.setTimeout(90_000);
    const env = readBackendEnv();

    // 本文件只由专用入口收集（lithography_e2e + 显式授权）；仍自行复查，缺失即硬失败，不以 skip 掩盖。
    if (!isPhysicalCleanupEnabled(env)) {
      throw new Error(
        `真实 SQL 回归要求专用隔离库 lithography_e2e 且显式设置 E2E_ALLOW_PHYSICAL_CLEANUP=1，当前 DB_NAME=${JSON.stringify(env.DB_NAME)}，拒绝在非专用环境执行`,
      );
    }

    const createdByAccountId = await realLoginAccountId(env, 'mock_super_admin');
    const ctx: SqlFixtureContext = { env, createdByAccountId, fixtures: [] };

    const fileFixture = (suffix: string): FileSqlFixtureRow => createFileFixture(ctx, suffix);

    const textFixture = (suffix: string): SqlFixtureRow => createTextFixture(ctx, suffix);

    const recordMutation = (
      id: number,
      mutations: ReferenceDocumentFixtureColumnMutation[],
    ): void => {
      recordFixtureMutation(ctx, id, mutations);
    };

    await runWithCleanup(
      async () => {
        // 用例 1：预期非空引用 → 实际 NULL。归属预检 / 物理清理 / 文件核验三条入口都失败关闭，
        // 行未软删、文件保留。（同时改 storage_backend、补 content_text 以满足表 CHECK 约束）
        const refNullCase = fileFixture('ref-null');

        recordMutation(refNullCase.id, [
          {
            column: 'storage_reference',
            manufacturedValue: null,
            originalValue: refNullCase.storageReference,
          },
          {
            column: 'storage_backend',
            manufacturedValue: null,
            originalValue: refNullCase.storageBackend,
          },
          { column: 'content_text', manufacturedValue: 'mutated', originalValue: null },
        ]);
        runGuardedFixtureWrite(
          env,
          `UPDATE reference_document SET storage_reference = NULL, storage_backend = NULL, content_text = 'mutated' WHERE id = ${refNullCase.id}`,
        );

        expect(() =>
          assertE2EReferenceDocumentOwnershipBeforeCleanup([cleanupTargetOf(refNullCase)]),
        ).toThrow(/归属预检/);
        expect(() => deleteE2EReferenceDocumentRowsByIds([cleanupTargetOf(refNullCase)])).toThrow();
        expect(() => deleteE2EReferenceDocumentStorageFiles([fileTargetOf(refNullCase)])).toThrow(
          /核验失败/,
        );
        expect(readSqlFixtureRowState(refNullCase.id)).toEqual({
          exists: true,
          deprecated: 0,
          storageReference: null,
        });
        expect(existsSync(refNullCase.filePath)).toBe(true);

        // 用例 2：预期非空原始文件名 → 实际 NULL。文件核验失败关闭，行未软删、文件保留。
        const filenameNullCase = fileFixture('filename-null');

        recordMutation(filenameNullCase.id, [
          {
            column: 'original_filename',
            manufacturedValue: null,
            originalValue: filenameNullCase.originalFilename,
          },
        ]);
        runGuardedFixtureWrite(
          env,
          `UPDATE reference_document SET original_filename = NULL WHERE id = ${filenameNullCase.id}`,
        );

        expect(() =>
          deleteE2EReferenceDocumentStorageFiles([fileTargetOf(filenameNullCase)]),
        ).toThrow(/核验失败/);
        expect(readSqlFixtureRowState(filenameNullCase.id)).toEqual({
          exists: true,
          deprecated: 0,
          storageReference: filenameNullCase.storageReference,
        });
        expect(existsSync(filenameNullCase.filePath)).toBe(true);

        // 用例 3：预期非空 MIME → 实际 NULL。同上。
        const mimeNullCase = fileFixture('mime-null');

        recordMutation(mimeNullCase.id, [
          { column: 'mime_type', manufacturedValue: null, originalValue: mimeNullCase.mimeType },
        ]);
        runGuardedFixtureWrite(
          env,
          `UPDATE reference_document SET mime_type = NULL WHERE id = ${mimeNullCase.id}`,
        );

        expect(() => deleteE2EReferenceDocumentStorageFiles([fileTargetOf(mimeNullCase)])).toThrow(
          /核验失败/,
        );
        expect(readSqlFixtureRowState(mimeNullCase.id)).toEqual({
          exists: true,
          deprecated: 0,
          storageReference: mimeNullCase.storageReference,
        });
        expect(existsSync(mimeNullCase.filePath)).toBe(true);

        // 用例 4：预期与实际均为 NULL 的文本资料。NULL 安全比较不得误判为不符：只读归属预检通过，
        // 随后按精确 ID 物理清理成功。
        const textNullCase = textFixture('both-null');

        expect(() =>
          assertE2EReferenceDocumentOwnershipBeforeCleanup([cleanupTargetOf(textNullCase)]),
        ).not.toThrow();
        expect(() =>
          deleteE2EReferenceDocumentRowsByIds([cleanupTargetOf(textNullCase)]),
        ).not.toThrow();
        expect(readSqlFixtureRowState(textNullCase.id).exists).toBe(false);

        // 用例 5：正常文件资料。核验通过 → 文件被删除 → 行被物理删除。
        const normalCase = fileFixture('normal');

        expect(() =>
          deleteE2EReferenceDocumentStorageFiles([fileTargetOf(normalCase)]),
        ).not.toThrow();
        expect(existsSync(normalCase.filePath)).toBe(false);
        expect(() =>
          deleteE2EReferenceDocumentRowsByIds([cleanupTargetOf(normalCase)]),
        ).not.toThrow();
        expect(readSqlFixtureRowState(normalCase.id).exists).toBe(false);

        // 用例 6：同批两条目标、一条不符即整批零删除（行与文件都不动）。
        const batchMismatch = fileFixture('batch-mismatch');
        const batchIntact = fileFixture('batch-intact');

        recordMutation(batchMismatch.id, [
          {
            column: 'storage_reference',
            manufacturedValue: null,
            originalValue: batchMismatch.storageReference,
          },
          {
            column: 'storage_backend',
            manufacturedValue: null,
            originalValue: batchMismatch.storageBackend,
          },
          { column: 'content_text', manufacturedValue: 'mutated', originalValue: null },
        ]);
        runGuardedFixtureWrite(
          env,
          `UPDATE reference_document SET storage_reference = NULL, storage_backend = NULL, content_text = 'mutated' WHERE id = ${batchMismatch.id}`,
        );

        expect(() =>
          deleteE2EReferenceDocumentRowsByIds([
            cleanupTargetOf(batchMismatch),
            cleanupTargetOf(batchIntact),
          ]),
        ).toThrow();
        expect(readSqlFixtureRowState(batchMismatch.id).exists).toBe(true);
        expect(readSqlFixtureRowState(batchIntact.id).exists).toBe(true);

        expect(() =>
          deleteE2EReferenceDocumentStorageFiles([
            fileTargetOf(batchMismatch),
            fileTargetOf(batchIntact),
          ]),
        ).toThrow(/核验失败/);
        expect(existsSync(batchMismatch.filePath)).toBe(true);
        expect(existsSync(batchIntact.filePath)).toBe(true);
      },
      () => cleanupFixtures(ctx),
    );
  });

  // 写文件失败回归：登记必须先于写入——向创建函数注入会抛错的写入动作，验证「取到 ID 并登记后
  // 写文件失败」时收尾仍能按已登记的精确 ID 清理该资料行与路径（与主用例共享同一份 cleanupFixtures）。
  test('file fixture registers its id before writing so teardown still cleans when the write fails (real sql)', async () => {
    test.setTimeout(60_000);
    const env = readBackendEnv();

    if (!isPhysicalCleanupEnabled(env)) {
      throw new Error(
        `真实 SQL 回归要求专用隔离库 lithography_e2e 且显式设置 E2E_ALLOW_PHYSICAL_CLEANUP=1，当前 DB_NAME=${JSON.stringify(env.DB_NAME)}，拒绝在非专用环境执行`,
      );
    }

    const createdByAccountId = await realLoginAccountId(env, 'mock_super_admin');
    const ctx: SqlFixtureContext = { env, createdByAccountId, fixtures: [] };

    await runWithCleanup(
      async () => {
        expect(() =>
          createFileFixture(ctx, 'write-fail', () => {
            throw new Error('注入的写文件失败');
          }),
        ).toThrow('注入的写文件失败');

        // 写失败后该行仍在本轮登记清单中（登记早于写文件），并可被只读回读命中
        expect(ctx.fixtures).toHaveLength(1);

        const registered = ctx.fixtures[0];

        if (registered === undefined) {
          throw new Error('写文件失败后未在本轮登记清单中看到已创建的资料行');
        }

        expect(readExistingFixtureIds([registered.row.id]).has(registered.row.id)).toBe(true);
      },
      () => cleanupFixtures(ctx),
    );

    // 收尾后：登记的资料行已删除、登记的文件路径无残留
    const registered = ctx.fixtures[0];

    if (registered === undefined) {
      throw new Error('夹具登记丢失，无法核对零残留');
    }

    expect(readExistingFixtureIds([registered.row.id]).has(registered.row.id)).toBe(false);
    expect(existsSync(requireFileFixture(registered).filePath)).toBe(false);
  });
});
