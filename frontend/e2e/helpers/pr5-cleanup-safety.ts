// e2e/helpers/pr5-cleanup-safety.ts
//
// PR5 清理安全集成组的共享基建（Codex 结束报告复验计划 P2-2 / S3）。
//
// 目标：为「清理 helper 的真实数据安全」提供**真实 MySQL** 反例证据，而不是用
// mock SQL 字符串或「先清空全表再 Seed」的绿色 E2E 代替。
//
// 硬边界（见计划 §4.2）：
// 1. 只允许 `DB_NAME=lithography_e2e`，且必须 `E2E_ALLOW_PHYSICAL_CLEANUP=1` 显式 opt-in；
// 2. SQL 实际连接库必须与配置库一致（复用 assertPr5DedicatedEnvironment）；
// 3. 只检查现有 schema，**不执行 TRUNCATE / Migration / 全量 Seed**；schema 缺失直接失败；
// 4. 获取与既有真实 E2E 同名的数据库执行锁，禁止与全表 drill 并行；
// 5. 密码只经 MYSQL_PWD 注入（见 real-backend.mysqlQuery）；ledger / 回执 / 错误均不含凭据。
//
// 造数与所有权（见计划 §4.3）：
// - 所有主键由数据库生成（INSERT 后立即读回 LAST_INSERT_ID）；
// - 运行级不可猜标识同时写入多个可核验字段（标题关键字 / 故障描述 / 故障码 / 回复正文）；
// - FK 只引用既有专用 Seed 账号与型号（只读快照，测试绝不改写这些共享行）；
// - 每创建一层即追加 ledger；回收只按「ledger ID + 完整字段绑定 + 引用闭包」。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import { acquireExecutionLock } from './execution-lock';
import {
  assertPr5DedicatedEnvironment,
  assertPr5EngineerResponseBindingBound,
  assertPr5RepairRequestBindingBound,
  assertPr5RowSnapshotShape,
  buildPr5ColumnAssignment,
  buildPr5DocKeyword,
  createPr5RowSnapshot,
  deletePr5EngineerResponseRowsBound,
  deletePr5ReferenceDocumentBound,
  deletePr5RepairRequestBound,
  diffPr5ColumnSets,
  findPr5ReferenceDocumentIdsByKeyword,
  PR5_DOC_KEYWORD_PATTERN,
  PR5_RESPONSE_TEXT_PATTERN,
  PR5_SEED_LOGIN_NAMES,
  type Pr5CleanupTable,
  type Pr5EngineerResponseBinding,
  type Pr5ReferenceDocumentBinding,
  type Pr5RepairRequestBinding,
  type Pr5RowSnapshot,
  readPr5CanonicalColumns,
  readPr5ColumnSpecs,
  readPr5EngineerResponseBindingFromDb,
  readPr5FullRowSnapshot,
  readPr5ReferenceDocumentBindingFromDb,
  readPr5ReferenceDocumentStorageReferenceBound,
  readPr5SnapshotColumn,
} from './pr5-real-flow';
import {
  deleteE2EReferenceDocumentStorageFileByReference,
  mysqlQuery,
  REQUEST_NO_PATTERN,
} from './real-backend';

/** 本组读取的现有 schema 表（只读检查；缺失即失败并给出初始化说明，绝不 TRUNCATE/Migration） */
export const PR5_CLEANUP_SAFETY_REQUIRED_TABLES = [
  'base_user_account',
  'base_user_info',
  'equipment_model',
  'repair_request',
  'engineer_response',
  'reference_document',
  'ai_conversation',
  'ai_report',
  'migrations',
] as const;

/** 运行级标识白名单：只含小写字母数字，天然无引号 / 通配符 / 路径语义 */
export const PR5_CLEANUP_SAFETY_RUN_ID_PATTERN = /^[a-z0-9]{8,32}$/;

/** 只读计数 / 反查允许的表白名单 */
const PR5_CLEANUP_SAFETY_TABLES = [
  'repair_request',
  'engineer_response',
  'reference_document',
] as const;
type Pr5CleanupSafetyTable = (typeof PR5_CLEANUP_SAFETY_TABLES)[number];

/** 生成运行级不可猜标识（[a-z0-9]{8,32}，可安全并入 SQL 字符串字面量） */
export function createPr5CleanupSafetyRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

/** 本轮资料标题关键字（清理的唯一绑定因子之一），复用 S5 同一前缀与白名单 */
export function buildPr5CleanupSafetyKeyword(runId: string): string {
  assertRunId(runId);

  const keyword = buildPr5DocKeyword(runId);

  if (!PR5_DOC_KEYWORD_PATTERN.test(keyword)) {
    throw new Error(`清理安全组关键字未通过白名单校验：${JSON.stringify(keyword)}`);
  }

  return keyword;
}

/** 本轮故障标记（写入 fault_description / content_md，供残留按标识定位） */
export function buildPr5CleanupSafetyFaultTag(runId: string): string {
  assertRunId(runId);

  return `PR5清理安全组·${runId}`;
}

function assertRunId(runId: string): void {
  if (!PR5_CLEANUP_SAFETY_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`清理安全组运行标识未通过白名单校验：${JSON.stringify(runId)}`);
  }
}

function assertCleanupSafetyTable(table: string): asserts table is Pr5CleanupSafetyTable {
  if (!(PR5_CLEANUP_SAFETY_TABLES as readonly string[]).includes(table)) {
    throw new Error(`清理安全组查询目标表未通过白名单校验，拒绝查询：${JSON.stringify(table)}`);
  }
}

function readSingleCountOrThrow(sql: string, context: string): number {
  const value = Number(mysqlQuery(sql));

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context}计数结果异常：${JSON.stringify(value)}`);
  }

  return value;
}

/**
 * 环境门（计划 §4.2 第 1/2/3/5 项）：复用 S5 的专用环境断言（库名 + 显式授权 + 实际连接库一致），
 * 再只读检查现有 schema。**不执行任何 TRUNCATE / Migration / Seed**。
 */
export function assertPr5CleanupSafetyEnvironment(): void {
  assertPr5DedicatedEnvironment();

  const placeholders = PR5_CLEANUP_SAFETY_REQUIRED_TABLES.map((table) => `'${table}'`).join(', ');
  const found = readSingleCountOrThrow(
    `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    '专用隔离库 schema',
  );

  if (found !== PR5_CLEANUP_SAFETY_REQUIRED_TABLES.length) {
    throw new Error(
      `专用隔离库 ${DEDICATED_E2E_DB_NAME} schema 不完整：期望 ${PR5_CLEANUP_SAFETY_REQUIRED_TABLES.length} 张表，实际 ${found} 张。` +
        '本组不执行 TRUNCATE/Migration/Seed，请先在专用库上初始化后重试：' +
        `\n  cd backend && DB_NAME=${DEDICATED_E2E_DB_NAME} npm run migration:drill:empty-db && DB_NAME=${DEDICATED_E2E_DB_NAME} npm run seed:mock`,
    );
  }

  // canonical 列清单必须与真实库 information_schema 完全一致（多列 / 缺列 / 重复即失败，杜绝字段集漂移）
  assertPr5CleanupSafetySchemaMatchesCanonical();
}

/** 数据库执行锁（计划 §4.2 第 4 项）：与既有真实 E2E 同名，禁止与全表 drill 并行 */
export function acquirePr5CleanupSafetyExecutionLock(): () => void {
  return acquireExecutionLock(DEDICATED_E2E_DB_NAME);
}

/**
 * 执行锁释放会话（S3）：把「是否已获取锁」与「释放」解耦，使 `beforeAll` 在**获取锁之前**
 * 失败（环境门 / schema / 连接 / 获取锁本身抛错）时，`afterAll` 不会调用未初始化的释放函数，
 * 从而不产生二次异常覆盖根因。释放严格一次性（幂等）。
 */
export interface Pr5CleanupSafetyLockSession {
  /** 已执行的释放次数（未登记释放函数时为 0） */
  readonly releaseCount: number;
  /** 登记已成功获取的释放函数；已登记时重复登记直接抛错（防止静默覆盖） */
  setRelease(release: () => void): void;
  /** 释放：仅在已登记时执行，且只执行一次；未登记 / 重复调用都是安全空操作 */
  release(): void;
}

export function createPr5CleanupSafetyLockSession(): Pr5CleanupSafetyLockSession {
  let pending: (() => void) | null = null;
  let count = 0;

  return {
    get releaseCount(): number {
      return count;
    },
    release(): void {
      if (pending === null) {
        return;
      }

      const release = pending;
      pending = null;
      count += 1;
      release();
    },
    setRelease(release: () => void): void {
      if (pending !== null) {
        throw new Error('执行锁释放函数重复登记：拒绝覆盖已登记的释放函数');
      }

      pending = release;
    },
  };
}

export interface Pr5CleanupSafetySeedContext {
  readonly adminAccountId: number;
  readonly customerAccountId: number;
  readonly customerBetaAccountId: number;
  readonly engineerAccountId: number;
  readonly equipmentModelId: number;
}

function readAccountIdByLoginName(loginName: (typeof PR5_SEED_LOGIN_NAMES)[number]): number {
  const value = Number(
    mysqlQuery(`SELECT id FROM base_user_account WHERE login_name = '${loginName}'`),
  );

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Mock Seed 账号未就绪：${loginName} 的 id 读取异常 ${JSON.stringify(value)}`);
  }

  return value;
}

/** 只读解析本组依赖的既有 Seed 账号与启用型号 ID（不创建、不改写这些共享行） */
export function resolvePr5CleanupSafetySeedContext(): Pr5CleanupSafetySeedContext {
  const equipmentModelId = Number(
    mysqlQuery('SELECT id FROM equipment_model WHERE enabled = 1 ORDER BY id LIMIT 1'),
  );

  if (!Number.isSafeInteger(equipmentModelId) || equipmentModelId <= 0) {
    throw new Error(`启用设备型号读取异常：${JSON.stringify(equipmentModelId)}`);
  }

  return {
    adminAccountId: readAccountIdByLoginName('mock_super_admin'),
    customerAccountId: readAccountIdByLoginName('mock_customer_alpha'),
    customerBetaAccountId: readAccountIdByLoginName('mock_customer_beta'),
    engineerAccountId: readAccountIdByLoginName('mock_engineer_chen'),
    equipmentModelId,
  };
}

/**
 * 外部哨兵完整快照：对本组可能触及的三张表做**整行全字段快照**（`SELECT *`，按主键排序）
 * + 账号/型号计数。任意外部行发生字段改动 / 新增 / 删除都会让前后快照不等
 * （用于「外部哨兵前后完整快照相等」断言，而非只比对部分列）。
 */
export function snapshotPr5CleanupSafetyExternalSentinel(): string {
  const repairRequests = mysqlQuery('SELECT * FROM repair_request ORDER BY id');
  const engineerResponses = mysqlQuery('SELECT * FROM engineer_response ORDER BY id');
  const referenceDocuments = mysqlQuery('SELECT * FROM reference_document ORDER BY id');
  const accountCount = readSingleCountOrThrow(
    'SELECT COUNT(*) FROM base_user_account',
    '外部哨兵账号',
  );
  const enabledModelCount = readSingleCountOrThrow(
    'SELECT COUNT(*) FROM equipment_model WHERE enabled = 1',
    '外部哨兵型号',
  );

  return JSON.stringify({
    accountCount,
    enabledModelCount,
    engineerResponses,
    referenceDocuments,
    repairRequests,
  });
}

// ---- 本轮造数与 ledger ----

export interface Pr5CleanupSafetyLedgerRequest {
  readonly id: number;
  /** 建行时数据库实际落库的整行快照（13/13 canonical 列，含默认与生命周期字段） */
  readonly snapshot: Pr5RowSnapshot;
  /**
   * 本轮为该申请创建的回复**完整绑定**（每条含 7/7 canonical 整行快照）。
   * 父申请回收事务内会逐条按完整 7/7 快照复核并失败关闭——禁止退回裸 ID 集合
   * （裸 ID 无法发现「阶段 A 后回复字段被改写」的 TOCTOU）。
   */
  readonly responses: Pr5EngineerResponseBinding[];
}

/**
 * 本轮自建资料的**完整行绑定**（P1-1）：只记录 `id` 与建行时数据库实际落库的整行快照
 * （15/15 canonical 列）。残留重建、只读预检与事务内 DELETE 都只使用这一份快照，
 * 不再维护任何手写字段子集。
 */
export interface Pr5CleanupSafetyLedgerDocument {
  readonly id: number;
  /** 建行时数据库实际落库的整行快照（15/15 canonical 列） */
  readonly snapshot: Pr5RowSnapshot;
}

export interface Pr5CleanupSafetyLedger {
  readonly runId: string;
  readonly keyword: string;
  readonly ownerAccountId: number;
  readonly repairRequests: Pr5CleanupSafetyLedgerRequest[];
  /** 本轮已记录的回复**完整 binding**（替代裸 ID 集合，清理路径禁止按 ID 兜底删除） */
  readonly engineerResponses: Pr5EngineerResponseBinding[];
  /** 本轮已记录资料的**完整字段绑定**（替代裸 ID，残留恢复必须逐字段核验） */
  readonly documents: Pr5CleanupSafetyLedgerDocument[];
}

export function createPr5CleanupSafetyLedger(
  runId: string,
  ownerAccountId: number,
): Pr5CleanupSafetyLedger {
  assertRunId(runId);

  if (!Number.isSafeInteger(ownerAccountId) || ownerAccountId <= 0) {
    throw new Error(
      `清理安全组 ledger 归属账号未通过正整数校验：${JSON.stringify(ownerAccountId)}`,
    );
  }

  return {
    documents: [],
    engineerResponses: [],
    keyword: buildPr5CleanupSafetyKeyword(runId),
    ownerAccountId,
    repairRequests: [],
    runId,
  };
}

function buildCleanupSafetyRequestNo(): string {
  const digits = String(Date.now()).padStart(14, '0');
  const suffix = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  const requestNo = `RR${digits}${suffix}`;

  if (!REQUEST_NO_PATTERN.test(requestNo)) {
    throw new Error(`清理安全组申请编号生成异常：${JSON.stringify(requestNo)}`);
  }

  return requestNo;
}

/** 真实 INSERT 本轮自建维修申请（主键由数据库生成，读回后立即记入 ledger） */
export function insertPr5CleanupSafetyRepairRequest(
  ledger: Pr5CleanupSafetyLedger,
  input: { customerAccountId: number; equipmentModelId: number; faultTag: string },
): Pr5CleanupSafetyLedgerRequest {
  const { customerAccountId, equipmentModelId, faultTag } = input;

  if (!Number.isSafeInteger(customerAccountId) || customerAccountId <= 0) {
    throw new Error(`清理安全组申请客户账号未通过正整数校验：${JSON.stringify(customerAccountId)}`);
  }

  if (!Number.isSafeInteger(equipmentModelId) || equipmentModelId <= 0) {
    throw new Error(`清理安全组申请型号未通过正整数校验：${JSON.stringify(equipmentModelId)}`);
  }

  const requestNo = buildCleanupSafetyRequestNo();
  const errorCode = `CS-${ledger.runId}`;
  // INSERT 与 VALUES 必须是同一条语句，不能以 '; ' 分隔；随后再用 '; ' 追加读回主键
  const id = Number(
    mysqlQuery(
      'INSERT INTO repair_request (request_no, customer_account_id, equipment_model_id, error_code, fault_description, content_md)' +
        ` VALUES ('${requestNo}', ${customerAccountId}, ${equipmentModelId}, '${errorCode}', '${faultTag}', '${faultTag}');` +
        ' SELECT LAST_INSERT_ID()',
    ),
  );

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`清理安全组申请主键读取异常：${JSON.stringify(id)}`);
  }

  const entry: Pr5CleanupSafetyLedgerRequest = {
    id,
    responses: [],
    // 整行快照的真源 = 数据库实际落库值（覆盖数据库默认与生命周期字段），不手写字段子集
    snapshot: readPr5FullRowSnapshot('repair_request', id),
  };

  ledger.repairRequests.push(entry);

  return entry;
}

/** 真实 INSERT 本轮自建工程师回复（主键由数据库生成；完整 binding 记入 ledger 与父申请的回复集合） */
export function insertPr5CleanupSafetyEngineerResponse(
  ledger: Pr5CleanupSafetyLedger,
  input: {
    request: Pr5CleanupSafetyLedgerRequest;
    engineerAccountId: number;
    customerAccountId: number;
    resolutionStatus?: 'PENDING' | 'RESOLVED';
    responseText?: string;
    /**
     * 是否记入 ledger（默认 true）。
     * 置 false 用于 C3 反例：插入一条**未记录的本轮外回复**，模拟另一进程 / 另一轮写入
     * 的子行；此时 ledger 的父子集合核验必须失败关闭，绝不随之扩大删除范围。
     */
    record?: boolean;
  },
): number {
  const { request, engineerAccountId, customerAccountId } = input;
  const resolutionStatus = input.resolutionStatus ?? 'PENDING';
  const responseText = input.responseText ?? `清理安全组回复·${ledger.runId}`;

  if (!PR5_RESPONSE_TEXT_PATTERN.test(responseText)) {
    throw new Error(`清理安全组回复正文未通过白名单校验：${JSON.stringify(responseText)}`);
  }

  const id = Number(
    mysqlQuery(
      'INSERT INTO engineer_response (request_id, engineer_account_id, customer_account_id, resolution_status, response_text)' +
        ` VALUES (${request.id}, ${engineerAccountId}, ${customerAccountId}, '${resolutionStatus}', '${responseText}');` +
        ' SELECT LAST_INSERT_ID()',
    ),
  );

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`清理安全组回复主键读取异常：${JSON.stringify(id)}`);
  }

  if (input.record !== false) {
    // 完整 binding：读回数据库实际落库整行快照（7/7），不手写字段子集；
    // 同时挂到父申请条目上（阶段 A 产物直接携带完整回复 bindings，阶段 B 不得丢弃为 ID 数组）
    const binding = readPr5EngineerResponseBindingFromDb({
      customerAccountId,
      engineerAccountId,
      id,
      requestId: request.id,
      responseText,
    });

    request.responses.push(binding);
    ledger.engineerResponses.push(binding);
  }

  return id;
}

/** 真实 INSERT 本轮自建参考资料（主键由数据库生成；storage_reference 可空，需命中白名单才用于删文件） */
export function insertPr5CleanupSafetyReferenceDocument(
  ledger: Pr5CleanupSafetyLedger,
  input: {
    label: string;
    createdByAccountId: number;
    storageReference?: string | null;
    equipmentModelId?: number | null;
  },
): Pr5ReferenceDocumentBinding {
  const { label, createdByAccountId } = input;
  const title = `${ledger.keyword}（${label}）`;
  const storageReference = input.storageReference ?? null;
  const modelExpression =
    input.equipmentModelId === undefined || input.equipmentModelId === null
      ? 'NULL'
      : String(input.equipmentModelId);
  // 库表约束 chk_reference_document_storage_pair 要求 storage_backend 与 storage_reference
  // 必须同时为空或同时非空；有存储引用时按后端生产口径写入 'local'（见 create-reference-document.usecase）。
  const referenceExpression = storageReference === null ? 'NULL' : `'${storageReference}'`;
  const backendExpression = storageReference === null ? 'NULL' : "'local'";

  const id = Number(
    mysqlQuery(
      'INSERT INTO reference_document (title, document_type, equipment_model_id, content_text, storage_backend, storage_reference, created_by_account_id)' +
        ` VALUES ('${title}', 'CHECKLIST', ${modelExpression}, '${ledger.runId}', ${backendExpression}, ${referenceExpression}, ${createdByAccountId});` +
        ' SELECT LAST_INSERT_ID()',
    ),
  );

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`清理安全组资料主键读取异常：${JSON.stringify(id)}`);
  }

  // 完整 binding：读回数据库实际落库整行快照（15/15，含 storage_* / deprecated / created_at / updated_at）
  const binding = readPr5ReferenceDocumentBindingFromDb({
    createdByAccountId,
    id,
    titleKeyword: ledger.keyword,
  });

  ledger.documents.push({ id, snapshot: binding.snapshot });

  return binding;
}

/**
 * ledger 申请条目 → **完整行绑定**（P1-1）：定位因子（id / request_no / customer_account_id）
 * 全部从建行时数据库落库快照派生，并原样携带该整行快照；回收的只读预检与事务内 DELETE
 * 都由这一份快照生成同一 WHERE，任一非三因子字段被外部改写即零写入失败关闭。
 * 不再存在「三因子 + 部分字段 expectation」的第二套口径。
 */
export function toPr5RepairRequestBinding(
  entry: Pr5CleanupSafetyLedgerRequest,
  responses: readonly Pr5EngineerResponseBinding[] = entry.responses,
): Pr5RepairRequestBinding {
  return {
    customerAccountId: Number(readPr5SnapshotColumn(entry.snapshot, 'customer_account_id')),
    id: entry.id,
    requestNo: readPr5SnapshotColumn(entry.snapshot, 'request_no'),
    responses: [...responses],
    snapshot: entry.snapshot,
  };
}

/** ledger 资料条目 → **完整行绑定**（P1-1）：与 locator / 回收预检 / 事务内 DELETE 共用同一份整行快照 */
export function toPr5ReferenceDocumentBinding(
  document: Pr5CleanupSafetyLedgerDocument,
  titleKeyword: string,
): Pr5ReferenceDocumentBinding {
  return {
    createdByAccountId: Number(readPr5SnapshotColumn(document.snapshot, 'created_by_account_id')),
    id: document.id,
    snapshot: document.snapshot,
    titleKeyword,
  };
}

function cleanupSafetyRowExists(table: string, id: number): boolean {
  assertCleanupSafetyTable(table);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`清理安全组行存在性查询 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  return Number(mysqlQuery(`SELECT COUNT(*) FROM ${table} WHERE id = ${id}`)) > 0;
}

interface Pr5CleanupSafetyReclaimPlan {
  readonly requests: Pr5RepairRequestBinding[];
  readonly responses: Pr5EngineerResponseBinding[];
  readonly documents: Array<{ binding: Pr5ReferenceDocumentBinding; reference: string | null }>;
}

/**
 * 阶段一：**全量只读预检**（零写入）。
 *
 * 对 ledger 内全部申请 / 回复 / 资料 / 文件引用做完整绑定与引用闭包核验：任一不符
 * （同标识异主、未知子行、回复字段不符、资料引用非法）立即抛错；调用方在**任何 DELETE
 * 之前**失败关闭——原父行、本轮子行、外部子行、其他 ledger 对象全部不变。已不存在的行幂等跳过。
 */
function planPr5CleanupSafetyReclaim(ledger: Pr5CleanupSafetyLedger): Pr5CleanupSafetyReclaimPlan {
  const requests: Pr5RepairRequestBinding[] = [];

  for (const entry of ledger.repairRequests) {
    if (!cleanupSafetyRowExists('repair_request', entry.id)) {
      continue;
    }

    // 完整行核验（P1-1）：与 locator **共用同一断言**，任一字段（含非三因子）被外部改写即零写入失败关闭
    assertPr5CleanupSafetyRowSnapshotMatches(
      entry.snapshot,
      readPr5FullRowSnapshot('repair_request', entry.id),
    );

    // 先按 ledger 记录的**完整回复 bindings**做父绑定只读预检（父行整行快照 + 子行闭包 +
    // 每条回复 7/7）：未知子行 → pr5_engineer_response_child_binding_must_match_this_run，
    // 任一字段漂移 → pr5_engineer_response_child_pk_<id>_full_snapshot_must_match_exactly_one。
    // 预检通过后再读回本申请实际子行（再逐条与 ledger 完整 binding 核验），以「当前库行」
    // 构造删除用绑定；全程零写入，任何冲突都在 DELETE 之前失败关闭。
    assertPr5RepairRequestBindingBound(toPr5RepairRequestBinding(entry));

    const responses = readPr5CleanupSafetyRunResponses(entry.id, ledger);

    requests.push(toPr5RepairRequestBinding(entry, responses));
  }

  const responses: Pr5EngineerResponseBinding[] = [];

  for (const binding of ledger.engineerResponses) {
    if (!cleanupSafetyRowExists('engineer_response', binding.id)) {
      continue;
    }

    assertPr5EngineerResponseBindingBound(binding);
    responses.push(binding);
  }

  const documents: Array<{ binding: Pr5ReferenceDocumentBinding; reference: string | null }> = [];

  for (const document of ledger.documents) {
    if (!cleanupSafetyRowExists('reference_document', document.id)) {
      continue;
    }

    // 完整行核验（P1-1）：与 locator 共用同一断言；标题 / 类型 / 正文 / 存储 / 型号 / 时间戳任一被改写即失败关闭
    assertPr5CleanupSafetyRowSnapshotMatches(
      document.snapshot,
      readPr5FullRowSnapshot('reference_document', document.id),
    );

    const binding = toPr5ReferenceDocumentBinding(document, ledger.keyword);

    documents.push({ binding, reference: readPr5ReferenceDocumentStorageReferenceBound(binding) });
  }

  return { documents, requests, responses };
}

/**
 * ledger 回收：**两阶段**——先对全部申请 / 回复 / 资料 / 文件引用做完整绑定的只读预检，
 * 任一不符即**零写入**抛错（发现冲突后绝不改变数据库）；预检全通过后再按完整 binding 精确删除。
 *
 * 顺序（关键）：先按「三因子 + 本轮回复集合」删维修申请——该绑定删除会**一并**删掉本轮
 * 记录的回复子行并核对残留；再按 ledger 记录的**完整回复 binding** 幂等兜底删「父行已不在
 * 但回复仍残留」的子行（若先删子行再删父行，父行的子行集合核验会因集合已空而失败，故顺序
 * 不可颠倒）；最后按三因子删资料并删已核验文件。清理路径**不再有裸 ID 删除原语**。
 *
 * 已不存在的行自动跳过（幂等）；预检之后的执行失败进入 AggregateError，绝不静默吞掉。
 */
export function reclaimPr5CleanupSafetyLedger(ledger: Pr5CleanupSafetyLedger): void {
  const plan = planPr5CleanupSafetyReclaim(ledger);
  const failures: Error[] = [];

  for (const binding of plan.requests) {
    try {
      deletePr5RepairRequestBound(binding);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  for (const binding of plan.responses) {
    try {
      deletePr5EngineerResponseRowsBound(binding);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  for (const { binding, reference } of plan.documents) {
    try {
      deletePr5ReferenceDocumentBound(binding);

      if (reference !== null) {
        deleteE2EReferenceDocumentStorageFileByReference(reference);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      '清理安全组 ledger 回收失败（残留必须人工核对，不得静默通过）',
    );
  }
}

/** 按运行标识统计三表中的本轮残留行数（运行标识同时写入标题 / 故障描述 / 回复正文） */
export function countPr5CleanupSafetyRunRows(runId: string): {
  documents: number;
  requests: number;
  responses: number;
} {
  assertRunId(runId);

  return {
    documents: readSingleCountOrThrow(
      `SELECT COUNT(*) FROM reference_document WHERE title LIKE '%${runId}%'`,
      '本轮资料残留',
    ),
    requests: readSingleCountOrThrow(
      `SELECT COUNT(*) FROM repair_request WHERE fault_description LIKE '%${runId}%'`,
      '本轮维修申请残留',
    ),
    responses: readSingleCountOrThrow(
      `SELECT COUNT(*) FROM engineer_response WHERE response_text LIKE '%${runId}%'`,
      '本轮回复残留',
    ),
  };
}

/** 断言本轮无任何残留（三表计数全 0） */
export function assertPr5CleanupSafetyNoRunResidue(runId: string): void {
  const residue = countPr5CleanupSafetyRunRows(runId);

  if (residue.documents !== 0 || residue.requests !== 0 || residue.responses !== 0) {
    throw new Error(
      `清理安全组检测到本轮残留：资料 ${residue.documents} / 申请 ${residue.requests} / 回复 ${residue.responses}（运行标识 ${runId}）`,
    );
  }
}

export interface Pr5CleanupSafetyResidue {
  readonly documents: Pr5ReferenceDocumentBinding[];
  readonly requests: Array<{
    readonly binding: Pr5RepairRequestBinding;
    readonly responses: Pr5EngineerResponseBinding[];
  }>;
}

/** 表名 → 失败信息中的中文标签（统一断言与恢复原语共用） */
const PR5_CLEANUP_SAFETY_TABLE_LABELS: Readonly<Record<Pr5CleanupTable, string>> = {
  engineer_response: '残留回复',
  reference_document: '残留资料',
  repair_request: '残留维修申请',
};

/**
 * **唯一**的「ledger 记录快照 vs 数据库当前整行快照」逐字段核验原语（P1-1 共用口径）：
 * locator 与 reclaimer 只读预检都调用本函数，覆盖**全部 canonical 列**（13/7/15，含主键与时间戳），
 * 不再存在「locator 核验 A 组字段、reclaimer 核验 B 组字段」的两套口径。
 *
 * 失败信息含表标签 / 主键 / 字段名 / 期望值 / 实际值，且在任何 DELETE 之前抛出（零写入失败关闭）。
 */
export function assertPr5CleanupSafetyRowSnapshotMatches(
  recorded: Pr5RowSnapshot,
  actual: Pr5RowSnapshot,
): void {
  if (recorded.table !== actual.table) {
    throw new Error(
      `清理安全组快照表名不一致：ledger ${JSON.stringify(recorded.table)} 实际 ${JSON.stringify(actual.table)}`,
    );
  }

  assertPr5RowSnapshotShape(recorded);
  assertPr5RowSnapshotShape(actual);

  const label = PR5_CLEANUP_SAFETY_TABLE_LABELS[recorded.table];
  const id = readPr5SnapshotColumn(recorded, 'id');

  for (const spec of readPr5ColumnSpecs(recorded.table)) {
    const expected = readPr5SnapshotColumn(recorded, spec.name);
    const value = readPr5SnapshotColumn(actual, spec.name);

    if (expected !== value) {
      throw new Error(
        `${label} ${id} 字段 ${spec.name} 与 ledger 记录不符（疑似被外部改写），失败关闭，拒绝删除：期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(value)}`,
      );
    }
  }
}

/**
 * 按整行快照**全列恢复**目标行（含显式恢复 `updated_at`）：用于反例用例在改写字段后把基线还原，
 * 使后续精确回收可命中同一 WHERE。仅用于测试反例的 teardown，绝不用于生产清理路径。
 */
export function restorePr5CleanupSafetyRowToSnapshot(snapshot: Pr5RowSnapshot): void {
  assertPr5RowSnapshotShape(snapshot);

  const id = readPr5SnapshotColumn(snapshot, 'id');
  const assignments = readPr5ColumnSpecs(snapshot.table)
    .filter((spec) => spec.name !== 'id')
    .map((spec) => buildPr5ColumnAssignment(spec, readPr5SnapshotColumn(snapshot, spec.name)));

  mysqlQuery(`UPDATE ${snapshot.table} SET ${assignments.join(', ')} WHERE id = ${id}`);
}

/**
 * schema 双向差集（计划 §S0 第 4 项）：canonical 列清单必须与专用库 information_schema 完全一致，
 * 多列 / 缺列 / canonical 内重复任一出现即失败，杜绝「代码字段集与真实库漂移」。
 */
export function assertPr5CleanupSafetySchemaMatchesCanonical(): void {
  for (const table of PR5_CLEANUP_SAFETY_TABLES) {
    const actual = mysqlQuery(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
    )
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    const diff = diffPr5ColumnSets(actual, readPr5CanonicalColumns(table));

    if (
      diff.duplicatesInCanonical.length > 0 ||
      diff.missingInActual.length > 0 ||
      diff.unexpectedInActual.length > 0
    ) {
      throw new Error(
        `PR5 canonical 列清单与库 schema 漂移（${table}）：缺 ${JSON.stringify(diff.missingInActual)} / 多 ${JSON.stringify(diff.unexpectedInActual)} / canonical 重复 ${JSON.stringify(diff.duplicatesInCanonical)}`,
      );
    }
  }
}

/**
 * 只读读取父申请的全部回复并与 ledger 记录的**完整回复 binding** 逐字段核验：
 * 任一回复未记录（疑似外部 / 异轮）或字段与 ledger 不符即失败关闭；同时核验回复集合闭包
 * （ledger 记录的本申请回复若仍在库，必须出现在本次读回集合内）。
 */
function readPr5CleanupSafetyRunResponses(
  requestId: number,
  ledger: Pr5CleanupSafetyLedger,
): Pr5EngineerResponseBinding[] {
  const columns = readPr5CanonicalColumns('engineer_response');
  const rows = mysqlQuery(
    `SELECT ${columns.join(', ')} FROM engineer_response WHERE request_id = ${requestId}`,
  )
    .split('\n')
    .map((value) => value.replace(/\r$/, ''))
    .filter((value) => value !== '');

  const recordedById = new Map(ledger.engineerResponses.map((binding) => [binding.id, binding]));
  const responses: Pr5EngineerResponseBinding[] = [];

  for (const raw of rows) {
    const rawValues = raw.split('\t');

    if (rawValues.length !== columns.length) {
      throw new Error(`残留回复字段读取异常：${JSON.stringify(raw)}`);
    }

    const values: Record<string, string> = {};
    columns.forEach((column, index) => {
      values[column] = rawValues[index] ?? 'NULL';
    });

    const actual = createPr5RowSnapshot('engineer_response', values);
    const id = Number(readPr5SnapshotColumn(actual, 'id'));
    const rowRequestId = Number(readPr5SnapshotColumn(actual, 'request_id'));

    if (rowRequestId !== requestId) {
      throw new Error(`残留回复 ${id} 父申请不符：期望 ${requestId} 实际 ${rowRequestId}`);
    }

    const recorded = recordedById.get(id);

    if (recorded === undefined) {
      throw new Error(
        `残留回复 ${id} 未记录在本轮 ledger（疑似外部 / 异轮回复），失败关闭，拒绝删除：${JSON.stringify(readPr5SnapshotColumn(actual, 'response_text'))}`,
      );
    }

    // 完整行核验（与 reclaimer 预检 / locator 共用同一断言）：含 resolution_status / created_at
    assertPr5CleanupSafetyRowSnapshotMatches(recorded.snapshot, actual);

    responses.push({
      customerAccountId: Number(readPr5SnapshotColumn(actual, 'customer_account_id')),
      engineerAccountId: Number(readPr5SnapshotColumn(actual, 'engineer_account_id')),
      id,
      requestId,
      responseText: readPr5SnapshotColumn(actual, 'response_text'),
      // 绑定使用数据库当前整行快照（已与 ledger 记录逐字段核验相等），保证 DELETE WHERE 精确命中
      snapshot: actual,
    });
  }

  for (const recorded of ledger.engineerResponses) {
    if (recorded.requestId !== requestId) {
      continue;
    }

    if (responses.some((response) => response.id === recorded.id)) {
      continue;
    }

    // 已随父行删除而消失属幂等；仍在库却不在本父集合内，说明父申请被改写，失败关闭
    if (cleanupSafetyRowExists('engineer_response', recorded.id)) {
      throw new Error(
        `残留回复 ${recorded.id} 仍在库但不在父申请 ${requestId} 的回复集合内（疑似父申请被改写），失败关闭，拒绝删除`,
      );
    }
  }

  return responses;
}

/**
 * 残留按专属标识定位 + **逐字段核验**（计划 §4.3 / P2-2）：以 ledger 记录的**完整可重建字段绑定**
 * 为基线，对库中同标识的全部资料 / 申请 / 回复逐字段比对（归属、标题、类型、正文、存储引用闭包、
 * 设备型号、申请编号、故障码、描述、实际回复集合）。
 *
 * 任一字段不符、存在未记录的同行（异主 / 异轮）、或已记录行无法再按本轮标识定位（标题被改写）
 * 即**零删除**失败关闭；返回**从数据库重建并通过核验的完整 binding**，供调用方精确回收。
 */
export function locatePr5CleanupSafetyResidueByRunId(
  ledger: Pr5CleanupSafetyLedger,
  expected: { documentOwnerAccountId: number; requestCustomerAccountId: number },
): Pr5CleanupSafetyResidue {
  const runId = ledger.runId;
  assertRunId(runId);

  const keyword = ledger.keyword;

  if (!PR5_DOC_KEYWORD_PATTERN.test(keyword)) {
    throw new Error(`残留资料定位关键字未通过白名单校验：${JSON.stringify(keyword)}`);
  }

  const documents: Pr5ReferenceDocumentBinding[] = [];
  const ledgerDocumentById = new Map(ledger.documents.map((document) => [document.id, document]));
  const foundDocumentIds = new Set<number>();

  for (const id of findPr5ReferenceDocumentIdsByKeyword(keyword)) {
    const actual = readPr5FullRowSnapshot('reference_document', id);
    const owner = Number(readPr5SnapshotColumn(actual, 'created_by_account_id'));

    foundDocumentIds.add(id);

    if (owner !== expected.documentOwnerAccountId) {
      throw new Error(
        `残留资料 ${id} 创建人与预期不符（同标识异主），失败关闭，拒绝删除：期望 ${expected.documentOwnerAccountId} 实际 ${owner}`,
      );
    }

    const recorded = ledgerDocumentById.get(id);

    if (recorded === undefined) {
      throw new Error(
        `残留资料 ${id} 未记录在本轮 ledger（疑似外部 / 异轮），无法从数据库唯一重建绑定，失败关闭，拒绝删除`,
      );
    }

    // 完整行核验（P1-1）：与 reclaimer 预检共用同一断言；返回**从数据库重建**的完整 binding
    assertPr5CleanupSafetyRowSnapshotMatches(recorded.snapshot, actual);
    documents.push({
      createdByAccountId: owner,
      id,
      snapshot: actual,
      titleKeyword: keyword,
    });
  }

  // 闭包：ledger 记录的资料若仍在库，必须能按本轮标识定位到（标题标识被移除时同样失败关闭）
  for (const recorded of ledger.documents) {
    if (!cleanupSafetyRowExists('reference_document', recorded.id)) {
      continue;
    }

    if (!foundDocumentIds.has(recorded.id)) {
      throw new Error(
        `残留资料 ${recorded.id} 仍在库但已无法按本轮标识定位（疑似标题被改写），失败关闭，拒绝删除`,
      );
    }
  }

  const requestRows = mysqlQuery(
    `SELECT id FROM repair_request WHERE fault_description LIKE '%${runId}%'`,
  )
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const ledgerRequestById = new Map(ledger.repairRequests.map((request) => [request.id, request]));
  const requests: Array<{
    binding: Pr5RepairRequestBinding;
    responses: Pr5EngineerResponseBinding[];
  }> = [];
  const foundRequestIds = new Set<number>();

  for (const rawId of requestRows) {
    const id = Number(rawId);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`残留维修申请 ID 解析异常：${JSON.stringify(rawId)}`);
    }

    const actual = readPr5FullRowSnapshot('repair_request', id);
    const customer = Number(readPr5SnapshotColumn(actual, 'customer_account_id'));

    foundRequestIds.add(id);

    if (customer !== expected.requestCustomerAccountId) {
      throw new Error(
        `残留维修申请 ${id} 归属客户与预期不符（同标识异主），失败关闭，拒绝删除：期望 ${expected.requestCustomerAccountId} 实际 ${customer}`,
      );
    }

    const recorded = ledgerRequestById.get(id);

    if (recorded === undefined) {
      throw new Error(
        `残留维修申请 ${id} 未记录在本轮 ledger（疑似外部 / 异轮），无法从数据库唯一重建绑定，失败关闭，拒绝删除`,
      );
    }

    // 完整行核验（P1-1）：与 reclaimer 预检共用同一断言
    assertPr5CleanupSafetyRowSnapshotMatches(recorded.snapshot, actual);

    const responses = readPr5CleanupSafetyRunResponses(id, ledger);

    requests.push({
      binding: {
        customerAccountId: customer,
        id,
        requestNo: readPr5SnapshotColumn(actual, 'request_no'),
        // 子回复**完整 bindings** 直接进入父绑定（禁止退回裸 ID 集合）
        responses,
        // 从数据库重建的完整行快照（已核验与 ledger 记录逐字段相等）
        snapshot: actual,
      },
      responses,
    });
  }

  // 闭包：ledger 记录的申请若仍在库，必须能按本轮标识定位到（故障描述标识被移除时同样失败关闭）
  for (const recorded of ledger.repairRequests) {
    if (!cleanupSafetyRowExists('repair_request', recorded.id)) {
      continue;
    }

    if (!foundRequestIds.has(recorded.id)) {
      throw new Error(
        `残留维修申请 ${recorded.id} 仍在库但已无法按本轮标识定位（疑似故障描述被改写），失败关闭，拒绝删除`,
      );
    }
  }

  return { documents, requests };
}

// ---- C5 用：隔离临时目录中的存储文件（不触碰后端真实存储目录） ----

export interface Pr5CleanupSafetyTempStorage {
  readonly dir: string;
  readonly references: readonly string[];
  readonly sentinelReference: string;
  filePath: (reference: string) => string;
  exists: (reference: string) => boolean;
  remove: (reference: string) => void;
  cleanup: () => void;
}

/**
 * 在独立临时目录建立本组专用的「存储文件」与外部哨兵文件
 * （与后端真实存储目录完全隔离，绝不触碰他人的物理文件）。
 */
export function createPr5CleanupSafetyTempStorage(fileCount: number): Pr5CleanupSafetyTempStorage {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr5-cleanup-safety-storage-'));
  const references: string[] = [];

  for (let index = 0; index < fileCount; index += 1) {
    const reference = `${randomBytes(16).toString('hex')}.md`;

    writeFileSync(path.join(dir, reference), `cleanup-safety-${index}`);
    references.push(reference);
  }

  const sentinelReference = `${randomBytes(16).toString('hex')}.md`;

  writeFileSync(path.join(dir, sentinelReference), 'external-sentinel');

  const filePath = (reference: string): string => path.join(dir, reference);

  return {
    cleanup: () => {
      rmSync(dir, { force: true, recursive: true });
    },
    dir,
    exists: (reference: string) => existsSync(filePath(reference)),
    filePath,
    references,
    remove: (reference: string) => {
      rmSync(filePath(reference), { force: true });
    },
    sentinelReference,
  };
}
