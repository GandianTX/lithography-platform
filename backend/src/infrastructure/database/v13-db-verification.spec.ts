// src/infrastructure/database/v13-db-verification.spec.ts
//
// G-2 V13 实库约束/事务可执行规格（本轮：仅编写+编译，不启用、不执行实库写入）。
//
// 安全门（默认不连库）：
//   必须同时设置以下环境变量才会执行实库断言，三者缺一即整组 describe.skip，
//   不创建 DataSource、不建立任何连接：
//     E2E_REAL_DB_SPECS=1                 显式启用实库规格
//     E2E_ALLOW_PHYSICAL_CLEANUP=1        写入/清理许可
//     E2E_REAL_DB_NAME=<库名>             预期目标库（小写）
//   若仅设置 E2E_REAL_DB_SPECS=1 而许可不全，模块加载即抛出明确拒绝，
//   绝不静默跳过伪装成功。
//
// 启用后在第一条 SQL 前独立核验：
//   1. 目标库在 E2E_ALLOWED_DB_NAMES 白名单内（assertAllowedE2eDatabase）；
//   2. 实际 SELECT DATABASE() === E2E_REAL_DB_NAME（assertManagerOnExpectedE2eDatabase）。
//
// 夹具与回收（不依赖任何固定 ID=1）：
//   - 套件级父夹具（组织/客户账号/工程师账号/机型）在 beforeAll 创建，
//     真实自增 ID 立即登记进受保护台账，afterAll 由 runGuardedSpecCleanup 精确回收；
//   - 用例级提交资源（intake / repair_request / attempt 等）在用例内创建并登记，
//     afterEach 精确回收；
//   - 纯约束用例的全部写入在独占事务内完成并最终强制回滚，不产生任何提交行；
//   - 创建部分成功、断言失败、回滚失败、清理失败均保留原始诊断（cause 链）再抛出。
//
// S2 覆盖映射（plans/database-v13-deploy/S2-db-verification-specs.md）：
//   §2.1 唯一键 14 项 → describe('2.1') 14 个用例全覆盖；
//   §2.2 外键与删除策略 6 项 → describe('2.2') 6 个用例全覆盖；
//   §2.3 NULL 安全 CHECK 23 项 → describe('2.3') 23 个用例全覆盖（含 1 个正向用例）；
//   §2.4 JSON 快照版本定向回归 8 项 → describe('2.4')（S1 §4.2 / OI-02，不改 2.1—2.3 映射）；
//     注意：D6 的 51 passed 未覆盖“缺 schema_version / JSON null”命题；
//   §2.5 记录包检查/导入状态（第 39 条迁移）→ describe('2.5')：检查/导入可分别表达、
//     合法组合、非法枚举、manifest 版本键、包身份与重试唯一规则；
//     旧行兼容与预检拒绝、部分 ALTER 失败/续跑由 record-package-state.migration.spec.ts
//     以纯替身覆盖（迁移期行为不适合在已升级库上复现）；
//   §3 事务 5 项 → describe('3') 5 个用例全覆盖，全部为“前序写入成功、后序失败”模式；
//   §4 清理入口 → 不在本规格：由 G-3 清理器与 e2e-scoped-cleanup.v13.spec.ts
//     纯替身回归覆盖结构/顺序；实库清理验收待单独授权（见文档 S2 §4，未覆盖）。
//
// 运行（授权后）：
//   E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_REAL_DB_NAME=lithography_v13_spec \
//   E2E_ALLOWED_DB_NAMES=lithography_v13_spec \
//   npx jest src/infrastructure/database/v13-db-verification.spec.ts --runInBand

import { randomUUID } from 'node:crypto';

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { DataSource, type EntityManager } from 'typeorm';
import {
  assertAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
} from '../../../test/utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../../../test/utils/e2e-scoped-cleanup';
import {
  ACCOUNT_WRITE_FIXTURE_ENTITIES,
  createTestAccount,
} from '../../../test/utils/test-accounts';

const REQUESTED = process.env.E2E_REAL_DB_SPECS === '1';
const CLEANUP_ALLOWED = process.env.E2E_ALLOW_PHYSICAL_CLEANUP === '1';
const EXPECTED_DB = (process.env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
const ENABLED = REQUESTED && CLEANUP_ALLOWED && EXPECTED_DB.length > 0;

if (REQUESTED && !ENABLED) {
  throw new Error(
    'G-2 实库规格被显式要求执行（E2E_REAL_DB_SPECS=1），但许可不全：' +
      '需要同时设置 E2E_ALLOW_PHYSICAL_CLEANUP=1 与 E2E_REAL_DB_NAME=<库名>。' +
      '明确拒绝，不静默跳过。',
  );
}

const describeRealDb = ENABLED ? describe : describe.skip;

/**
 * MySQL 错误的可核验字段。
 *
 * TypeORM 把驱动错误挂在 `driverError` 上（部分版本同时拷贝到 QueryFailedError 顶层），
 * 因此两处都读；优先按 errno + sqlState 核验（MySQL 8 稳定），code 名称作为补充断言。
 */
interface MySqlErrorFields {
  readonly code?: string;
  readonly errno?: number;
  readonly sqlState?: string;
  readonly message: string;
}

const readMySqlError = (error: unknown): MySqlErrorFields => {
  const outer = error as {
    code?: string;
    errno?: number;
    sqlState?: string;
    message?: string;
    sqlMessage?: string;
    driverError?: { code?: string; errno?: number; sqlState?: string; sqlMessage?: string };
  };
  const driver = outer?.driverError ?? outer;
  return {
    code: driver?.code ?? outer?.code,
    errno: driver?.errno ?? outer?.errno,
    sqlState: driver?.sqlState ?? outer?.sqlState,
    message:
      driver?.sqlMessage ??
      outer?.sqlMessage ??
      (error instanceof Error ? error.message : String(error)),
  };
};

/** 单条负例的期望：errno/sqlState/code 名称，以及（可选）必须命中的约束名。 */
interface MySqlExpectation {
  readonly code: string;
  readonly errno: number;
  readonly sqlState: string;
  /** 目标约束/索引名：错误信息必须命中其中之一，避免“任意报错”被当作负例通过。 */
  readonly constraints?: readonly string[];
}

const DUP_ENTRY: MySqlExpectation = { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' };
const NO_REFERENCED_ROW: MySqlExpectation = {
  code: 'ER_NO_REFERENCED_ROW_2',
  errno: 1452,
  sqlState: '23000',
};
const ROW_IS_REFERENCED: MySqlExpectation = {
  code: 'ER_ROW_IS_REFERENCED_2',
  errno: 1451,
  sqlState: '23000',
};
const CHECK_VIOLATED: MySqlExpectation = {
  code: 'ER_CHECK_CONSTRAINT_VIOLATED',
  errno: 3819,
  // MySQL 8 对 CHECK 违规返回 SQLSTATE HY000（非 23000）。
  sqlState: 'HY000',
};
const OUT_OF_RANGE: MySqlExpectation = {
  code: 'ER_WARN_DATA_OUT_OF_RANGE',
  errno: 1264,
  sqlState: '22003',
};

/** 在基础期望上附加“必须命中的约束名”（同族多约束同时成立时允许任一命中）。 */
const withConstraint = (
  base: MySqlExpectation,
  ...constraints: readonly string[]
): MySqlExpectation => ({ ...base, constraints });

/** 断言 MySQL 错误：errno + sqlState 硬校验，code 名称补充校验，必要时校验目标约束名。 */
const expectMySqlError = (error: unknown, expectation: MySqlExpectation): void => {
  const actual = readMySqlError(error);
  const mismatch =
    actual.errno !== undefined && actual.errno !== expectation.errno
      ? `errno 预期 ${expectation.errno} 实际 ${actual.errno}`
      : actual.sqlState !== undefined && actual.sqlState !== expectation.sqlState
        ? `sqlState 预期 ${expectation.sqlState} 实际 ${actual.sqlState}`
        : actual.code !== expectation.code
          ? `code 预期 ${expectation.code} 实际 ${actual.code}`
          : null;
  if (actual.errno === undefined || actual.sqlState === undefined || mismatch) {
    throw new Error(
      `预期 MySQL 错误 ${expectation.code}/${expectation.errno}/${expectation.sqlState}，` +
        `实际 ${actual.code}/${actual.errno}/${actual.sqlState}：${actual.message}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    expectation.constraints &&
    expectation.constraints.length > 0 &&
    !expectation.constraints.some((name) => actual.message.includes(name))
  ) {
    throw new Error(
      `目标约束未命中（${expectation.constraints.join('|')}），实际错误信息：${actual.message}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
};

/**
 * 从用例标签提取目标约束/索引名（chk_/fk_/uk_ 前缀）。
 *
 * 标签本身声明了被测目标；要求错误信息命中该名称，避免“任意数据库报错”
 * 被当作负例通过。未声明目标的用例（如仅验证唯一键 1062）不做额外名称断言。
 */
const constraintNamesFromLabel = (label: string): readonly string[] =>
  label.match(/(?:chk|fk|uk)_[a-z0-9_]+/g) ?? [];

/** 执行写入并断言被指定错误拒绝；写入意外成功视为失败。 */
const expectRejectedWith = async (
  write: () => Promise<unknown>,
  expectation: MySqlExpectation,
  label: string,
): Promise<void> => {
  try {
    await write();
  } catch (error) {
    const derived = constraintNamesFromLabel(label);
    expectMySqlError(
      error,
      expectation.constraints || derived.length === 0
        ? expectation
        : { ...expectation, constraints: derived },
    );
    return;
  }
  throw new Error(`${label}：预期 ${expectation.code} 拒绝但写入成功`);
};

/** 事务整体被拒绝：捕获完整错误后按 errno/sqlState/code 核验（事务已自动回滚）。 */
const expectTransactionRejected = async (
  run: () => Promise<unknown>,
  expectation: MySqlExpectation,
  label: string,
): Promise<void> => {
  let error: unknown;
  let settled = false;
  try {
    await run();
    settled = true;
  } catch (caught) {
    error = caught;
  }
  if (settled) {
    throw new Error(`${label}：预期事务被 ${expectation.code} 拒绝但成功提交`);
  }
  const derived = constraintNamesFromLabel(label);
  expectMySqlError(
    error,
    expectation.constraints || derived.length === 0
      ? expectation
      : { ...expectation, constraints: derived },
  );
};

/** 强制回滚哨兵：独占事务内全部断言完成后抛出，使事务回滚而不提交任何行。 */
class ForceRollbackError extends Error {
  constructor() {
    super('FORCE_ROLLBACK');
    this.name = 'ForceRollbackError';
  }
}

describeRealDb('G-2 V13 实库约束/事务规格', () => {
  let dataSource: DataSource;
  let suiteLedger: OwnedResourceLedger;
  let testLedger: OwnedResourceLedger;

  const runTag = Date.now().toString(36);

  // 套件级父夹具真实 ID（由数据库生成，绝不使用固定 ID）。
  let orgId: number;
  let customerAccountId: number;
  let engineerAccountId: number;
  let equipmentModelId: number;

  /**
   * 在独占事务内执行 fn 并最终强制回滚：fn 内所有写入（含中间成功语句）
   * 都不产生提交行；fn 内断言失败时事务同样回滚，诊断原样上抛。
   */
  const withRolledBackTransaction = async (
    fn: (manager: EntityManager) => Promise<void>,
  ): Promise<void> => {
    try {
      await dataSource.transaction(async (manager) => {
        await fn(manager);
        throw new ForceRollbackError();
      });
    } catch (error) {
      if (!(error instanceof ForceRollbackError)) {
        throw error;
      }
    }
  };

  const insertIdOf = (result: unknown): number => {
    const insertId = (result as { insertId?: unknown }).insertId;
    if (typeof insertId !== 'number' || insertId <= 0) {
      throw new Error(`写入未返回有效 insertId：${JSON.stringify(result)}`);
    }
    return insertId;
  };

  // =========================================================================
  // 夹具写入（全部使用真实 insertId；提交资源立即登记台账）
  // =========================================================================

  const insertIntake = async (
    manager: EntityManager,
    overrides: {
      recordUuid?: string;
      customerAccountId?: number;
      customerOrganizationId?: number;
      serviceOrganizationId?: number;
      equipmentModelId?: number;
      errorCode?: string;
      faultDescription?: string;
      analysisStatus?: string;
    } = {},
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO repair_request_intake
         (record_uuid, customer_account_id, customer_organization_id, service_organization_id,
          equipment_model_id, error_code, fault_description, analysis_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        // record_uuid 为 char(36)：直接使用真实 UUID，避免拼接前缀越界（D3 超长失败）。
        overrides.recordUuid ?? randomUUID(),
        overrides.customerAccountId ?? customerAccountId,
        overrides.customerOrganizationId ?? orgId,
        overrides.serviceOrganizationId ?? orgId,
        overrides.equipmentModelId ?? equipmentModelId,
        overrides.errorCode ?? 'E001',
        overrides.faultDescription ?? 'G2 故障描述',
        overrides.analysisStatus ?? 'WAITING',
      ],
    );
    return insertIdOf(result);
  };

  const registerCommittedIntake = (intakeId: number, recordUuid: string): void => {
    recordOwnedResource(testLedger, 'repairRequestIntake', intakeId, {
      recordUuid,
      customerAccountId,
      customerOrganizationId: orgId,
      serviceOrganizationId: orgId,
      equipmentModelId,
      errorCode: 'E001',
      faultDescription: 'G2 故障描述',
      fileId: null,
    });
  };

  const insertRepairRequest = async (
    manager: EntityManager,
    overrides: {
      requestNo?: string;
      customerAccountId?: number;
      equipmentModelId?: number;
      intakeId?: number | null;
      customerOrganizationId?: number | null;
      serviceOrganizationId?: number | null;
      closureStatus?: string | null;
      closedAt?: string | null;
      handlingResult?: string | null;
      closureReason?: string | null;
      currentRevisionNo?: number;
      isAccepted?: number;
      acceptedByEngineerAccountId?: number | null;
      acceptedAt?: string | null;
      handlingStatus?: string | null;
      handlingRecordedAt?: string | null;
      handlingEndedAt?: string | null;
    } = {},
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO repair_request
         (request_no, customer_account_id, equipment_model_id, error_code, fault_description,
          content_md, intake_id, customer_organization_id, service_organization_id,
          closure_status, closed_at, handling_result, closure_reason, current_revision_no,
          is_accepted, accepted_by_engineer_account_id, accepted_at,
          handling_status, handling_recorded_at, handling_ended_at)
       VALUES (?, ?, ?, 'E001', 'G2 故障描述', '# G2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        // request_no 为 varchar(50)：G2- + runTag + UUID = 47 字符，留出余量（D3 超长失败）。
        overrides.requestNo ?? `G2-${runTag}-${randomUUID()}`,
        overrides.customerAccountId ?? customerAccountId,
        overrides.equipmentModelId ?? equipmentModelId,
        overrides.intakeId ?? null,
        overrides.customerOrganizationId === undefined ? orgId : overrides.customerOrganizationId,
        overrides.serviceOrganizationId === undefined ? orgId : overrides.serviceOrganizationId,
        overrides.closureStatus ?? null,
        overrides.closedAt ?? null,
        overrides.handlingResult ?? null,
        overrides.closureReason ?? null,
        overrides.currentRevisionNo ?? 0,
        overrides.isAccepted ?? 0,
        overrides.acceptedByEngineerAccountId ?? null,
        overrides.acceptedAt ?? null,
        overrides.handlingStatus ?? null,
        overrides.handlingRecordedAt ?? null,
        overrides.handlingEndedAt ?? null,
      ],
    );
    return insertIdOf(result);
  };

  const registerCommittedRepairRequest = (
    requestId: number,
    requestNo: string,
    overrides: { errorCode?: string } = {},
  ): void => {
    // 该类工单的客户账号/机型/公司均属套件级父夹具，生命周期与套件一致：
    // 登记进套件台账，使清理计划同时包含“经独立证明的父行 + 本工单”，
    // 归属预检（R01：客户账号必须在账本内）才不会拒绝收尾。
    recordOwnedResource(suiteLedger, 'repairRequest', requestId, {
      requestNo,
      customerAccountId,
      equipmentModelId,
      errorCode: overrides.errorCode ?? 'E001',
      faultDescription: 'G2 故障描述',
    });
  };

  /**
   * 已提交的修订子行登记（父行关系不是删除授权）：
   * 清理预检要求子行自带归属事实，否则整批拒绝删除。
   */
  const registerCommittedRepairRequestRevision = (
    revisionId: number,
    requestId: number,
    revisionNo: number,
    schemaVersion: number,
  ): void => {
    recordOwnedResource(suiteLedger, 'repairRequestRevision', revisionId, {
      requestId,
      revisionNo,
      actorAccountId: engineerAccountId,
      schemaVersion,
    });
  };

  const insertReport = async (
    manager: EntityManager,
    overrides: {
      ownerOrganizationId?: number;
      createdByAccountId?: number;
      submissionRequestId?: string | null;
      submissionPayloadHash?: string | null;
      handlingResult?: string | null;
      closureReason?: string | null;
    } = {},
  ): Promise<number> => {
    const result = await manager.query(
      // source_type 必填且与 repair_request_id 成对（HISTORICAL_CASE ⇒ 工单为空）；
      // maintenance_engineer_* 两列 NOT NULL 且无默认值（D3 缺失）。
      `INSERT INTO maintenance_report
         (owner_organization_id, source_type, created_by_account_id, updated_by_account_id,
          maintenance_engineer_account_id, maintenance_engineer_name_snapshot,
          submission_request_id, submission_payload_hash, handling_result, closure_reason)
       VALUES (?, 'HISTORICAL_CASE', ?, ?, ?, 'G2 工程师快照', ?, ?, ?, ?)`,
      [
        overrides.ownerOrganizationId ?? orgId,
        overrides.createdByAccountId ?? engineerAccountId,
        overrides.createdByAccountId ?? engineerAccountId,
        overrides.createdByAccountId ?? engineerAccountId,
        overrides.submissionRequestId ?? null,
        overrides.submissionPayloadHash ?? null,
        overrides.handlingResult ?? null,
        overrides.closureReason ?? null,
      ],
    );
    return insertIdOf(result);
  };

  const insertReportVersion = async (
    manager: EntityManager,
    reportId: number,
    versionNo: number,
  ): Promise<number> => {
    const result = await manager.query(
      // submitted_at NOT NULL 且无默认值（D3 缺失）。
      `INSERT INTO maintenance_report_version
         (report_id, version_no, payload_snapshot, submitted_by_account_id, submitted_at)
       VALUES (?, ?, ?, ?, NOW(3))`,
      [reportId, versionNo, JSON.stringify({ schema_version: 2, tag: runTag }), engineerAccountId],
    );
    return insertIdOf(result);
  };

  const insertReportStep = async (
    manager: EntityManager,
    reportId: number,
    stepNo: number,
    stepCode: string,
  ): Promise<number> => {
    const result = await manager.query(
      // phase_code 合法域为 PHASE_01..PHASE_10（D3 使用 'REPAIR' 触发 CHECK）。
      `INSERT INTO maintenance_report_step
         (report_id, step_no, step_code, phase_code, action_text)
       VALUES (?, ?, ?, 'PHASE_01', 'G2 步骤')`,
      [reportId, stepNo, stepCode],
    );
    return insertIdOf(result);
  };

  const insertConversation = async (manager: EntityManager): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO ai_conversation (engineer_account_id) VALUES (?)`,
      [engineerAccountId],
    );
    return insertIdOf(result);
  };

  const insertMessage = async (
    manager: EntityManager,
    conversationId: number,
    contentVersion = 1,
    messageSeq = 1,
  ): Promise<number> => {
    const result = await manager.query(
      // message_seq NOT NULL 且无默认值，uk(conversation_id, message_seq)；
      // role=USER 时 turn_no 必须非空（chk_ai_message_role_turn）。
      `INSERT INTO ai_message (conversation_id, message_seq, turn_no, role, content_text, content_version)
       VALUES (?, ?, 1, 'USER', 'G2 问题', ?)`,
      [conversationId, messageSeq, contentVersion],
    );
    return insertIdOf(result);
  };

  const insertDocument = async (
    manager: EntityManager,
    overrides: {
      sourceKind?: string;
      contentText?: string | null;
      storageReference?: string | null;
      sourceReportId?: number | null;
      sourceReportVersionId?: number | null;
      ownershipStatus?: string;
      ownerOrganizationId?: number | null;
      publicationStatus?: string;
      deprecated?: number;
      deletedAt?: string | null;
    } = {},
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO reference_document
         (title, document_type, created_by_account_id, source_kind, content_text,
          storage_reference, source_report_id, source_report_version_id,
          ownership_status, owner_organization_id, publication_status, ingest_method,
          deprecated, deleted_at)
       VALUES (?, 'G2_TYPE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_DIRECT', ?, ?)`,
      [
        `G2 文档 ${runTag} ${randomUUID()}`,
        engineerAccountId,
        overrides.sourceKind ?? 'MATERIAL',
        overrides.contentText === undefined ? 'G2 正文' : overrides.contentText,
        overrides.storageReference ?? null,
        overrides.sourceReportId ?? null,
        overrides.sourceReportVersionId ?? null,
        overrides.ownershipStatus ?? 'PENDING',
        overrides.ownerOrganizationId ?? null,
        overrides.publicationStatus ?? 'ONLINE',
        overrides.deprecated ?? 0,
        overrides.deletedAt ?? null,
      ],
    );
    return insertIdOf(result);
  };

  /**
   * 工单修订行：默认写入合法 before/after 快照，供 2.4 逐项只改被测条件。
   * 其余必填列（actor、reason、revision_no）保持合法，避免其他约束提前拦截。
   */
  const insertRepairRevision = async (
    manager: EntityManager,
    requestId: number,
    snapshots: { before: string; after: string },
    schemaVersion = 1,
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO repair_request_revision
         (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
          schema_version, reason)
       VALUES (?, 1, ?, ?, ?, ?, 'G2 修订')`,
      [requestId, snapshots.before, snapshots.after, engineerAccountId, schemaVersion],
    );
    return insertIdOf(result);
  };

  /** 资料修订行：无独立版本列，格式版本只在 JSON 内（OI-02）。 */
  const insertDocumentRevision = async (
    manager: EntityManager,
    documentId: number,
    snapshots: { before: string; after: string },
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO reference_document_revision
         (document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason)
       VALUES (?, 1, ?, ?, ?, 'G2 修订')`,
      [documentId, snapshots.before, snapshots.after, engineerAccountId],
    );
    return insertIdOf(result);
  };

  const insertStoredFile = async (
    manager: EntityManager,
    overrides: {
      fileId?: string;
      status?: string;
      verifiedAt?: string | null;
      bindingStatus?: string;
      businessId?: string | null;
    } = {},
  ): Promise<string> => {
    const fileId = overrides.fileId ?? randomUUID();
    await manager.query(
      `INSERT INTO stored_file
         (file_id, uploaded_by_account_id, owner_organization_id, storage_reference,
          original_filename, mime_type, byte_size, checksum_sha256, status,
          business_type, business_id, upload_context_id, binding_status, verified_at)
       VALUES (?, ?, ?, ?, 'g2.txt', 'text/plain', 100, ?, ?, 'REPORT', ?, ?, ?, ?)`,
      [
        fileId,
        customerAccountId,
        orgId,
        `oss://g2/${fileId}`,
        'a'.repeat(64),
        overrides.status ?? 'STAGING',
        overrides.businessId ?? null,
        // upload_context_id 为 char(36) 且唯一：使用真实 UUID（D3 拼接前缀超长）。
        randomUUID(),
        overrides.bindingStatus ?? 'TEMPORARY',
        overrides.verifiedAt ?? null,
      ],
    );
    return fileId;
  };

  const insertAttempt = async (
    manager: EntityManager,
    intakeId: number,
    generationNo: number,
    overrides: { status?: string; failureReason?: string | null } = {},
  ): Promise<number> => {
    const result = await manager.query(
      `INSERT INTO intake_analysis_attempt (intake_id, generation_no, status, failure_reason)
       VALUES (?, ?, ?, ?)`,
      [intakeId, generationNo, overrides.status ?? 'RUNNING', overrides.failureReason ?? null],
    );
    return insertIdOf(result);
  };

  const insertAnalysis = async (
    manager: EntityManager,
    overrides: {
      questionUuid?: string;
      conversationId: number;
      questionMessageId: number;
      status?: string;
      completedAt?: string | null;
    },
  ): Promise<string> => {
    const questionUuid = overrides.questionUuid ?? randomUUID();
    await manager.query(
      `INSERT INTO ai_message_analysis
         (question_uuid, conversation_id, question_message_id, status, content_version,
          completed_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [
        questionUuid,
        overrides.conversationId,
        overrides.questionMessageId,
        overrides.status ?? 'PENDING',
        overrides.completedAt ?? null,
      ],
    );
    return questionUuid;
  };

  const insertInstallationIfMissing = async (manager: EntityManager): Promise<string> => {
    const existing = await manager.query<{ installation_id: string }[]>(
      `SELECT installation_id FROM local_installation WHERE id = 1`,
    );
    if (existing.length > 0) {
      return existing[0].installation_id;
    }
    const installationId = randomUUID();
    await manager.query(
      `INSERT INTO local_installation (id, installation_id, organization_id) VALUES (1, ?, ?)`,
      [installationId, orgId],
    );
    return installationId;
  };

  const insertBackupRun = async (
    manager: EntityManager,
    installationId: string,
    overrides: { status?: string; finishedAt?: string | null } = {},
  ): Promise<number> => {
    const result = await manager.query(
      // trigger_type / started_at 均 NOT NULL 且无默认值（D3 缺失）。
      `INSERT INTO local_backup_run (installation_id, trigger_type, status, started_at, finished_at)
       VALUES (?, 'MANUAL', ?, NOW(3), ?)`,
      [installationId, overrides.status ?? 'RUNNING', overrides.finishedAt ?? null],
    );
    return insertIdOf(result);
  };

  const insertBackupAsset = async (
    manager: EntityManager,
    runId: number,
    overrides: { backupId?: string; cloudStatus?: string; cloudReceipt?: string | null } = {},
  ): Promise<string> => {
    const backupId = overrides.backupId ?? randomUUID();
    await manager.query(
      // local_status / byte_size 均 NOT NULL 且无默认值（D3 缺失）；
      // S5：安装标识/格式/数据版本/清单摘要/加密密钥标识均为必填。
      `INSERT INTO backup_asset
         (backup_id, run_id, organization_id, installation_id, format_version, data_version,
          manifest_checksum, encryption_key_id, storage_reference, file_sha256,
          local_status, byte_size, cloud_status, cloud_receipt)
       VALUES (?, ?, ?, ?, 1, 'v13', ?, ?, ?, ?, 'PENDING', 100, ?, ?)`,
      [
        backupId,
        runId,
        orgId,
        randomUUID(),
        'd'.repeat(64),
        'field-key-v1',
        `oss://g2-backup/${backupId}`,
        'b'.repeat(64),
        overrides.cloudStatus ?? 'PENDING',
        overrides.cloudReceipt ?? null,
      ],
    );
    return backupId;
  };

  const insertRestoreRun = async (
    manager: EntityManager,
    backupId: string,
    protectionBackupId: string,
  ): Promise<string> => {
    const restoreId = randomUUID();
    // S5：target_installation_id 有外键指向 local_installation，必须使用已登记的安装标识。
    const targetInstallationId = await insertInstallationIfMissing(manager);
    await manager.query(
      // status / check_snapshot 均 NOT NULL 且无默认值（D3 缺失）；
      // check_snapshot 必须含 schema_version（chk_backup_restore_run_schema）；
      // S5：执行阶段必须有目标安装、检查结论与确认原文。
      `INSERT INTO backup_restore_run
         (restore_id, backup_id, protection_backup_id, target_installation_id,
          check_status, confirmation, organization_id, started_by_account_id,
          status, check_snapshot, started_at)
       VALUES (?, ?, ?, ?, 'PASSED', ?, ?, ?, 'RUNNING', ?, CURRENT_TIMESTAMP(3))`,
      [
        restoreId,
        backupId,
        protectionBackupId,
        targetInstallationId,
        JSON.stringify({ confirmed: true }),
        orgId,
        engineerAccountId,
        JSON.stringify({ schema_version: 1 }),
      ],
    );
    return restoreId;
  };

  // =========================================================================
  // 生命周期
  // =========================================================================

  beforeAll(async () => {
    // 门控 1：许可开关由 ENABLED 保证；门控 2：白名单。
    assertAllowedE2eDatabase(EXPECTED_DB);
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: EXPECTED_DB,
      timezone: process.env.DB_TIMEZONE ?? '+08:00',
      synchronize: false,
      migrationsRun: false,
      // 最小装配：createTestAccount 只用 Account/UserInfo 仓储；
      // UserInfo 的字符串外键要求 OrganizationEntity 一并注册。
      entities: [...ACCOUNT_WRITE_FIXTURE_ENTITIES],
    });
    await dataSource.initialize();
    // 门控 3：实际连接库 === 预期库（第一条写 SQL 之前）。
    await assertManagerOnExpectedE2eDatabase(dataSource.createEntityManager(), EXPECTED_DB);

    // 套件级父夹具：真实自增 ID 立即登记台账。
    suiteLedger = createOwnedResourceLedger();
    const orgResult = await dataSource.query(
      `INSERT INTO organization (organization_code, name, kind, status) VALUES (?, ?, 'PEER', 'ACTIVE')`,
      [`G2ORG-${runTag}`, `G2 组织 ${runTag}`],
    );
    orgId = insertIdOf(orgResult);
    recordOwnedResource(suiteLedger, 'organization', orgId, {
      organizationCode: `G2ORG-${runTag}`,
      name: `G2 组织 ${runTag}`,
      kind: 'PEER',
      status: 'ACTIVE',
    });

    const customer = await createTestAccount(
      dataSource,
      null,
      {
        loginName: `g2_customer_${runTag}`,
        loginEmail: `g2_customer_${runTag}@example.com`,
        loginPassword: 'G2Spec!Passw0rd',
        status: AccountStatus.ACTIVE,
        identityType: IdentityTypeEnum.CUSTOMER,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
      },
      suiteLedger,
    );
    customerAccountId = customer.accountId;

    const engineer = await createTestAccount(
      dataSource,
      null,
      {
        loginName: `g2_engineer_${runTag}`,
        loginEmail: `g2_engineer_${runTag}@example.com`,
        loginPassword: 'G2Spec!Passw0rd',
        status: AccountStatus.ACTIVE,
        identityType: IdentityTypeEnum.ENGINEER,
        accessGroup: [IdentityTypeEnum.ENGINEER],
      },
      suiteLedger,
    );
    engineerAccountId = engineer.accountId;

    const modelResult = await dataSource.query(
      `INSERT INTO equipment_model (model_code, model_name, enabled, sort_order) VALUES (?, ?, 1, 0)`,
      [`G2MDL-${runTag}`, `G2 机型 ${runTag}`],
    );
    equipmentModelId = insertIdOf(modelResult);
    recordOwnedResource(suiteLedger, 'equipmentModel', equipmentModelId, {
      modelCode: `G2MDL-${runTag}`,
      modelName: `G2 机型 ${runTag}`,
      enabled: true,
      sortOrder: 0,
    });
  });

  afterAll(async () => {
    const diagnostics: unknown[] = [];
    if (typeof suiteLedger !== 'undefined') {
      try {
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'v13-db-verification-suite',
          owned: suiteLedger,
          expectedDatabase: EXPECTED_DB,
        });
      } catch (error) {
        diagnostics.push(new Error('套件级夹具回收失败', { cause: error }));
      }
    }
    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
      } catch (error) {
        diagnostics.push(new Error('DataSource 关闭失败', { cause: error }));
      }
    }
    if (diagnostics.length > 0) {
      throw new AggregateError(diagnostics, 'G-2 afterAll 存在失败诊断');
    }
  });

  beforeEach(() => {
    testLedger = createOwnedResourceLedger();
  });

  afterEach(async () => {
    try {
      await runGuardedSpecCleanup({
        dataSource,
        helper: 'v13-db-verification-case',
        owned: testLedger,
        expectedDatabase: EXPECTED_DB,
      });
    } catch (error) {
      // 清理失败必须显式失败并保留诊断，不允许残留伪装成功。
      throw new Error('G-2 用例级资源回收失败', { cause: error });
    }
  });

  // =========================================================================
  // 2.1 唯一键与一次提交（S2 §2.1，14 项全覆盖）
  // 全部在强制回滚事务内验证，不产生提交行。
  // =========================================================================
  describe('2.1 唯一键', () => {
    it('报修转单唯一：两个 intake 回写同一 converted_request_id 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const requestId = await insertRepairRequest(m);
        const intakeA = await insertIntake(m);
        await m.query(`UPDATE repair_request_intake SET converted_request_id = ? WHERE id = ?`, [
          requestId,
          intakeA,
        ]);
        const intakeB = await insertIntake(m);
        await expectRejectedWith(
          () =>
            m.query(`UPDATE repair_request_intake SET converted_request_id = ? WHERE id = ?`, [
              requestId,
              intakeB,
            ]),
          DUP_ENTRY,
          'uk_repair_request_intake_converted',
        );
        // 失败后数据状态：intakeB 仍未转单。
        const rows = await m.query<{ converted_request_id: unknown }[]>(
          `SELECT converted_request_id FROM repair_request_intake WHERE id = ?`,
          [intakeB],
        );
        expect(rows[0].converted_request_id).toBeNull();
      });
    });

    it('报修 intake 一对一：两条 repair_request 使用同一 intake_id 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const intakeId = await insertIntake(m);
        await insertRepairRequest(m, { intakeId });
        await expectRejectedWith(
          () => insertRepairRequest(m, { intakeId }),
          DUP_ENTRY,
          'uk_repair_request_intake',
        );
        const rows = await m.query<unknown[]>(`SELECT id FROM repair_request WHERE intake_id = ?`, [
          intakeId,
        ]);
        expect(rows).toHaveLength(1);
      });
    });

    it('报修记录编号唯一：同一 record_uuid 第二条被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        // record_uuid 为 char(36)：使用真实 UUID（D3 拼接前缀超长）。
        const recordUuid = randomUUID();
        await insertIntake(m, { recordUuid });
        await expectRejectedWith(
          () => insertIntake(m, { recordUuid }),
          DUP_ENTRY,
          'uk_repair_request_intake_record_uuid',
        );
        const rows = await m.query<unknown[]>(
          `SELECT id FROM repair_request_intake WHERE record_uuid = ?`,
          [recordUuid],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('分析代数唯一：同一 intake 写入两个相同 generation_no 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const intakeId = await insertIntake(m);
        await insertAttempt(m, intakeId, 1);
        await expectRejectedWith(
          () => insertAttempt(m, intakeId, 1),
          DUP_ENTRY,
          'uk_intake_analysis_attempt_generation',
        );
        const rows = await m.query<unknown[]>(
          `SELECT id FROM intake_analysis_attempt WHERE intake_id = ? AND generation_no = 1`,
          [intakeId],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('问题分析一对一：两条分析使用同一 question_message_id 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const conversationId = await insertConversation(m);
        const questionMessageId = await insertMessage(m, conversationId);
        await insertAnalysis(m, { conversationId, questionMessageId });
        await expectRejectedWith(
          () => insertAnalysis(m, { conversationId, questionMessageId }),
          DUP_ENTRY,
          'uk_ai_message_analysis_question',
        );
      });
    });

    it('报告一次提交唯一：同一提交三元组第二条被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const submissionRequestId = `g2-sub-${runTag}-${randomUUID()}`;
        const hash = 'h'.repeat(64);
        await insertReport(m, { submissionRequestId, submissionPayloadHash: hash });
        await expectRejectedWith(
          () => insertReport(m, { submissionRequestId, submissionPayloadHash: hash }),
          DUP_ENTRY,
          'uk_maintenance_report_submission',
        );
        // 不同 submission_request_id 可写入（业务层另行判定幂等）。
        const other = await insertReport(m, {
          submissionRequestId: `${submissionRequestId}-other`,
          submissionPayloadHash: hash,
        });
        expect(other).toBeGreaterThan(0);
      });
    });

    it('报告来源版本唯一：两条 reference_document 指向同一来源版本被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const reportId = await insertReport(m);
        const versionId = await insertReportVersion(m, reportId, 1);
        await insertDocument(m, {
          sourceKind: 'INDEPENDENT_REPORT',
          contentText: null,
          sourceReportId: reportId,
          sourceReportVersionId: versionId,
        });
        await expectRejectedWith(
          () =>
            insertDocument(m, {
              sourceKind: 'INDEPENDENT_REPORT',
              contentText: null,
              sourceReportId: reportId,
              sourceReportVersionId: versionId,
            }),
          DUP_ENTRY,
          'uk_reference_document_source_report_version',
        );
      });
    });

    it('下架/软删不释放唯一：OFFLINE + deprecated + deleted_at 后仍被唯一键拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const reportId = await insertReport(m);
        const versionId = await insertReportVersion(m, reportId, 1);
        const documentId = await insertDocument(m, {
          sourceKind: 'INDEPENDENT_REPORT',
          contentText: null,
          sourceReportId: reportId,
          sourceReportVersionId: versionId,
        });
        await m.query(
          `UPDATE reference_document
              SET publication_status = 'OFFLINE', deprecated = 1, deleted_at = NOW(3)
            WHERE id = ?`,
          [documentId],
        );
        await expectRejectedWith(
          () =>
            insertDocument(m, {
              sourceKind: 'INDEPENDENT_REPORT',
              contentText: null,
              sourceReportId: reportId,
              sourceReportVersionId: versionId,
            }),
          DUP_ENTRY,
          '下架/软删后来源版本唯一键仍生效',
        );
      });
    });

    it('维修修订版本唯一：同一 request_id 两个相同 revision_no 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const requestId = await insertRepairRequest(m);
        // 快照列名为 before_snapshot / after_snapshot（D3 仍写 snapshot）；
        // CHECK 要求两列均为合法 JSON 且 $.schema_version 与列值一致。
        const beforeSnapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        const afterSnapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        await m.query(
          `INSERT INTO repair_request_revision
             (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
              schema_version, reason)
           VALUES (?, 1, ?, ?, ?, 1, 'G2 修订')`,
          [requestId, beforeSnapshot, afterSnapshot, engineerAccountId],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO repair_request_revision
                 (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
                  schema_version, reason)
               VALUES (?, 1, ?, ?, ?, 1, 'G2 修订')`,
              [requestId, beforeSnapshot, afterSnapshot, engineerAccountId],
            ),
          DUP_ENTRY,
          'uk_repair_request_revision_no',
        );
      });
    });

    it('文档修订版本唯一：同一 document_id 两个相同 revision_no 被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const documentId = await insertDocument(m);
        const beforeSnapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        const afterSnapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        await m.query(
          `INSERT INTO reference_document_revision
             (document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason)
           VALUES (?, 1, ?, ?, ?, 'G2 修订')`,
          [documentId, beforeSnapshot, afterSnapshot, engineerAccountId],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO reference_document_revision
                 (document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason)
               VALUES (?, 1, ?, ?, ?, 'G2 修订')`,
              [documentId, beforeSnapshot, afterSnapshot, engineerAccountId],
            ),
          DUP_ENTRY,
          'uk_reference_document_revision_no',
        );
      });
    });

    it('同步回执唯一：同一范围四元组第二条被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const recordUuid = `g2-receipt-${runTag}`;
        // source_installation_id NOT NULL；receipt_status NOT NULL 且无默认值（D3 缺失）。
        await m.query(
          `INSERT INTO sync_receipt
             (receipt_id, record_uuid, organization_id, resource_type, version_no,
              source_system, source_installation_id, receipt_status, manifest_checksum)
           VALUES (?, ?, ?, 'REPAIR', 1, 'LOCAL', ?, 'PENDING', ?)`,
          [randomUUID(), recordUuid, orgId, randomUUID(), 'c'.repeat(64)],
        );
        // 四列唯一键不含 source_system：换来源仍属同一版本，必须拒绝。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO sync_receipt
                 (receipt_id, record_uuid, organization_id, resource_type, version_no,
                  source_system, source_installation_id, receipt_status, manifest_checksum)
               VALUES (?, ?, ?, 'REPAIR', 1, 'CLOUD', ?, 'PENDING', ?)`,
              [randomUUID(), recordUuid, orgId, randomUUID(), 'c'.repeat(64)],
            ),
          DUP_ENTRY,
          'uk_sync_receipt_scope_v13',
        );
      });
    });

    it('冲突记录唯一：同一范围四元组第二条被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const recordUuid = `g2-conflict-${runTag}`;
        // local_snapshot / cloud_snapshot / conflict_reason / status 均 NOT NULL 且无默认值（D3 缺失）。
        const snapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        await m.query(
          `INSERT INTO sync_conflict
             (conflict_id, record_uuid, organization_id, resource_type, version_no,
              local_snapshot, cloud_snapshot, conflict_reason, status)
           VALUES (?, ?, ?, 'REPAIR', 1, ?, ?, 'G2 冲突', 'PENDING')`,
          [randomUUID(), recordUuid, orgId, snapshot, snapshot],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO sync_conflict
                 (conflict_id, record_uuid, organization_id, resource_type, version_no,
                  local_snapshot, cloud_snapshot, conflict_reason, status)
               VALUES (?, ?, ?, 'REPAIR', 1, ?, ?, 'G2 冲突', 'PENDING')`,
              [randomUUID(), recordUuid, orgId, snapshot, snapshot],
            ),
          DUP_ENTRY,
          'uk_sync_conflict_scope',
        );
      });
    });

    it('记录包条目唯一：同一范围四元组第二条被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = randomUUID();
        // manifest_json / status 均 NOT NULL 且无默认值（D3 缺失）。
        await m.query(
          `INSERT INTO record_package_import
             (package_id, organization_id, imported_by_account_id, manifest_checksum,
              manifest_json, status)
           VALUES (?, ?, ?, ?, ?, 'PENDING')`,
          [
            packageId,
            orgId,
            engineerAccountId,
            'd'.repeat(64),
            JSON.stringify({ schema_version: 1, tag: runTag }),
          ],
        );
        const recordUuid = `g2-item-${runTag}`;
        // result 合法域为 SUCCEEDED/FAILED/SKIPPED（D3 使用 'PENDING' 触发 CHECK）。
        await m.query(
          `INSERT INTO record_package_item
             (package_id, record_uuid, resource_type, version_no, result)
           VALUES (?, ?, 'REPAIR', 1, 'SKIPPED')`,
          [packageId, recordUuid],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO record_package_item
                 (package_id, record_uuid, resource_type, version_no, result)
               VALUES (?, ?, 'REPAIR', 1, 'SKIPPED')`,
              [packageId, recordUuid],
            ),
          DUP_ENTRY,
          'uk_record_package_item_scope',
        );
      });
    });

    it('设备公司唯一：同一 installation_id+organization_id 两条配置被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        await m.query(
          `INSERT INTO local_company_setting (installation_id, organization_id, setting_source)
           VALUES (?, ?, 'LOCAL_MANUAL')`,
          [installationId, orgId],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO local_company_setting (installation_id, organization_id, setting_source)
               VALUES (?, ?, 'LOCAL_MANUAL')`,
              [installationId, orgId],
            ),
          DUP_ENTRY,
          'uk_local_company_setting_scope',
        );
      });
    });

    it('授权范围唯一：同一 installation_id+account_id+organization_id 两条授权被 ER_DUP_ENTRY 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        // authorization_status NOT NULL 且无默认值（D3 缺失）。
        await m.query(
          `INSERT INTO local_account_authorization
             (installation_id, account_id, organization_id, authorization_status)
           VALUES (?, ?, ?, 'ACTIVE')`,
          [installationId, customerAccountId, orgId],
        );
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO local_account_authorization
                 (installation_id, account_id, organization_id, authorization_status)
               VALUES (?, ?, ?, 'ACTIVE')`,
              [installationId, customerAccountId, orgId],
            ),
          DUP_ENTRY,
          'uk_local_account_authorization_scope',
        );
      });
    });
  });

  // =========================================================================
  // 2.2 外键与删除策略（S2 §2.2，6 项全覆盖；真实行为断言，非结构检查）
  // =========================================================================
  describe('2.2 外键与删除策略', () => {
    it('同报告版本复合外键：source_report_id 与 source_report_version_id 不匹配被 ER_NO_REFERENCED_ROW 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const reportA = await insertReport(m);
        const versionA = await insertReportVersion(m, reportA, 1);
        const reportB = await insertReport(m);
        // 合法输入：版本属于本报告，可写入。
        await insertDocument(m, {
          sourceKind: 'INDEPENDENT_REPORT',
          contentText: null,
          sourceReportId: reportA,
          sourceReportVersionId: versionA,
        });
        // 非法输入：report_id=B 且 versionId 不存在。
        // 不能复用报告 A 的版本 ID：uk(source_report_version_id) 会先以 1062 触发，
        // 掩盖目标复合外键；这里换用不存在的版本号，唯一键满足后才命中 1452。
        await expectRejectedWith(
          () =>
            insertDocument(m, {
              sourceKind: 'INDEPENDENT_REPORT',
              contentText: null,
              sourceReportId: reportB,
              sourceReportVersionId: 2147483000,
            }),
          NO_REFERENCED_ROW,
          'fk_reference_document_source_report_version 复合列不匹配',
        );
        // 失败后数据状态：仅合法行存在。
        const rows = await m.query<unknown[]>(
          `SELECT id FROM reference_document WHERE source_report_version_id = ?`,
          [versionA],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('故障步骤复合外键：report_id 与 step_code 分属不同报告被 ER_NO_REFERENCED_ROW 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const reportA = await insertReport(m);
        await insertReportStep(m, reportA, 1, 'STEP_A');
        const reportB = await insertReport(m);
        // branch_kind=STEP_NEW_FAULT 时 step_code 必须非空（chk_..._step），
        // lifecycle_status/lifecycle_source/is_active 为必填无默认列（S5）；
        // 合法输入：步骤属于本报告。
        await m.query(
          `INSERT INTO maintenance_report_fault
             (report_id, fault_uuid, branch_kind, step_code, fault_description,
              is_active, lifecycle_status, lifecycle_source)
           VALUES (?, ?, 'STEP_NEW_FAULT', 'STEP_A', 'G2 故障', 1, 'OPEN', 'USER')`,
          [reportA, randomUUID()],
        );
        // 非法输入：report_id=B 但 step_code 属于报告 A（复合外键不匹配）。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO maintenance_report_fault
                 (report_id, fault_uuid, branch_kind, step_code, fault_description,
                  is_active, lifecycle_status, lifecycle_source)
               VALUES (?, ?, 'STEP_NEW_FAULT', 'STEP_A', 'G2 故障', 1, 'OPEN', 'USER')`,
              [reportB, randomUUID()],
            ),
          NO_REFERENCED_ROW,
          'fk_maintenance_report_fault_step 复合列不匹配',
        );
      });
    });

    it('删除仍被 repair_request.intake_id 引用的 intake 被 RESTRICT 拒绝（ER_ROW_IS_REFERENCED）', async () => {
      await withRolledBackTransaction(async (m) => {
        const intakeId = await insertIntake(m);
        await insertRepairRequest(m, { intakeId });
        await expectRejectedWith(
          () => m.query(`DELETE FROM repair_request_intake WHERE id = ?`, [intakeId]),
          ROW_IS_REFERENCED,
          'fk_repair_request_intake RESTRICT',
        );
        // 失败后数据状态：intake 仍存在。
        const rows = await m.query<unknown[]>(`SELECT id FROM repair_request_intake WHERE id = ?`, [
          intakeId,
        ]);
        expect(rows).toHaveLength(1);
      });
    });

    it('删除仍被 backup_asset.run_id 引用的 local_backup_run 被 RESTRICT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        const runId = await insertBackupRun(m, installationId);
        await insertBackupAsset(m, runId);
        await expectRejectedWith(
          () => m.query(`DELETE FROM local_backup_run WHERE id = ?`, [runId]),
          ROW_IS_REFERENCED,
          'fk_backup_asset_run RESTRICT',
        );
      });
    });

    it('删除仍被 backup_restore_run 引用的 backup_asset 被 RESTRICT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        const runId = await insertBackupRun(m, installationId);
        const backupId = await insertBackupAsset(m, runId);
        const protectionId = await insertBackupAsset(m, runId);
        await insertRestoreRun(m, backupId, protectionId);
        await expectRejectedWith(
          () => m.query(`DELETE FROM backup_asset WHERE backup_id = ?`, [backupId]),
          ROW_IS_REFERENCED,
          'fk_backup_restore_run_backup RESTRICT',
        );
        await expectRejectedWith(
          () => m.query(`DELETE FROM backup_asset WHERE backup_id = ?`, [protectionId]),
          ROW_IS_REFERENCED,
          'fk_backup_restore_run_protection RESTRICT',
        );
      });
    });

    it('删除仍被授权/配置引用的 local_installation 被 RESTRICT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        await m.query(
          `INSERT INTO local_account_authorization
             (installation_id, account_id, organization_id, authorization_status)
           VALUES (?, ?, ?, 'ACTIVE')`,
          [installationId, customerAccountId, orgId],
        );
        await expectRejectedWith(
          () => m.query(`DELETE FROM local_installation WHERE id = 1`),
          ROW_IS_REFERENCED,
          'fk_local_account_authorization_installation RESTRICT',
        );
      });
    });
  });

  // =========================================================================
  // 2.3 NULL 安全 CHECK（S2 §2.3，23 项全覆盖）
  // =========================================================================
  describe('2.3 NULL 安全 CHECK', () => {
    it('新报修必须有双公司：intake_id 非空但公司为空被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const intakeId = await insertIntake(m);
        // 合法输入：intake_id 非空且双公司齐全。
        await insertRepairRequest(m, { intakeId });
        // 非法输入：intake_id 非空但 customer_organization_id 为空。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO repair_request
                 (request_no, customer_account_id, equipment_model_id, error_code,
                  fault_description, content_md, intake_id,
                  customer_organization_id, service_organization_id)
               VALUES (?, ?, ?, 'E001', 'd', '# G2', ?, NULL, ?)`,
              [
                // request_no 为 varchar(50)：G2- 前缀 + runTag + UUID = 47 字符。
                `G2-${runTag}-${randomUUID()}`,
                customerAccountId,
                equipmentModelId,
                intakeId,
                orgId,
              ],
            ),
          CHECK_VIOLATED,
          'chk_repair_request_new_intake_companies（intake 非空缺公司）',
        );
      });
    });

    it('旧报修保留空归属：intake_id 与双公司均为 NULL 允许写入（正向）', async () => {
      await withRolledBackTransaction(async (m) => {
        const requestId = await insertRepairRequest(m, {
          customerOrganizationId: null,
          serviceOrganizationId: null,
        });
        const rows = await m.query<unknown[]>(`SELECT id FROM repair_request WHERE id = ?`, [
          requestId,
        ]);
        expect(rows).toHaveLength(1);
      });
    });

    it('结单成对：CLOSED 无 closed_at 或非 CLOSED 有 closed_at 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertRepairRequest(m, { closureStatus: 'CLOSED' }),
          CHECK_VIOLATED,
          'chk_repair_request_closure（CLOSED 缺 closed_at）',
        );
        await expectRejectedWith(
          () => insertRepairRequest(m, { closureStatus: 'OPEN', closedAt: '2026-01-01 00:00:00' }),
          CHECK_VIOLATED,
          'chk_repair_request_closure（OPEN 带 closed_at）',
        );
      });
    });

    it('结单原因：INTERRUPTED/UNREPAIRABLE 无 closure_reason 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        // 合法基础输入：受理 + 处理态齐全，仅缺 closure_reason 才是被测条件。
        // （否则先被 acceptance/handling_mapping/handling_time 等 CHECK 拦截，命题不成立。）
        const legalHandling = {
          isAccepted: 1,
          acceptedByEngineerAccountId: engineerAccountId,
          acceptedAt: '2026-01-01 00:00:00',
          handlingStatus: 'IN_PROGRESS',
          handlingRecordedAt: '2026-01-01 00:00:00',
        } as const;
        await insertRepairRequest(m, {
          ...legalHandling,
          handlingResult: 'INTERRUPTED',
          closureReason: '客户中止',
        });
        await expectRejectedWith(
          () => insertRepairRequest(m, { ...legalHandling, handlingResult: 'INTERRUPTED' }),
          CHECK_VIOLATED,
          'chk_repair_request_closure_reason',
        );
      });
    });

    it('当前修订号：负数被列类型 unsigned 拒绝（errno 1264），CHECK 由类型域覆盖', async () => {
      await withRolledBackTransaction(async (m) => {
        // 目标列定义为 int unsigned，-1 在写入阶段即被类型域拒绝（ER_WARN_DATA_OUT_OF_RANGE）。
        // CHECK (current_revision_no >= 0) 的合法域与 unsigned 完全重合，无法单独触发；
        // 因此断言 errno 1264 + SQLSTATE 22003，而不是把任意数据库错误当作 CHECK 通过。
        await expectRejectedWith(
          () => insertRepairRequest(m, { currentRevisionNo: -1 }),
          OUT_OF_RANGE,
          'current_revision_no 负数（类型越界）',
        );
      });
    });

    it('AI 会话内容版本：content_version < 1 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO ai_conversation (engineer_account_id, content_version) VALUES (?, 0)`,
              [engineerAccountId],
            ),
          CHECK_VIOLATED,
          'chk_ai_conversation_content_version',
        );
      });
    });

    it('AI 消息内容版本：content_version < 1 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const conversationId = await insertConversation(m);
        await expectRejectedWith(
          () => insertMessage(m, conversationId, 0),
          CHECK_VIOLATED,
          'chk_ai_message_content_version',
        );
      });
    });

    it('报告提交成对：仅填 submission_request_id 或仅填 hash 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertReport(m, { submissionRequestId: `g2-only-id-${runTag}` }),
          CHECK_VIOLATED,
          'chk_maintenance_report_submission_pair（仅 request_id）',
        );
        await expectRejectedWith(
          () => insertReport(m, { submissionPayloadHash: 'p'.repeat(64) }),
          CHECK_VIOLATED,
          'chk_maintenance_report_submission_pair（仅 hash）',
        );
      });
    });

    it('报告闭合原因：INTERRUPTED 无 closure_reason 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertReport(m, { handlingResult: 'UNREPAIRABLE' }),
          CHECK_VIOLATED,
          'chk_maintenance_report_closure_reason',
        );
        // 合法输入：UNREPAIRABLE 且给出非空原因。
        await insertReport(m, { handlingResult: 'UNREPAIRABLE', closureReason: '无法修复' });
      });
    });

    it('来源成对：source_report_id 与 source_report_version_id 只有一个非空被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const reportId = await insertReport(m);
        // 合法基础：MATERIAL + 正文（满足 content_source_v13），仅来源对不成对。
        await expectRejectedWith(
          () =>
            insertDocument(m, {
              sourceKind: 'MATERIAL',
              contentText: 'G2 正文',
              sourceReportId: reportId,
            }),
          CHECK_VIOLATED,
          'chk_reference_document_report_source_pair',
        );
      });
    });

    it('来源内容分支：MATERIAL 无正文/存储引用被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertDocument(m, { sourceKind: 'MATERIAL', contentText: null }),
          CHECK_VIOLATED,
          'chk_reference_document_content_source_v13（MATERIAL 无内容）',
        );
        await expectRejectedWith(
          () => insertDocument(m, { sourceKind: 'INDEPENDENT_REPORT', contentText: null }),
          CHECK_VIOLATED,
          'chk_reference_document_content_source_v13（报告来源缺 ID）',
        );
      });
    });

    it('归属状态：CONFIRMED 且 owner_organization_id 为空被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertDocument(m, { ownershipStatus: 'CONFIRMED', ownerOrganizationId: null }),
          CHECK_VIOLATED,
          'chk_reference_document_ownership',
        );
        // 合法输入：CONFIRMED 且归属公司非空。
        await insertDocument(m, { ownershipStatus: 'CONFIRMED', ownerOrganizationId: orgId });
      });
    });

    it('原件状态：VALID 无 verified_at 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertStoredFile(m, { status: 'VALID' }),
          CHECK_VIOLATED,
          'chk_stored_file_verified',
        );
        // 失败后数据状态：无任何行写入。
        const rows = await m.query<unknown[]>(
          `SELECT file_id FROM stored_file WHERE status = 'VALID'`,
        );
        expect(rows).toHaveLength(0);
      });
    });

    it('原件绑定成对：TEMPORARY 带 business_id 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertStoredFile(m, { bindingStatus: 'TEMPORARY', businessId: 'biz-1' }),
          CHECK_VIOLATED,
          'chk_stored_file_binding_pair',
        );
      });
    });

    it('分析失败原因：FAILED 无 failure_reason 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const intakeId = await insertIntake(m);
        await expectRejectedWith(
          () => insertAttempt(m, intakeId, 0, { status: 'FAILED' }),
          CHECK_VIOLATED,
          'chk_intake_analysis_attempt_failure',
        );
      });
    });

    it('问题分析完成时间：非 PENDING/RUNNING 无 completed_at 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const conversationId = await insertConversation(m);
        const questionMessageId = await insertMessage(m, conversationId);
        await expectRejectedWith(
          () =>
            insertAnalysis(m, {
              conversationId,
              questionMessageId,
              status: 'SUCCEEDED',
            }),
          CHECK_VIOLATED,
          'chk_ai_message_analysis_completed',
        );
      });
    });

    it('快照 JSON 版本：snapshot 的 schema_version 与列值不一致被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const requestId = await insertRepairRequest(m);
        const v1 = JSON.stringify({ schema_version: 1, tag: runTag });
        const v2 = JSON.stringify({ schema_version: 2, tag: runTag });
        // before 快照写 2、列与 after 为 1：JSON 均合法，仅数值不等（FALSE 才触发 CHECK；
        // 缺 schema_version 会得到 NULL，MySQL CHECK 视 UNKNOWN 为通过，不能作负例）。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO repair_request_revision
                 (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
                  schema_version, reason)
               VALUES (?, 1, ?, ?, ?, 1, 'G2 修订')`,
              [requestId, v2, v1, engineerAccountId],
            ),
          CHECK_VIOLATED,
          'chk_repair_request_revision_schema（before 与列值不一致）',
        );
        // after 快照与列值不一致。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO repair_request_revision
                 (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
                  schema_version, reason)
               VALUES (?, 1, ?, ?, ?, 1, 'G2 修订')`,
              [requestId, v1, v2, engineerAccountId],
            ),
          CHECK_VIOLATED,
          'chk_repair_request_revision_schema（after 与列值不一致）',
        );
      });
    });

    it('文档修订快照版本：snapshot 非合法 JSON 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const documentId = await insertDocument(m);
        // 缺 schema_version 时为 NULL（CHECK 视为通过），必须用非法 JSON 得到 FALSE。
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO reference_document_revision
                 (document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason)
               VALUES (?, 1, ?, ?, ?, 'G2 修订')`,
              [
                documentId,
                'not-json',
                JSON.stringify({ schema_version: 1, tag: runTag }),
                engineerAccountId,
              ],
            ),
          CHECK_VIOLATED,
          'chk_reference_document_revision_schema',
        );
      });
    });

    it('同步回执确认时间：非 PENDING/CONFLICT 且 received_at/confirmed_at 均为空被拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO sync_receipt
                 (receipt_id, record_uuid, organization_id, resource_type, version_no,
                  source_system, source_installation_id, manifest_checksum, receipt_status)
               VALUES (?, ?, ?, 'REPAIR', 1, 'CLOUD', ?, ?, 'SUCCEEDED')`,
              [randomUUID(), `g2-receipt-c-${runTag}`, orgId, randomUUID(), 'c'.repeat(64)],
            ),
          CHECK_VIOLATED,
          'chk_sync_receipt_confirm_time',
        );
      });
    });

    it('同步回执确认时间：只写 received_at 的 SUCCEEDED 合法（不强制双写 confirmed_at）', async () => {
      await withRolledBackTransaction(async (m) => {
        await m.query(
          `INSERT INTO sync_receipt
             (receipt_id, record_uuid, organization_id, resource_type, version_no,
              source_system, source_installation_id, manifest_checksum, receipt_status,
              received_at)
           VALUES (?, ?, ?, 'REPAIR', 1, 'CLOUD', ?, ?, 'SUCCEEDED', CURRENT_TIMESTAMP(3))`,
          [randomUUID(), `g2-receipt-r-${runTag}`, orgId, randomUUID(), 'c'.repeat(64)],
        );
      });
    });

    it('冲突确认人：已确认状态无 confirmed_by_account_id 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const snapshot = JSON.stringify({ schema_version: 1, tag: runTag });
        await expectRejectedWith(
          () =>
            m.query(
              `INSERT INTO sync_conflict
                 (conflict_id, record_uuid, organization_id, resource_type, version_no,
                  local_snapshot, cloud_snapshot, conflict_reason, status)
               VALUES (?, ?, ?, 'REPAIR', 1, ?, ?, 'G2 冲突', 'RESOLVED')`,
              [randomUUID(), `g2-conflict-c-${runTag}`, orgId, snapshot, snapshot],
            ),
          CHECK_VIOLATED,
          'chk_sync_conflict_confirmed',
        );
      });
    });

    it('备份云回执：cloud_status=SUCCEEDED 无 cloud_receipt 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        const runId = await insertBackupRun(m, installationId);
        await expectRejectedWith(
          () => insertBackupAsset(m, runId, { cloudStatus: 'SUCCEEDED' }),
          CHECK_VIOLATED,
          'chk_backup_asset_cloud_receipt',
        );
      });
    });

    it('恢复保护备份：protection_backup_id 等于 backup_id 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        const runId = await insertBackupRun(m, installationId);
        // 合法基础：两个不同的备份存在，仅把 protection 写成与被保护对象相同。
        const backupId = await insertBackupAsset(m, runId);
        await insertBackupAsset(m, runId);
        await expectRejectedWith(
          () => insertRestoreRun(m, backupId, backupId),
          CHECK_VIOLATED,
          'chk_backup_restore_run_protection',
        );
      });
    });

    it('备份运行结束时间：RUNNING 带 finished_at 或非 RUNNING 无 finished_at 被 ER_CHECK_CONSTRAINT 拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const installationId = await insertInstallationIfMissing(m);
        await expectRejectedWith(
          () => insertBackupRun(m, installationId, { finishedAt: '2026-01-01 00:00:00' }),
          CHECK_VIOLATED,
          'chk_local_backup_run_finish（RUNNING 带 finished_at）',
        );
        await expectRejectedWith(
          () => insertBackupRun(m, installationId, { status: 'SUCCEEDED' }),
          CHECK_VIOLATED,
          'chk_local_backup_run_finish（非 RUNNING 缺 finished_at）',
        );
      });
    });
  });

  // =========================================================================
  // 2.4 JSON 快照版本契约（定向回归）
  // 依据：S1 §4.2（repair_request_revision 的 JSON 内 schema_version 必须与
  // 独立列同值；reference_document_revision 无独立列，JSON 内须有格式版本，
  // OI-02 裁决读写两侧拒绝未知版本）。
  // 每例先构造其他字段全合法的基础输入，仅修改被测条件。
  // =========================================================================
  describe('2.4 JSON 快照版本契约', () => {
    const withVersion = (schemaVersion: unknown): string =>
      JSON.stringify({ schema_version: schemaVersion, tag: runTag });

    describe('repair_request_revision', () => {
      it('合法版本：before/after 与独立列同为 1，写入成功', async () => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          const revisionId = await insertRepairRevision(m, requestId, {
            before: withVersion(1),
            after: withVersion(1),
          });
          expect(revisionId).toBeGreaterThan(0);
        });
      });

      it('缺少 schema_version：两侧 JSON 均缺键，被 chk_repair_request_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          await expectRejectedWith(
            () =>
              insertRepairRevision(m, requestId, {
                before: JSON.stringify({ tag: runTag }),
                after: JSON.stringify({ tag: runTag }),
              }),
            CHECK_VIOLATED,
            'chk_repair_request_revision_schema（缺 schema_version）',
          );
        });
      });

      it('schema_version 为 JSON null：被 chk_repair_request_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          await expectRejectedWith(
            () =>
              insertRepairRevision(m, requestId, {
                before: withVersion(null),
                after: withVersion(null),
              }),
            CHECK_VIOLATED,
            'chk_repair_request_revision_schema（JSON null）',
          );
        });
      });

      it('版本类型错误：JSON 字符串 "1" 被 chk_repair_request_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          await expectRejectedWith(
            () =>
              insertRepairRevision(m, requestId, {
                before: withVersion('1'),
                after: withVersion('1'),
              }),
            CHECK_VIOLATED,
            'chk_repair_request_revision_schema（类型错误）',
          );
        });
      });

      it('与独立版本列不等：before 或 after 与列值不一致均被拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          await expectRejectedWith(
            () =>
              insertRepairRevision(
                m,
                requestId,
                { before: withVersion(2), after: withVersion(1) },
                1,
              ),
            CHECK_VIOLATED,
            'chk_repair_request_revision_schema（before 与列值不一致）',
          );
          await expectRejectedWith(
            () =>
              insertRepairRevision(
                m,
                requestId,
                { before: withVersion(1), after: withVersion(2) },
                1,
              ),
            CHECK_VIOLATED,
            'chk_repair_request_revision_schema（after 与列值不一致）',
          );
        });
      });
    });

    describe('reference_document_revision', () => {
      it('合法版本：before/after 均含 schema_version=1，写入成功', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          const revisionId = await insertDocumentRevision(m, documentId, {
            before: withVersion(1),
            after: withVersion(1),
          });
          expect(revisionId).toBeGreaterThan(0);
        });
      });

      it('缺少 schema_version：两侧 JSON 均缺键，被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: JSON.stringify({ tag: runTag }),
                after: JSON.stringify({ tag: runTag }),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（缺 schema_version）',
          );
        });
      });

      it('schema_version 为 JSON null：被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: withVersion(null),
                after: withVersion(null),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（JSON null）',
          );
        });
      });

      it('仅 before 缺 schema_version：after 合法，仍被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: JSON.stringify({ tag: runTag }),
                after: withVersion(1),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（before 缺 schema_version）',
          );
        });
      });

      it('仅 after 缺 schema_version：before 合法，仍被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: withVersion(1),
                after: JSON.stringify({ tag: runTag }),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（after 缺 schema_version）',
          );
        });
      });

      it('仅 before 为 JSON null：after 合法，仍被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: withVersion(null),
                after: withVersion(1),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（before JSON null）',
          );
        });
      });

      it('仅 after 为 JSON null：before 合法，仍被 chk_reference_document_revision_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          const documentId = await insertDocument(m);
          await expectRejectedWith(
            () =>
              insertDocumentRevision(m, documentId, {
                before: withVersion(1),
                after: withVersion(null),
              }),
            CHECK_VIOLATED,
            'chk_reference_document_revision_schema（after JSON null）',
          );
        });
      });
    });

    describe('repair_request_revision 单侧缺键 / JSON null', () => {
      const expectRepairRejected = async (
        before: string,
        after: string,
        label: string,
      ): Promise<void> => {
        await withRolledBackTransaction(async (m) => {
          const requestId = await insertRepairRequest(m);
          await expectRejectedWith(
            () => insertRepairRevision(m, requestId, { before, after }),
            CHECK_VIOLATED,
            label,
          );
        });
      };

      it('仅 before 缺 schema_version：after 合法，仍被拒绝', async () => {
        await expectRepairRejected(
          JSON.stringify({ tag: runTag }),
          withVersion(1),
          'chk_repair_request_revision_schema（before 缺 schema_version）',
        );
      });

      it('仅 after 缺 schema_version：before 合法，仍被拒绝', async () => {
        await expectRepairRejected(
          withVersion(1),
          JSON.stringify({ tag: runTag }),
          'chk_repair_request_revision_schema（after 缺 schema_version）',
        );
      });

      it('仅 before 为 JSON null：after 合法，仍被拒绝', async () => {
        await expectRepairRejected(
          withVersion(null),
          withVersion(1),
          'chk_repair_request_revision_schema（before JSON null）',
        );
      });

      it('仅 after 为 JSON null：before 合法，仍被拒绝', async () => {
        await expectRepairRejected(
          withVersion(1),
          withVersion(null),
          'chk_repair_request_revision_schema（after JSON null）',
        );
      });
    });

    describe('sync_conflict', () => {
      const insertSyncConflict = async (
        m: EntityManager,
        local: string,
        cloud: string,
      ): Promise<void> => {
        await m.query(
          `INSERT INTO sync_conflict
             (conflict_id, record_uuid, organization_id, resource_type, version_no,
              local_snapshot, cloud_snapshot, conflict_reason, status)
           VALUES (?, ?, ?, 'REPAIR', 1, ?, ?, 'G2 冲突', 'PENDING')`,
          [randomUUID(), randomUUID(), orgId, local, cloud],
        );
      };

      it('合法版本：local/cloud 均含 schema_version=1，写入成功', async () => {
        await withRolledBackTransaction(async (m) => {
          await insertSyncConflict(m, withVersion(1), withVersion(1));
        });
      });

      it('仅 local 缺 schema_version：cloud 合法，被 chk_sync_conflict_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertSyncConflict(m, JSON.stringify({ tag: runTag }), withVersion(1)),
            CHECK_VIOLATED,
            'chk_sync_conflict_schema（local 缺 schema_version）',
          );
        });
      });

      it('仅 cloud 缺 schema_version：local 合法，被 chk_sync_conflict_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertSyncConflict(m, withVersion(1), JSON.stringify({ tag: runTag })),
            CHECK_VIOLATED,
            'chk_sync_conflict_schema（cloud 缺 schema_version）',
          );
        });
      });

      it('仅 local 为 JSON null：cloud 合法，被 chk_sync_conflict_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertSyncConflict(m, withVersion(null), withVersion(1)),
            CHECK_VIOLATED,
            'chk_sync_conflict_schema（local JSON null）',
          );
        });
      });

      it('仅 cloud 为 JSON null：local 合法，被 chk_sync_conflict_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertSyncConflict(m, withVersion(1), withVersion(null)),
            CHECK_VIOLATED,
            'chk_sync_conflict_schema（cloud JSON null）',
          );
        });
      });
    });

    describe('backup_restore_run', () => {
      const insertRestoreWithSnapshot = async (
        m: EntityManager,
        snapshot: string,
      ): Promise<void> => {
        const installationId = await insertInstallationIfMissing(m);
        const runId = await insertBackupRun(m, installationId);
        const backupId = await insertBackupAsset(m, runId);
        const protectionBackupId = await insertBackupAsset(m, runId);
        await m.query(
          `INSERT INTO backup_restore_run
             (restore_id, backup_id, protection_backup_id, target_installation_id,
              check_status, confirmation, organization_id, started_by_account_id,
              status, check_snapshot, started_at)
           VALUES (?, ?, ?, ?, 'PASSED', ?, ?, ?, 'RUNNING', ?, CURRENT_TIMESTAMP(3))`,
          [
            randomUUID(),
            backupId,
            protectionBackupId,
            installationId,
            JSON.stringify({ confirmed: true }),
            orgId,
            engineerAccountId,
            snapshot,
          ],
        );
      };

      it('合法版本：check_snapshot 含 schema_version=1，写入成功', async () => {
        await withRolledBackTransaction(async (m) => {
          await insertRestoreWithSnapshot(m, withVersion(1));
        });
      });

      it('缺少 schema_version：被 chk_backup_restore_run_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertRestoreWithSnapshot(m, JSON.stringify({ tag: runTag })),
            CHECK_VIOLATED,
            'chk_backup_restore_run_schema（缺 schema_version）',
          );
        });
      });

      it('schema_version 为 JSON null：被 chk_backup_restore_run_schema 拒绝', async () => {
        await withRolledBackTransaction(async (m) => {
          await expectRejectedWith(
            () => insertRestoreWithSnapshot(m, withVersion(null)),
            CHECK_VIOLATED,
            'chk_backup_restore_run_schema（JSON null）',
          );
        });
      });
    });
  });

  // =========================================================================
  // 2.5 记录包检查/导入状态（第 39 条迁移）
  // 检查阶段（check_status/check_result）与导入阶段（status/result）可分别表达，
  // 数据库只负责可证组合；包身份去重依赖 package_id 主键与条目四元组唯一键。
  // =========================================================================
  describe('2.5 记录包检查/导入状态', () => {
    const insertPackage = async (
      m: EntityManager,
      options: {
        readonly status: string;
        readonly checkStatus?: string | null;
        readonly manifest?: string;
      },
    ): Promise<string> => {
      const packageId = randomUUID();
      await m.query(
        `INSERT INTO record_package_import
           (package_id, organization_id, imported_by_account_id, manifest_checksum,
            manifest_json, status, check_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          packageId,
          orgId,
          engineerAccountId,
          'd'.repeat(64),
          options.manifest ?? JSON.stringify({ schema_version: 1, tag: runTag }),
          options.status,
          options.checkStatus ?? null,
        ],
      );
      return packageId;
    };

    const insertItem = async (
      m: EntityManager,
      packageId: string,
      options: {
        readonly result: string | null;
        readonly checkResult?: string | null;
        readonly errorMessage?: string | null;
      },
    ): Promise<void> => {
      await m.query(
        `INSERT INTO record_package_item
           (package_id, record_uuid, resource_type, version_no,
            result, check_result, error_message)
         VALUES (?, ?, 'REPAIR', 1, ?, ?, ?)`,
        [
          packageId,
          randomUUID(),
          options.result,
          options.checkResult ?? null,
          options.errorMessage ?? null,
        ],
      );
    };

    it('检查通过但尚未导入：check_status=PASSED 且 status=PENDING 允许写入（正向）', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'PENDING', checkStatus: 'PASSED' });
        const rows = await m.query<unknown[]>(
          `SELECT check_status, status FROM record_package_import WHERE package_id = ?`,
          [packageId],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('检查拒绝：REJECTED 仅允许停留在 PENDING，不能标记任何导入阶段', async () => {
      await withRolledBackTransaction(async (m) => {
        await insertPackage(m, { status: 'PENDING', checkStatus: 'REJECTED' });
        for (const status of ['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']) {
          await expectRejectedWith(
            () => insertPackage(m, { status, checkStatus: 'REJECTED' }),
            CHECK_VIOLATED,
            'chk_record_package_import_check_stage',
          );
        }
      });
    });

    it('检查未完成（PENDING）：不能开始导入，status 必须保持 PENDING', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertPackage(m, { status: 'RUNNING', checkStatus: 'PENDING' }),
          CHECK_VIOLATED,
          'chk_record_package_import_check_stage',
        );
      });
    });

    it('历史未判定（check_status=NULL）：只允许 PENDING/FAILED，不能表示导入成功', async () => {
      await withRolledBackTransaction(async (m) => {
        await insertPackage(m, { status: 'FAILED', checkStatus: null });
        for (const status of ['RUNNING', 'SUCCEEDED', 'PARTIAL']) {
          await expectRejectedWith(
            () => insertPackage(m, { status, checkStatus: null }),
            CHECK_VIOLATED,
            'chk_record_package_import_check_stage',
          );
        }
      });
    });

    it('非法包检查枚举：check_status=UNKNOWN 被域约束拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await expectRejectedWith(
          () => insertPackage(m, { status: 'PENDING', checkStatus: 'UNKNOWN' }),
          CHECK_VIOLATED,
          'chk_record_package_import_check_status',
        );
      });
    });

    it('manifest 版本键：合法写入成功，缺键与 JSON null 均被拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        await insertPackage(m, {
          status: 'PENDING',
          manifest: JSON.stringify({ schema_version: 1, tag: runTag }),
        });
        await expectRejectedWith(
          () =>
            insertPackage(m, {
              status: 'PENDING',
              manifest: JSON.stringify({ tag: runTag }),
            }),
          CHECK_VIOLATED,
          'chk_record_package_import_manifest（缺 schema_version）',
        );
        await expectRejectedWith(
          () =>
            insertPackage(m, {
              status: 'PENDING',
              manifest: JSON.stringify({ schema_version: null, tag: runTag }),
            }),
          CHECK_VIOLATED,
          'chk_record_package_import_manifest（JSON null）',
        );
      });
    });

    it('同包重试：复用 package_id 的第二次插入被主键拒绝，不能生成新编号绕过去重', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = randomUUID();
        const insertWithId = (): Promise<unknown> =>
          m.query(
            `INSERT INTO record_package_import
               (package_id, organization_id, imported_by_account_id, manifest_checksum,
                manifest_json, status, check_status)
             VALUES (?, ?, ?, ?, ?, 'PENDING', NULL)`,
            [
              packageId,
              orgId,
              engineerAccountId,
              'd'.repeat(64),
              JSON.stringify({ schema_version: 1, tag: runTag }),
            ],
          );
        await insertWithId();
        await expectRejectedWith(insertWithId, DUP_ENTRY, '记录包 package_id 主键重试唯一');
      });
    });

    it('条目未执行：result 与 check_result 均为空允许写入（正向）', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'PENDING', checkStatus: 'PASSED' });
        await insertItem(m, packageId, { result: null, checkResult: null });
      });
    });

    it('条目四类导入结果：成功需检查通过，跳过/冲突/失败可在历史未判定下保留', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'RUNNING', checkStatus: 'PASSED' });
        await insertItem(m, packageId, { result: 'SUCCEEDED', checkResult: 'PASSED' });
        await insertItem(m, packageId, { result: 'SKIPPED', checkResult: null });
        await insertItem(m, packageId, { result: 'CONFLICT', checkResult: null });
        await insertItem(m, packageId, {
          result: 'FAILED',
          checkResult: 'PASSED',
          errorMessage: `${runTag} 导入失败`,
        });
      });
    });

    it('条目成功但检查未通过：result=SUCCEEDED 且 check_result 为空被组合约束拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'RUNNING', checkStatus: 'PASSED' });
        await expectRejectedWith(
          () => insertItem(m, packageId, { result: 'SUCCEEDED', checkResult: null }),
          CHECK_VIOLATED,
          'chk_record_package_item_check_stage',
        );
      });
    });

    it('条目检查拒绝：check_result=REJECTED 只允许 result 为空', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'RUNNING', checkStatus: 'PASSED' });
        await insertItem(m, packageId, { result: null, checkResult: 'REJECTED' });
        for (const result of ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CONFLICT']) {
          await expectRejectedWith(
            () =>
              insertItem(m, packageId, {
                result,
                checkResult: 'REJECTED',
                // FAILED 另有“失败原因必填”约束；补齐后仅目标组合约束成立。
                errorMessage: `${runTag} 检查拒绝`,
              }),
            CHECK_VIOLATED,
            'chk_record_package_item_check_stage',
          );
        }
      });
    });

    it('非法条目枚举：result=PENDING 与 check_result=UNKNOWN 均被域约束拒绝', async () => {
      await withRolledBackTransaction(async (m) => {
        const packageId = await insertPackage(m, { status: 'RUNNING', checkStatus: 'PASSED' });
        await expectRejectedWith(
          () => insertItem(m, packageId, { result: 'PENDING', checkResult: 'PASSED' }),
          CHECK_VIOLATED,
          'chk_record_package_item_result',
        );
        await expectRejectedWith(
          () => insertItem(m, packageId, { result: null, checkResult: 'UNKNOWN' }),
          CHECK_VIOLATED,
          'chk_record_package_item_check_result',
        );
      });
    });
  });

  // =========================================================================
  // 3. 事务原子性（S2 §3，5 项全覆盖）
  // 全部为“前序写入成功、后序失败”模式：第一条写入故意成功，
  // 再证明失败后前序写入整体回滚。绝不用“第一条即失败”冒充原子性证明。
  // =========================================================================
  describe('3. 事务原子性', () => {
    it('一次提交原子性：报告头成功后步骤失败，回滚后无头/无步骤/无提交请求号残留', async () => {
      const submissionRequestId = `g2-tx-report-${runTag}`;
      await expectTransactionRejected(
        () =>
          dataSource.transaction(async (m) => {
            const reportId = await insertReport(m, {
              submissionRequestId,
              submissionPayloadHash: 't'.repeat(64),
            });
            await insertReportStep(m, reportId, 1, 'STEP_1');
            // 后序失败：同一步骤编码第二次写入触发唯一键。
            await insertReportStep(m, reportId, 2, 'STEP_1');
          }),
        DUP_ENTRY,
        '一次提交原子性',
      );

      const manager = dataSource.createEntityManager();
      const heads = await manager.query<unknown[]>(
        `SELECT id FROM maintenance_report WHERE submission_request_id = ?`,
        [submissionRequestId],
      );
      expect(heads).toHaveLength(0);
      const steps = await manager.query<unknown[]>(
        `SELECT s.id FROM maintenance_report_step s
          JOIN maintenance_report r ON r.id = s.report_id
         WHERE r.submission_request_id = ?`,
        [submissionRequestId],
      );
      expect(steps).toHaveLength(0);
    });

    it('转单原子性：repair_request 成功后回写 intake 失败，两侧均回滚且 intake 仍未转单', async () => {
      // 提交的父夹具：intake 必须在事务外可见，登记台账由 afterEach 精确回收。
      const manager = dataSource.createEntityManager();
      const recordUuid = `g2-tx-convert-${runTag}`;
      const intakeId = await insertIntake(manager, { recordUuid });
      registerCommittedIntake(intakeId, recordUuid);

      const requestNo = `G2-REQ-${runTag}-tx-convert`;
      await expectTransactionRejected(
        () =>
          dataSource.transaction(async (m) => {
            // 前序写入成功：插入 repair_request。
            await insertRepairRequest(m, { requestNo, intakeId });
            // 回写 intake.converted_request_id 成功。
            await m.query(
              `UPDATE repair_request_intake SET converted_request_id = LAST_INSERT_ID() WHERE id = ?`,
              [intakeId],
            );
            // 后序失败：CLOSED 但 closed_at 为空，违反 chk_repair_request_closure。
            // （原先用 current_revision_no=-1，实际被 unsigned 列类型域拒绝（1264），
            //  不是 CHECK；这里改用真实可达的 CHECK 违规，命题不变。）
            await m.query(
              `UPDATE repair_request SET closure_status = 'CLOSED' WHERE request_no = ?`,
              [requestNo],
            );
          }),
        CHECK_VIOLATED,
        '转单原子性',
      );

      // 两侧均回滚：request 不存在，intake 仍未转单。
      const requests = await manager.query<unknown[]>(
        `SELECT id FROM repair_request WHERE request_no = ?`,
        [requestNo],
      );
      expect(requests).toHaveLength(0);
      const intakes = await manager.query<{ converted_request_id: unknown }[]>(
        `SELECT converted_request_id FROM repair_request_intake WHERE id = ?`,
        [intakeId],
      );
      expect(intakes[0].converted_request_id).toBeNull();
    });

    it('分析重试原子推进：并发推进仅一次成功，失败方收到冲突且不产生第三条尝试记录', async () => {
      const manager = dataSource.createEntityManager();
      const recordUuid = `g2-tx-retry-${runTag}`;
      const intakeId = await insertIntake(manager, { recordUuid });
      registerCommittedIntake(intakeId, recordUuid);

      // 第一次推进成功并提交；成功产生的 attempt 登记台账。
      const attemptId = await dataSource.transaction(async (m) => {
        const advanced = await m.query<{ affectedRows?: number }>(
          `UPDATE repair_request_intake SET analysis_generation = 1
            WHERE id = ? AND analysis_generation = 0`,
          [intakeId],
        );
        if ((advanced.affectedRows ?? 0) !== 1) {
          throw new Error('首次推进应成功');
        }
        return insertAttempt(m, intakeId, 1, { status: 'RUNNING' });
      });
      recordOwnedResource(testLedger, 'intakeAnalysisAttempt', attemptId, {
        intakeId,
        generationNo: 1,
      });

      // 第二次推进：乐观锁条件不命中，且唯一键拒绝同代次写入。
      await expect(
        dataSource.transaction(async (m) => {
          const advanced = await m.query<{ affectedRows?: number }>(
            `UPDATE repair_request_intake SET analysis_generation = 1
              WHERE id = ? AND analysis_generation = 0`,
            [intakeId],
          );
          if ((advanced.affectedRows ?? 0) !== 1) {
            throw new Error('并发推进冲突：analysis_generation 已被推进');
          }
          await insertAttempt(m, intakeId, 1, { status: 'RUNNING' });
        }),
      ).rejects.toThrow(/并发推进冲突|ER_DUP_ENTRY/);

      // 数据状态：代数停在 1，且只有一条 generation_no=1 的尝试记录。
      const attempts = await manager.query<unknown[]>(
        `SELECT id FROM intake_analysis_attempt WHERE intake_id = ? AND generation_no = 1`,
        [intakeId],
      );
      expect(attempts).toHaveLength(1);
      const intakes = await manager.query<{ analysis_generation: number }[]>(
        `SELECT analysis_generation FROM repair_request_intake WHERE id = ?`,
        [intakeId],
      );
      expect(Number(intakes[0].analysis_generation)).toBe(1);
    });

    it('修订追加原子性：中断后 current_revision_no 不超前于最大 revision_no', async () => {
      const manager = dataSource.createEntityManager();
      const requestNo = `G2-REQ-${runTag}-tx-revision`;
      const requestId = await insertRepairRequest(manager, { requestNo });
      registerCommittedRepairRequest(requestId, requestNo);

      // 第一次追加成功：revision_no=1 且 current_revision_no=1。
      const snapshot = JSON.stringify({ schema_version: 1, tag: runTag });
      let committedRevisionId = 0;
      await dataSource.transaction(async (m) => {
        const revisionResult = await m.query(
          `INSERT INTO repair_request_revision
             (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
              schema_version, reason)
           VALUES (?, 1, ?, ?, ?, 1, 'G2 首次修订')`,
          [requestId, snapshot, snapshot, engineerAccountId],
        );
        committedRevisionId = insertIdOf(revisionResult);
        await m.query(`UPDATE repair_request SET current_revision_no = 1 WHERE id = ?`, [
          requestId,
        ]);
      });
      // 提交成功后立即登记（含子行自身归属事实），供套件台账精确回收。
      registerCommittedRepairRequestRevision(committedRevisionId, requestId, 1, 1);

      // 第二次追加：快照写入成功后推进失败（同一 revision_no 唯一键冲突）。
      await expectTransactionRejected(
        () =>
          dataSource.transaction(async (m) => {
            await m.query(
              `INSERT INTO repair_request_revision
                 (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
                  schema_version, reason)
               VALUES (?, 2, ?, ?, ?, 1, 'G2 二次修订')`,
              [requestId, snapshot, snapshot, engineerAccountId],
            );
            // 后序失败：错误地再次写入 revision_no=2。
            await m.query(
              `INSERT INTO repair_request_revision
                 (request_id, revision_no, before_snapshot, after_snapshot, actor_account_id,
                  schema_version, reason)
               VALUES (?, 2, ?, ?, ?, 1, 'G2 二次修订重复')`,
              [requestId, snapshot, snapshot, engineerAccountId],
            );
          }),
        DUP_ENTRY,
        '修订追加原子性',
      );

      const revisions = await manager.query<{ max_no: number }[]>(
        `SELECT MAX(revision_no) AS max_no FROM repair_request_revision WHERE request_id = ?`,
        [requestId],
      );
      expect(Number(revisions[0].max_no)).toBe(1);
      const requests = await manager.query<{ current_revision_no: number }[]>(
        `SELECT current_revision_no FROM repair_request WHERE id = ?`,
        [requestId],
      );
      expect(Number(requests[0].current_revision_no)).toBe(1);
    });

    it('管理员映射原子性：映射含不存在的公司编码则整批回滚，不部分创建账号', async () => {
      const loginName = `g2_admin_map_${runTag}`;
      // 不存在的公司（编码解析失败在 SQL 层以非法 FK 模拟）。
      // 用正数且远超真实自增的值：-1 会先触发公司侧约束/类型语义，掩盖目标 FK 命题。
      const membershipOrgId = 2147483000;
      // member_role 合法域为 SUPER_ADMIN/ENGINEER/CUSTOMER（'ADMIN' 会先触发 chk_role）。
      const memberRole = 'CUSTOMER';
      await expectTransactionRejected(
        () =>
          dataSource.transaction(async (m) => {
            // 前序写入成功：创建账号与 user_info。
            const accountResult = await m.query(
              `INSERT INTO base_user_account (login_name, login_email, login_password, status, identity_hint)
               VALUES (?, ?, 'x', 'ACTIVE', 'ADMIN')`,
              [loginName, `${loginName}@example.com`],
            );
            const accountId = insertIdOf(accountResult);
            await m.query(
              `INSERT INTO base_user_info (account_id, nickname, email, access_group, meta_digest, user_state)
               VALUES (?, ?, ?, '["ADMIN"]', '["ADMIN"]', 'ACTIVE')`,
              [accountId, `${loginName}_nickname`, `${loginName}@example.com`],
            );
            // 后序失败：映射到不存在的公司（外键拒绝）。
            await m.query(
              `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
               VALUES (?, ?, ?, 'ACTIVE')`,
              [membershipOrgId, accountId, memberRole],
            );
          }),
        withConstraint(NO_REFERENCED_ROW, 'fk_organization_membership_organization'),
        '管理员映射原子性',
      );

      // 整批回滚：账号与 user_info 均无残留。
      const manager = dataSource.createEntityManager();
      const accounts = await manager.query<unknown[]>(
        `SELECT id FROM base_user_account WHERE login_name = ?`,
        [loginName],
      );
      expect(accounts).toHaveLength(0);
      const infos = await manager.query<unknown[]>(
        `SELECT ui.id FROM base_user_info ui
          JOIN base_user_account a ON a.id = ui.account_id
         WHERE a.login_name = ?`,
        [loginName],
      );
      expect(infos).toHaveLength(0);
    });
  });
});

// =========================================================================
// 装配回归（离线）：只构建实体元数据，不 initialize，因此不建立任何连接。
// 目的：在实库授权之前证明夹具使用的仓储实体、关系与字符串外键都能解析。
// =========================================================================

/** 仅构建元数据的 DataSource 子类：buildMetadatas 为 protected，不调用 initialize。 */
class MetadataOnlyDataSource extends DataSource {
  async buildMetadataOnly(): Promise<void> {
    await this.buildMetadatas();
  }
}

describe('G-2 实库规格 DataSource 装配（离线元数据，不连接数据库）', () => {
  let metadataSource: MetadataOnlyDataSource;

  beforeAll(async () => {
    metadataSource = new MetadataOnlyDataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'metadata_only',
      password: 'metadata_only',
      database: 'metadata_only_not_connected',
      synchronize: false,
      migrationsRun: false,
      entities: [...ACCOUNT_WRITE_FIXTURE_ENTITIES],
    });
    await metadataSource.buildMetadataOnly();
  });

  it('夹具使用的实体全部具备元数据，且未开启自动同步/自动迁移/自动 Seed', () => {
    expect(metadataSource.isInitialized).toBe(false);
    // 最小装配：只注册 createTestAccount 实际使用的三张表。
    expect(metadataSource.entityMetadatas.map((metadata) => metadata.tableName).sort()).toEqual([
      'base_user_account',
      'base_user_info',
      'organization',
    ]);
    const options = metadataSource.options as { synchronize?: boolean; migrationsRun?: boolean };
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
  });

  it('createTestAccount 的仓储实体、关联目标与字符串外键均可解析', () => {
    const account = metadataSource.getMetadata('base_user_account');
    const userInfo = metadataSource.getMetadata('base_user_info');
    const organization = metadataSource.getMetadata('organization');

    // 仓储 save/update 依赖的真实列。
    expect(account.columns.map((column) => column.propertyName)).toEqual(
      expect.arrayContaining([
        'id',
        'loginName',
        'loginEmail',
        'loginPassword',
        'status',
        'identityHint',
        'createdAt',
      ]),
    );
    expect(userInfo.columns.map((column) => column.propertyName)).toEqual(
      expect.arrayContaining([
        'accountId',
        'nickname',
        'email',
        'accessGroup',
        'metaDigest',
        'userState',
      ]),
    );

    // AccountEntity.userInfo -> UserInfoEntity（反向一对一）。
    const accountRelation = account.relations.find(
      (relation) => relation.propertyName === 'userInfo',
    );
    expect(accountRelation?.inverseEntityMetadata.tableName).toBe('base_user_info');

    // UserInfoEntity.account -> AccountEntity（拥有 JoinColumn account_id）。
    const userInfoRelation = userInfo.relations.find(
      (relation) => relation.propertyName === 'account',
    );
    expect(userInfoRelation?.inverseEntityMetadata.tableName).toBe('base_user_account');

    // base_user_info.customer_organization_id 的字符串外键必须解析到 organization。
    const organizationForeignKeys = userInfo.foreignKeys.filter(
      (foreignKey) => foreignKey.referencedEntityMetadata.tableName === 'organization',
    );
    expect(organizationForeignKeys).toHaveLength(1);
    expect(organizationForeignKeys[0].columns.map((column) => column.databaseName)).toEqual([
      'customer_organization_id',
    ]);

    // 全部关系与外键目标都在已注册集合内（无悬挂引用）。
    const registeredTables = new Set(
      metadataSource.entityMetadatas.map((metadata) => metadata.tableName),
    );
    for (const metadata of metadataSource.entityMetadatas) {
      for (const relation of metadata.relations) {
        expect(registeredTables.has(relation.inverseEntityMetadata.tableName)).toBe(true);
      }
      for (const foreignKey of metadata.foreignKeys) {
        expect(registeredTables.has(foreignKey.referencedEntityMetadata.tableName)).toBe(true);
      }
    }
    expect(organization.tableName).toBe('organization');
  });
});
