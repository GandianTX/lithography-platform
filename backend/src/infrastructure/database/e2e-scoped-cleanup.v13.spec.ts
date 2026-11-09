// src/infrastructure/database/e2e-scoped-cleanup.v13.spec.ts
//
// G-3 新增 17 表清理闭包的纯替身回归测试。
// 不连接实库、不启动服务、不操作 Redis；全部用表/列感知的 mock EntityManager 验证：
// - 17 个新类别全部为事实承载：登记必须带不可变归属事实，缺事实在事务开启前拒绝；
// - 主键/父列名与迁移逐表核对（静态契约 + 运行时 SQL 断言）；
// - R01：父行在本轮范围但子行未登记 → 拒绝且 DELETE=0（父关系不证明所有权）；
// - R02：登记事实漂移 → 第一条 DELETE 前拒绝；
// - 合法删除顺序（restore_run 先于 backup_asset、stored_file 最后、intake↔request 解环）；
// - 删除中途失败整批回滚、行已回收幂等跳过、重复清理 no-op。
//
// 替身纪律：SELECT 按“表 + WHERE 列”感知，未知表或未知列立即抛错，
// 绝不对任意 SELECT 统一返回空，避免掩盖字段或闭包错误。
//
// 运行：npm run test:unit -- e2e-scoped-cleanup.v13

jest.mock('../../../test/utils/e2e-db-guard', () => ({
  assertPhysicalCleanupConsent: jest.fn(),
  assertDataSourceOnAllowedE2eDatabase: jest.fn(() => Promise.resolve('lithography_e2e')),
  assertManagerOnExpectedE2eDatabase: jest.fn(() => Promise.resolve('lithography_e2e')),
  resolveExpectedE2eDatabase: jest.fn(() => 'lithography_e2e'),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createOwnedResourceLedger,
  recordOwnedResource,
  mergeOwnedResourceLedger,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../../../test/utils/e2e-scoped-cleanup';
import type { DataSource, EntityManager } from 'typeorm';

const V13_CATEGORIES = [
  'storedFile',
  'repairRequestIntake',
  'intakeAnalysisAttempt',
  'repairProcessEntry',
  'aiMessageAnalysis',
  'maintenanceReportFault',
  'repairRequestRevision',
  'referenceDocumentRevision',
  'localAccountAuthorization',
  'localCompanySetting',
  'syncReceipt',
  'syncConflict',
  'recordPackageImport',
  'recordPackageItem',
  'backupAsset',
  'backupRestoreRun',
  'managementAuditEvent',
] as const;

type V13Category = (typeof V13_CATEGORIES)[number];

/** char(36) 主键类别（与迁移一致）。 */
const STRING_PK_CATEGORIES = [
  'storedFile',
  'aiMessageAnalysis',
  'syncReceipt',
  'syncConflict',
  'recordPackageImport',
  'backupAsset',
  'backupRestoreRun',
  'managementAuditEvent',
] as const;

/** 各类别的合法最小事实夹具（对应不可变归属字段）。 */
const V13_FACT_FIXTURES: Record<V13Category, () => Record<string, unknown>> = {
  storedFile: () => ({
    uploadedByAccountId: 200,
    ownerOrganizationId: 100,
    storageReference: 'oss://bucket/file-1',
    originalFilename: 'a.txt',
    checksumSha256: 'c'.repeat(64),
    uploadContextId: 'ctx-1',
  }),
  repairRequestIntake: () => ({
    recordUuid: 'uuid-intake-1',
    customerAccountId: 200,
    customerOrganizationId: 100,
    serviceOrganizationId: 100,
    equipmentModelId: 300,
    errorCode: 'E001',
    faultDescription: '故障描述',
    fileId: null,
  }),
  intakeAnalysisAttempt: () => ({ intakeId: 5001, generationNo: 0 }),
  repairProcessEntry: () => ({
    entryUuid: 'uuid-entry-1',
    requestId: 9001,
    authorAccountId: 200,
    fileId: null,
  }),
  aiMessageAnalysis: () => ({
    conversationId: 8001,
    questionMessageId: 8002,
    answerMessageId: null,
  }),
  maintenanceReportFault: () => ({
    reportId: 7001,
    faultUuid: 'uuid-fault-1',
    branchKind: 'DEVICE',
    stepCode: null,
    lifecycleSource: 'SYSTEM',
  }),
  repairRequestRevision: () => ({
    requestId: 9001,
    revisionNo: 1,
    actorAccountId: 200,
    schemaVersion: 1,
  }),
  referenceDocumentRevision: () => ({
    documentId: 6001,
    revisionNo: 1,
    actorAccountId: 200,
  }),
  localAccountAuthorization: () => ({
    installationId: 'inst-1',
    accountId: 200,
    organizationId: 100,
  }),
  localCompanySetting: () => ({
    installationId: 'inst-1',
    organizationId: 100,
    settingSource: 'LOCAL_MANUAL',
  }),
  syncReceipt: () => ({
    recordUuid: 'uuid-receipt-1',
    organizationId: 100,
    resourceType: 'REPAIR',
    versionNo: 1,
    sourceSystem: 'CLOUD',
  }),
  syncConflict: () => ({
    recordUuid: 'uuid-conflict-1',
    organizationId: 100,
    resourceType: 'REPAIR',
    versionNo: 1,
  }),
  recordPackageImport: () => ({
    organizationId: 100,
    importedByAccountId: 200,
    manifestChecksum: 'm'.repeat(64),
  }),
  recordPackageItem: () => ({
    packageId: 'pkg-1',
    recordUuid: 'uuid-item-1',
    resourceType: 'REPAIR',
    versionNo: 1,
    receiptId: null,
  }),
  backupAsset: () => ({
    runId: 4001,
    organizationId: 100,
    storageReference: 'oss://bucket/backup-1',
    fileSha256: 'f'.repeat(64),
    localCleanupRunId: null,
  }),
  backupRestoreRun: () => ({
    backupId: 'ba-1',
    protectionBackupId: 'ba-2',
    organizationId: 100,
    startedByAccountId: 200,
  }),
  managementAuditEvent: () => ({
    actorAccountId: 200,
    organizationId: 100,
    operation: 'DELETE',
    targetType: 'REPAIR',
    targetId: '9001',
    result: 'SUCCESS',
  }),
};

/** 泛型登记入口（循环场景）；类型化调用请直接使用 recordOwnedResource。 */
type RecordAnyFn = (
  ledger: OwnedResourceLedger,
  category: string,
  id: number | string,
  facts?: Record<string, unknown>,
) => number | string;
const recordAny: RecordAnyFn = recordOwnedResource;

const asRecord = (ledger: OwnedResourceLedger): Record<string, unknown> =>
  ledger as unknown as Record<string, unknown>;

// =========================================================================
// 表/列感知替身：schema 之外或列名不符的 SELECT 一律抛错。
// =========================================================================

/** 清理器查询面涉及的全部表及其合法列（与迁移/实体一致）。 */
const CLEANER_SCHEMA: Record<string, readonly string[]> = {
  organization: ['id', 'organization_code', 'name', 'kind', 'status'],
  // base_user_account 与 base_user_info 的 LEFT JOIN 在替身侧预合并为一行。
  base_user_account: [
    'id',
    'login_name',
    'login_email',
    'status',
    'identity_hint',
    'user_info_id',
    'nickname',
    'user_info_email',
    'email',
    'access_group',
    'meta_digest',
    'user_state',
  ],
  organization_membership: ['id', 'organization_id', 'account_id', 'member_role', 'status'],
  equipment_model: ['id', 'model_code', 'model_name', 'enabled', 'sort_order'],
  base_third_party_auth: ['id', 'account_id', 'provider', 'provider_user_id', 'union_id'],
  base_verification_record: [
    'id',
    'type',
    'target_account_id',
    'subject_type',
    'subject_id',
    'issued_by_account_id',
    'consumed_by_account_id',
    'payload',
  ],
  repair_request: [
    'id',
    'request_no',
    'customer_account_id',
    'equipment_model_id',
    'accepted_by_account_id',
    'error_code',
    'fault_description',
    'content_md',
    'is_accepted',
    'accepted_by_engineer_account_id',
    'handling_recorded_by_account_id',
    'deprecated',
    'intake_id',
    'owner_organization_id',
  ],
  engineer_response: [
    'id',
    'request_id',
    'engineer_account_id',
    'customer_account_id',
    'resolution_status',
    'response_text',
  ],
  engineer_registration_application: [
    'id',
    'account_id',
    'organization_id',
    'status',
    'application_note',
    'review_comment',
    'reviewed_by_account_id',
  ],
  reference_document: [
    'id',
    'owner_organization_id',
    'created_by_account_id',
    'source_submission_id',
    'source_revision_id',
    'equipment_model_id',
    'updated_by_account_id',
    'source_report_id',
    'source_report_version_id',
  ],
  // V13 17 表（列名与迁移逐表核对）。
  stored_file: [
    'file_id',
    'uploaded_by_account_id',
    'owner_organization_id',
    'storage_reference',
    'original_filename',
    'checksum_sha256',
    'upload_context_id',
  ],
  repair_request_intake: [
    'id',
    'record_uuid',
    'customer_account_id',
    'customer_organization_id',
    'service_organization_id',
    'equipment_model_id',
    'error_code',
    'fault_description',
    'file_id',
    'converted_request_id',
  ],
  intake_analysis_attempt: ['id', 'intake_id', 'generation_no'],
  repair_process_entry: ['id', 'entry_uuid', 'request_id', 'author_account_id', 'file_id'],
  ai_message_analysis: [
    'question_uuid',
    'conversation_id',
    'question_message_id',
    'answer_message_id',
  ],
  maintenance_report_fault: [
    'id',
    'report_id',
    'fault_uuid',
    'branch_kind',
    'step_code',
    'lifecycle_source',
  ],
  repair_request_revision: [
    'id',
    'request_id',
    'revision_no',
    'actor_account_id',
    'schema_version',
  ],
  reference_document_revision: ['id', 'document_id', 'revision_no', 'actor_account_id'],
  local_account_authorization: ['id', 'installation_id', 'account_id', 'organization_id'],
  local_company_setting: ['id', 'installation_id', 'organization_id', 'setting_source'],
  sync_receipt: [
    'receipt_id',
    'record_uuid',
    'organization_id',
    'resource_type',
    'version_no',
    'source_system',
  ],
  sync_conflict: [
    'conflict_id',
    'record_uuid',
    'organization_id',
    'resource_type',
    'version_no',
    'confirmed_by_account_id',
  ],
  record_package_import: [
    'package_id',
    'organization_id',
    'imported_by_account_id',
    'manifest_checksum',
  ],
  record_package_item: [
    'id',
    'package_id',
    'record_uuid',
    'resource_type',
    'version_no',
    'receipt_id',
  ],
  backup_asset: [
    'backup_id',
    'run_id',
    'organization_id',
    'storage_reference',
    'file_sha256',
    'local_cleanup_run_id',
  ],
  backup_restore_run: [
    'restore_id',
    'backup_id',
    'protection_backup_id',
    'organization_id',
    'started_by_account_id',
  ],
  management_audit_event: [
    'event_id',
    'actor_account_id',
    'organization_id',
    'operation',
    'target_type',
    'target_id',
    'result',
  ],
  // 旧表入向引用闭包查询面。
  maintenance_report: [
    'id',
    'owner_organization_id',
    'created_by_account_id',
    'maintenance_engineer_account_id',
    'updated_by_account_id',
    'repair_request_id',
    'equipment_model_id',
  ],
  maintenance_report_version: ['id', 'report_id', 'submitted_by_account_id'],
  maintenance_report_review: ['id', 'report_id', 'reviewed_by_account_id'],
  maintenance_report_attachment: ['id', 'report_id', 'uploaded_by_account_id'],
  maintenance_report_step: ['id', 'report_id'],
  ai_conversation: ['id', 'engineer_account_id', 'request_id'],
  ai_report: ['id', 'engineer_account_id', 'request_id'],
  content_submission: ['id', 'owner_organization_id', 'submitted_by_account_id'],
  content_submission_revision: [
    'id',
    'owner_organization_id',
    'service_organization_id',
    'created_by_account_id',
    'confirmed_by_account_id',
    'attachment_id',
  ],
  content_submission_review: ['id', 'submission_id', 'reviewed_by_account_id'],
  content_submission_attachment: ['id', 'uploaded_by_account_id'],
  material_submission_detail: ['submission_id', 'equipment_model_id'],
  fault_case_submission_detail: ['submission_id', 'equipment_model_id'],
  reference_document_case_detail: ['id', 'document_id'],
  local_installation: ['id', 'organization_id'],
};

type FakeRow = Record<string, unknown>;

interface CapturedCalls {
  selectSql: string[];
  deleteStatements: string[];
  updateStatements: string[];
  commitMock: jest.Mock;
  rollbackMock: jest.Mock;
}

const lastSegment = (expr: string): string => {
  const cleaned = expr.trim().replace(/`/g, '');
  const parts = cleaned.split('.');
  return parts[parts.length - 1];
};

/**
 * 构造表/列感知替身。
 * rows：按表名给出伪数据行；未给出行的合法表返回空集；
 * 未在 CLEANER_SCHEMA 登记的表或列名不符的 SELECT 直接抛错。
 */
const buildMockManager = (
  rows: Record<string, FakeRow[]> = {},
  deleteFailOn?: RegExp,
): { manager: EntityManager; calls: CapturedCalls } => {
  const calls: CapturedCalls = {
    selectSql: [],
    deleteStatements: [],
    updateStatements: [],
    commitMock: jest.fn(),
    rollbackMock: jest.fn(),
  };

  const manager = {
    query: jest.fn((sql: string, params?: unknown[]) =>
      Promise.resolve().then(() => {
        const trimmed = sql.trim().replace(/\s+/g, ' ');
        if (trimmed.startsWith('DELETE')) {
          calls.deleteStatements.push(trimmed);
          if (deleteFailOn && deleteFailOn.test(trimmed)) {
            throw new Error('模拟删除失败');
          }
          return { affected: 0 };
        }
        if (trimmed.startsWith('UPDATE')) {
          calls.updateStatements.push(trimmed);
          return { affected: 0 };
        }
        calls.selectSql.push(trimmed);
        if (trimmed.includes('SELECT DATABASE()')) {
          return [{ current_database: 'lithography_e2e' }];
        }
        const fromMatch = /\bFROM\s+`?(\w+)`?/i.exec(trimmed);
        if (!fromMatch) {
          throw new Error(`替身无法解析 SELECT 来源表：${trimmed}`);
        }
        const table = fromMatch[1];
        const schema = CLEANER_SCHEMA[table];
        if (!schema) {
          throw new Error(`替身收到未预期的 SELECT（表 ${table} 未登记）：${trimmed}`);
        }
        // WHERE <col> IN (...) 列校验（支持 a.id 形式）。
        const whereMatches = [...trimmed.matchAll(/\b(?:\w+\.)?`?(\w+)`?\s+IN\s*\(/gi)];
        const whereColumns = whereMatches.map((m) => m[1]);
        for (const column of whereColumns) {
          if (!schema.includes(column)) {
            throw new Error(`替身收到列名不符的 SELECT（表 ${table} 无列 ${column}）：${trimmed}`);
          }
        }
        const tableRows = rows[table] ?? [];
        const inParams = params ?? [];
        const filtered =
          whereColumns.length === 0
            ? tableRows
            : tableRows.filter((row) =>
                inParams.some((p) => String(row[whereColumns[0]]) === String(p)),
              );
        // 按 SELECT 列表投影别名（AS alias 或末段列名）。
        const selectList = trimmed.slice(trimmed.indexOf('SELECT') + 6, trimmed.indexOf(' FROM'));
        const projections = selectList.split(',').map((item) => {
          const asMatch = /\bAS\s+`?(\w+)`?\s*$/i.exec(item.trim());
          const alias = asMatch ? asMatch[1] : lastSegment(item);
          const sourceColumn = lastSegment(
            asMatch ? item.trim().slice(0, item.trim().length - asMatch[0].length) : item,
          );
          if (!schema.includes(sourceColumn)) {
            throw new Error(
              `替身收到列名不符的 SELECT（表 ${table} 无列 ${sourceColumn}）：${trimmed}`,
            );
          }
          return { alias, sourceColumn };
        });
        return filtered.map((row) => {
          const projected: FakeRow = {};
          for (const { alias, sourceColumn } of projections) {
            projected[alias] = row[sourceColumn];
          }
          return projected;
        });
      }),
    ),
  } as unknown as EntityManager;

  return { manager, calls };
};

const buildMockDataSource = (manager: EntityManager, calls: CapturedCalls): DataSource =>
  ({
    options: { database: 'lithography_e2e' },
    query: jest.fn(() => Promise.resolve([{ current_database: 'lithography_e2e' }])),
    transaction: jest.fn(async (cb: (m: EntityManager) => Promise<void>) => {
      try {
        await cb(manager);
        await calls.commitMock();
      } catch (error) {
        await calls.rollbackMock();
        throw error;
      }
    }),
  }) as unknown as DataSource;

const runCleanup = (
  ledger: OwnedResourceLedger,
  rows: Record<string, FakeRow[]> = {},
  helper = 'v13-spec',
  deleteFailOn?: RegExp,
): Promise<unknown> & { calls: CapturedCalls } => {
  const { manager, calls } = buildMockManager(rows, deleteFailOn);
  const ds = buildMockDataSource(manager, calls);
  const promise = runGuardedSpecCleanup({
    dataSource: ds,
    helper,
    owned: ledger,
    expectedDatabase: 'lithography_e2e',
  });
  return Object.assign(promise, { calls });
};

/** 组织/账号夹具（父行事实承载类别）。 */
const registerOrgAndAccount = (ledger: OwnedResourceLedger): void => {
  recordOwnedResource(ledger, 'organization', 100, {
    organizationCode: 'ORG_V13',
    name: 'V13 Org',
    kind: 'SERVICE',
    status: 'ACTIVE',
  });
  recordOwnedResource(ledger, 'account', 200, {
    loginName: 'v13_user',
    loginEmail: 'v13@example.com',
    status: 'ACTIVE',
    identityHint: null,
    accessGroup: ['CUSTOMER'],
    nickname: 'v13_nick',
    userInfoEmail: 'v13@example.com',
    userState: 'ACTIVE',
  });
};

const orgRow: FakeRow = {
  id: 100,
  organization_code: 'ORG_V13',
  name: 'V13 Org',
  kind: 'SERVICE',
  status: 'ACTIVE',
};

const accountRow: FakeRow = {
  id: 200,
  login_name: 'v13_user',
  login_email: 'v13@example.com',
  status: 'ACTIVE',
  identity_hint: null,
  user_info_id: 999,
  nickname: 'v13_nick',
  user_info_email: 'v13@example.com',
  email: 'v13@example.com',
  access_group: ['CUSTOMER'],
  meta_digest: 'encrypted',
  user_state: 'ACTIVE',
};

describe('G-3 V13 清理闭包纯替身', () => {
  // =========================================================================
  describe('台账登记与事实完整性', () => {
    it('createOwnedResourceLedger 初始化全部 17 个 V13 类别数组与事实 Map', () => {
      const ledger = createOwnedResourceLedger();
      for (const category of V13_CATEGORIES) {
        const ids = asRecord(ledger)[`${category}Ids`];
        expect(Array.isArray(ids)).toBe(true);
        expect(ids as unknown[]).toHaveLength(0);
        const factsMap = (ledger.facts as Record<string, Map<unknown, unknown>>)[category];
        expect(factsMap).toBeInstanceOf(Map);
        expect(factsMap.size).toBe(0);
      }
    });

    it('17 个类别均可登记正整数 ID + 事实', () => {
      const ledger = createOwnedResourceLedger();
      let nextId = 1000;
      for (const category of V13_CATEGORIES) {
        const id = nextId++;
        recordAny(ledger, category, id, V13_FACT_FIXTURES[category]());
        expect(asRecord(ledger)[`${category}Ids`] as unknown[]).toEqual([id]);
        const factsMap = (ledger.facts as Record<string, Map<unknown, unknown>>)[category];
        expect(factsMap.has(id)).toBe(true);
      }
    });

    it.each(STRING_PK_CATEGORIES)('%s 支持 char(36) 字符串 ID 登记与去重', (category) => {
      const ledger = createOwnedResourceLedger();
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      recordAny(ledger, category, uuid, V13_FACT_FIXTURES[category as V13Category]());
      recordAny(ledger, category, uuid, V13_FACT_FIXTURES[category as V13Category]());
      expect(asRecord(ledger)[`${category}Ids`] as Array<number | string>).toEqual([uuid]);
    });

    it('拒绝非正整数 ID 与空字符串 ID', () => {
      const ledger = createOwnedResourceLedger();
      expect(() => recordAny(ledger, 'backupAsset', 0, V13_FACT_FIXTURES.backupAsset())).toThrow(
        /正整数/,
      );
      expect(() => recordAny(ledger, 'backupAsset', -1, V13_FACT_FIXTURES.backupAsset())).toThrow(
        /正整数/,
      );
      expect(() => recordAny(ledger, 'storedFile', '', V13_FACT_FIXTURES.storedFile())).toThrow(
        /字符串 ID 不能为空/,
      );
    });

    it('登记缺事实：事务开启前失败关闭，DELETE=0', async () => {
      const ledger = createOwnedResourceLedger();
      // 运行时绕过类型层 facts 必填约束，模拟“只登记 ID”的错误用法。
      recordAny(ledger, 'storedFile', 'file-no-facts');
      const task = runCleanup(ledger, {}, 'v13-missing-facts');
      await expect(task).rejects.toThrow(/缺少必要预期事实/);
      expect(task.calls.deleteStatements).toHaveLength(0);
      expect(task.calls.commitMock).not.toHaveBeenCalled();
      expect(task.calls.rollbackMock).not.toHaveBeenCalled();
    });

    it('mergeOwnedResourceLedger 合并混合类型 ID 与事实且去重', () => {
      const target = createOwnedResourceLedger();
      const source = createOwnedResourceLedger();
      recordAny(source, 'storedFile', 'uuid-a', V13_FACT_FIXTURES.storedFile());
      recordAny(source, 'backupAsset', 'uuid-b', V13_FACT_FIXTURES.backupAsset());
      recordAny(target, 'storedFile', 'uuid-a', V13_FACT_FIXTURES.storedFile());

      mergeOwnedResourceLedger(target, source);

      expect(asRecord(target).storedFileIds as Array<number | string>).toEqual(['uuid-a']);
      expect(asRecord(target).backupAssetIds as Array<number | string>).toEqual(['uuid-b']);
      const factsMap = (target.facts as Record<string, Map<unknown, unknown>>).backupAsset;
      expect(factsMap.has('uuid-b')).toBe(true);
    });
  });

  // =========================================================================
  describe('主键与父列名对迁移的静态契约', () => {
    const source = readFileSync(
      join(__dirname, '../../../test/utils/e2e-scoped-cleanup.ts'),
      'utf8',
    );

    it('char(36) 主键表的 DELETE 使用迁移真实主键列', () => {
      const pairs = [
        ...source.matchAll(/deleteByColumnIds\(\s*manager,\s*'(\w+)',\s*'(\w+)'/g),
      ].map((m) => `${m[1]}.${m[2]}`);
      const expected = {
        stored_file: 'file_id',
        ai_message_analysis: 'question_uuid',
        sync_receipt: 'receipt_id',
        sync_conflict: 'conflict_id',
        record_package_import: 'package_id',
        backup_asset: 'backup_id',
        backup_restore_run: 'restore_id',
        management_audit_event: 'event_id',
      } as const;
      for (const [table, column] of Object.entries(expected)) {
        expect(pairs).toContain(`${table}.${column}`);
      }
      // 迁移里不存在的主键名绝不允许出现。
      for (const wrong of [
        'backup_asset.asset_id',
        'backup_restore_run.run_id',
        'ai_message_analysis.analysis_id',
        'record_package_item.item_id',
        'intake_analysis_attempt.attempt_id',
        'repair_request_intake.intake_id',
        'repair_process_entry.entry_id',
        'repair_request_revision.revision_id',
        'reference_document_revision.revision_id',
        'local_account_authorization.authorization_id',
        'local_company_setting.setting_id',
      ]) {
        expect(pairs).not.toContain(wrong);
      }
    });

    it('int 主键 V13 表经 deleteByIds 按 id 删除', () => {
      for (const table of [
        'repair_request_intake',
        'intake_analysis_attempt',
        'repair_process_entry',
        'maintenance_report_fault',
        'repair_request_revision',
        'reference_document_revision',
        'local_account_authorization',
        'local_company_setting',
        'record_package_item',
      ]) {
        expect(source).toMatch(new RegExp(`deleteByIds\\(\\s*manager,\\s*'${table}'`));
      }
    });

    it('collectByParent 父列与迁移一致：intake=customer_account_id、entry=author_account_id、revision=actor_account_id', () => {
      const tuples = [...source.matchAll(/collectByParent\(\s*'(\w+)',\s*'(\w+)',\s*'(\w+)'/g)].map(
        (m) => `${m[1]}.${m[2]}.${m[3]}`,
      );
      const expectedTuples = [
        'stored_file.file_id.owner_organization_id',
        'stored_file.file_id.uploaded_by_account_id',
        'repair_request_intake.id.customer_organization_id',
        'repair_request_intake.id.service_organization_id',
        'repair_request_intake.id.customer_account_id',
        'repair_request_intake.id.equipment_model_id',
        'repair_request_intake.id.converted_request_id',
        'repair_request_intake.id.file_id',
        'repair_process_entry.id.author_account_id',
        'repair_process_entry.id.request_id',
        'repair_process_entry.id.file_id',
        'repair_request_revision.id.actor_account_id',
        'repair_request_revision.id.request_id',
        'reference_document_revision.id.actor_account_id',
        'reference_document_revision.id.document_id',
        'local_account_authorization.id.organization_id',
        'local_account_authorization.id.account_id',
        'local_company_setting.id.organization_id',
        'sync_receipt.receipt_id.organization_id',
        'sync_conflict.conflict_id.organization_id',
        'sync_conflict.conflict_id.confirmed_by_account_id',
        'record_package_import.package_id.organization_id',
        'record_package_import.package_id.imported_by_account_id',
        'backup_asset.backup_id.organization_id',
        'backup_restore_run.restore_id.organization_id',
        'backup_restore_run.restore_id.started_by_account_id',
        'backup_restore_run.restore_id.backup_id',
        'backup_restore_run.restore_id.protection_backup_id',
        'management_audit_event.event_id.organization_id',
        'management_audit_event.event_id.actor_account_id',
        'intake_analysis_attempt.id.intake_id',
        'record_package_item.id.package_id',
        'record_package_item.id.receipt_id',
      ];
      for (const tuple of expectedTuples) {
        expect(tuples).toContain(tuple);
      }
      // 迁移里不存在的列绝不出现。
      for (const wrong of [
        'repair_request_intake.id.created_by_account_id',
        'repair_process_entry.id.actor_account_id',
        'repair_request_revision.id.changed_by_account_id',
        'reference_document_revision.id.changed_by_account_id',
      ]) {
        expect(tuples).not.toContain(wrong);
      }
      // ai_message_analysis 无 request_id 列：不提供任何按父发现。
      expect(tuples.filter((t) => t.startsWith('ai_message_analysis.'))).toHaveLength(0);
    });

    it('事实回读 SELECT 覆盖各表不可变归属列', () => {
      for (const snippet of [
        'SELECT id, record_uuid, customer_account_id',
        'SELECT id, intake_id, generation_no',
        'SELECT id, entry_uuid, request_id, author_account_id, file_id',
        'SELECT question_uuid, conversation_id, question_message_id, answer_message_id',
        'SELECT id, report_id, fault_uuid, branch_kind, step_code, lifecycle_source',
        'SELECT id, request_id, revision_no, actor_account_id, schema_version',
        'SELECT id, document_id, revision_no, actor_account_id',
        'SELECT id, installation_id, account_id, organization_id',
        'SELECT id, installation_id, organization_id, setting_source',
        'SELECT receipt_id, record_uuid, organization_id, resource_type, version_no, source_system',
        'SELECT conflict_id, record_uuid, organization_id, resource_type, version_no',
        'SELECT package_id, organization_id, imported_by_account_id, manifest_checksum',
        'SELECT id, package_id, record_uuid, resource_type, version_no, receipt_id',
        'SELECT restore_id, backup_id, protection_backup_id, organization_id',
        'SELECT event_id, actor_account_id, organization_id, operation, target_type',
      ]) {
        expect(source.replace(/\s+/g, ' ')).toContain(snippet);
      }
    });
  });

  // =========================================================================
  describe('所有权闭包（R01）', () => {
    it('父行属于本轮、子行未登记：拒绝且 DELETE=0、事务回滚', async () => {
      const ledger = createOwnedResourceLedger();
      registerOrgAndAccount(ledger);
      // 数据库里存在一条引用本轮组织、但未登记的 stored_file。
      const rows: Record<string, FakeRow[]> = {
        organization: [orgRow],
        base_user_account: [accountRow],
        stored_file: [
          {
            file_id: 'unregistered-file',
            owner_organization_id: 100,
            uploaded_by_account_id: 999,
          },
        ],
      };
      const task = runCleanup(ledger, rows, 'v13-r01-unregistered');
      await expect(task).rejects.toThrow(/未登记归属证据/);
      expect(task.calls.deleteStatements).toHaveLength(0);
      expect(task.calls.rollbackMock).toHaveBeenCalled();
      expect(task.calls.commitMock).not.toHaveBeenCalled();
    });

    it('旧表 repair_request 经 intake_id 引用本轮报修输入但未登记：拒绝且 DELETE=0', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'repairRequestIntake', 5001, V13_FACT_FIXTURES.repairRequestIntake());
      const rows: Record<string, FakeRow[]> = {
        repair_request_intake: [
          {
            id: 5001,
            record_uuid: 'uuid-intake-1',
            customer_account_id: 200,
            customer_organization_id: 100,
            service_organization_id: 100,
            equipment_model_id: 300,
            error_code: 'E001',
            fault_description: '故障描述',
            file_id: null,
          },
        ],
        repair_request: [{ id: 9001, intake_id: 5001 }],
      };
      const task = runCleanup(ledger, rows, 'v13-r01-reverse');
      await expect(task).rejects.toThrow(/引用本轮报修输入但未登记/);
      expect(task.calls.deleteStatements).toHaveLength(0);
      expect(task.calls.rollbackMock).toHaveBeenCalled();
    });

    it('ai_message_analysis 父行不在清理范围：仅凭登记事实核验即可删除，无按父发现查询', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'aiMessageAnalysis', 'qu-1', V13_FACT_FIXTURES.aiMessageAnalysis());
      const rows: Record<string, FakeRow[]> = {
        ai_message_analysis: [
          {
            question_uuid: 'qu-1',
            conversation_id: 8001,
            question_message_id: 8002,
            answer_message_id: null,
          },
        ],
      };
      const task = runCleanup(ledger, rows, 'v13-ai-analysis');
      await task;
      // 替身会对“表未登记/列名不符”抛错；此处成功即证明未发出 request_id 等非法父列查询。
      expect(
        task.calls.deleteStatements.some((s) =>
          s.includes('DELETE FROM ai_message_analysis WHERE question_uuid IN'),
        ),
      ).toBe(true);
      expect(task.calls.commitMock).toHaveBeenCalled();
    });
  });

  // =========================================================================
  describe('事实回读核验（R02）', () => {
    it('新增表登记事实漂移：第一条 DELETE 前拒绝，DELETE=0', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'storedFile', 'file-drift', V13_FACT_FIXTURES.storedFile());
      const rows: Record<string, FakeRow[]> = {
        stored_file: [
          {
            file_id: 'file-drift',
            uploaded_by_account_id: 200,
            owner_organization_id: 100,
            storage_reference: 'oss://bucket/file-1',
            original_filename: 'a.txt',
            // 漂移：与登记事实不一致。
            checksum_sha256: 'd'.repeat(64),
            upload_context_id: 'ctx-1',
          },
        ],
      };
      const task = runCleanup(ledger, rows, 'v13-drift');
      await expect(task).rejects.toThrow(/事实漂移/);
      expect(task.calls.deleteStatements).toHaveLength(0);
      expect(task.calls.rollbackMock).toHaveBeenCalled();
      expect(task.calls.commitMock).not.toHaveBeenCalled();
    });

    it('报修输入事实漂移（customer_account_id 不符）：拒绝且 DELETE=0', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'repairRequestIntake', 5001, V13_FACT_FIXTURES.repairRequestIntake());
      const rows: Record<string, FakeRow[]> = {
        repair_request_intake: [
          {
            id: 5001,
            record_uuid: 'uuid-intake-1',
            customer_account_id: 201,
            customer_organization_id: 100,
            service_organization_id: 100,
            equipment_model_id: 300,
            error_code: 'E001',
            fault_description: '故障描述',
            file_id: null,
          },
        ],
      };
      const task = runCleanup(ledger, rows, 'v13-intake-drift');
      await expect(task).rejects.toThrow(/事实漂移/);
      expect(task.calls.deleteStatements).toHaveLength(0);
    });

    it('登记行已不存在视为已回收：幂等跳过，正常提交', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'backupAsset', 'backup-gone', V13_FACT_FIXTURES.backupAsset());
      // 替身返回空集（行已被回收）。
      const task = runCleanup(ledger, {}, 'v13-idempotent');
      await task;
      expect(task.calls.commitMock).toHaveBeenCalled();
      expect(
        task.calls.deleteStatements.some((s) =>
          s.includes('DELETE FROM backup_asset WHERE backup_id IN'),
        ),
      ).toBe(true);
    });
  });

  // =========================================================================
  describe('删除顺序与事务', () => {
    it('合法删除顺序：restore_run→backup_asset、item→import/receipt、attempt→intake、stored_file 最后、V13 先于父行', async () => {
      const ledger = createOwnedResourceLedger();
      registerOrgAndAccount(ledger);
      recordAny(ledger, 'storedFile', 'file-1', V13_FACT_FIXTURES.storedFile());
      recordAny(ledger, 'repairRequestIntake', 5001, V13_FACT_FIXTURES.repairRequestIntake());
      recordAny(ledger, 'intakeAnalysisAttempt', 5101, V13_FACT_FIXTURES.intakeAnalysisAttempt());
      recordAny(ledger, 'syncReceipt', 'rc-1', V13_FACT_FIXTURES.syncReceipt());
      recordAny(ledger, 'recordPackageImport', 'pkg-1', V13_FACT_FIXTURES.recordPackageImport());
      recordAny(ledger, 'recordPackageItem', 6401, V13_FACT_FIXTURES.recordPackageItem());
      recordAny(ledger, 'backupAsset', 'ba-1', V13_FACT_FIXTURES.backupAsset());
      recordAny(ledger, 'backupRestoreRun', 'br-1', V13_FACT_FIXTURES.backupRestoreRun());

      const rows: Record<string, FakeRow[]> = {
        organization: [orgRow],
        base_user_account: [accountRow],
        stored_file: [
          {
            file_id: 'file-1',
            uploaded_by_account_id: 200,
            owner_organization_id: 100,
            storage_reference: 'oss://bucket/file-1',
            original_filename: 'a.txt',
            checksum_sha256: 'c'.repeat(64),
            upload_context_id: 'ctx-1',
          },
        ],
        repair_request_intake: [
          {
            id: 5001,
            record_uuid: 'uuid-intake-1',
            customer_account_id: 200,
            customer_organization_id: 100,
            service_organization_id: 100,
            equipment_model_id: 300,
            error_code: 'E001',
            fault_description: '故障描述',
            file_id: null,
          },
        ],
        intake_analysis_attempt: [{ id: 5101, intake_id: 5001, generation_no: 0 }],
        sync_receipt: [
          {
            receipt_id: 'rc-1',
            record_uuid: 'uuid-receipt-1',
            organization_id: 100,
            resource_type: 'REPAIR',
            version_no: 1,
            source_system: 'CLOUD',
          },
        ],
        record_package_import: [
          {
            package_id: 'pkg-1',
            organization_id: 100,
            imported_by_account_id: 200,
            manifest_checksum: 'm'.repeat(64),
          },
        ],
        record_package_item: [
          {
            id: 6401,
            package_id: 'pkg-1',
            record_uuid: 'uuid-item-1',
            resource_type: 'REPAIR',
            version_no: 1,
            receipt_id: null,
          },
        ],
        backup_asset: [
          {
            backup_id: 'ba-1',
            run_id: 4001,
            organization_id: 100,
            storage_reference: 'oss://bucket/backup-1',
            file_sha256: 'f'.repeat(64),
            local_cleanup_run_id: null,
          },
        ],
        backup_restore_run: [
          {
            restore_id: 'br-1',
            backup_id: 'ba-1',
            protection_backup_id: 'ba-2',
            organization_id: 100,
            started_by_account_id: 200,
          },
        ],
      };

      const task = runCleanup(ledger, rows, 'v13-order');
      await task;

      const deletes = task.calls.deleteStatements;
      const idxOf = (table: string): number =>
        deletes.findIndex((s) => s.includes(`DELETE FROM ${table} `));
      // 每个目标表都有删除语句。
      for (const table of [
        'intake_analysis_attempt',
        'record_package_item',
        'backup_restore_run',
        'repair_request_intake',
        'sync_receipt',
        'record_package_import',
        'backup_asset',
        'stored_file',
        'organization',
        'base_user_account',
      ]) {
        expect(idxOf(table)).toBeGreaterThanOrEqual(0);
      }
      // 依赖顺序。
      expect(idxOf('backup_restore_run')).toBeLessThan(idxOf('backup_asset'));
      expect(idxOf('record_package_item')).toBeLessThan(idxOf('sync_receipt'));
      expect(idxOf('record_package_item')).toBeLessThan(idxOf('record_package_import'));
      expect(idxOf('intake_analysis_attempt')).toBeLessThan(idxOf('repair_request_intake'));
      expect(idxOf('repair_request_intake')).toBeLessThan(idxOf('stored_file'));
      // stored_file 是 V13 删除序列最后（先于旧链父行）。
      expect(idxOf('stored_file')).toBeLessThan(idxOf('organization'));
      expect(idxOf('stored_file')).toBeLessThan(idxOf('base_user_account'));
      // 主键列名断言（与迁移一致）。
      expect(deletes[idxOf('backup_restore_run')]).toContain('WHERE restore_id IN');
      expect(deletes[idxOf('backup_asset')]).toContain('WHERE backup_id IN');
      expect(deletes[idxOf('sync_receipt')]).toContain('WHERE receipt_id IN');
      expect(deletes[idxOf('record_package_import')]).toContain('WHERE package_id IN');
      expect(deletes[idxOf('repair_request_intake')]).toContain('WHERE id IN');
      expect(deletes[idxOf('stored_file')]).toContain('WHERE file_id IN');
      expect(task.calls.commitMock).toHaveBeenCalled();
      expect(task.calls.rollbackMock).not.toHaveBeenCalled();
    });

    it('intake↔repair_request 循环引用：先 UPDATE 置空 intake_id，再删 intake，最后删 repair_request', async () => {
      const ledger = createOwnedResourceLedger();
      // repair_request 的客户账号必须在本轮范围（collectSpecialOwnedGraph 归属核验）。
      recordOwnedResource(ledger, 'account', 200, {
        loginName: 'v13_user',
        loginEmail: 'v13@example.com',
        status: 'ACTIVE',
        identityHint: null,
        accessGroup: ['CUSTOMER'],
        nickname: 'v13_nick',
        userInfoEmail: 'v13@example.com',
        userState: 'ACTIVE',
      });
      recordOwnedResource(ledger, 'equipmentModel', 300, {
        modelCode: 'MODEL-300',
        modelName: '型号300',
        enabled: true,
        sortOrder: 1,
      });
      recordOwnedResource(ledger, 'repairRequest', 9001, {
        requestNo: 'REQ-9001',
        customerAccountId: 200,
        equipmentModelId: 300,
        errorCode: 'E001',
        faultDescription: '故障描述',
      });
      recordAny(ledger, 'repairRequestIntake', 5001, V13_FACT_FIXTURES.repairRequestIntake());
      recordAny(ledger, 'intakeAnalysisAttempt', 5101, V13_FACT_FIXTURES.intakeAnalysisAttempt());

      const rows: Record<string, FakeRow[]> = {
        base_user_account: [accountRow],
        equipment_model: [
          { id: 300, model_code: 'MODEL-300', model_name: '型号300', enabled: 1, sort_order: 1 },
        ],
        repair_request: [
          {
            id: 9001,
            request_no: 'REQ-9001',
            customer_account_id: 200,
            equipment_model_id: 300,
            accepted_by_engineer_account_id: null,
            is_accepted: 0,
            deprecated: 0,
            error_code: 'E001',
            fault_description: '故障描述',
            content_md: null,
            intake_id: 5001,
          },
        ],
        repair_request_intake: [
          {
            id: 5001,
            record_uuid: 'uuid-intake-1',
            customer_account_id: 200,
            customer_organization_id: 100,
            service_organization_id: 100,
            equipment_model_id: 300,
            error_code: 'E001',
            fault_description: '故障描述',
            file_id: null,
            converted_request_id: 9001,
          },
        ],
        intake_analysis_attempt: [{ id: 5101, intake_id: 5001, generation_no: 0 }],
      };

      const task = runCleanup(ledger, rows, 'v13-circular');
      await task;

      expect(task.calls.updateStatements).toHaveLength(1);
      expect(task.calls.updateStatements[0]).toContain(
        'UPDATE repair_request SET intake_id = NULL',
      );
      const deletes = task.calls.deleteStatements;
      const intakeIdx = deletes.findIndex((s) => s.includes('DELETE FROM repair_request_intake'));
      const requestIdx = deletes.findIndex((s) => s.includes('DELETE FROM repair_request '));
      expect(intakeIdx).toBeGreaterThanOrEqual(0);
      expect(requestIdx).toBeGreaterThan(intakeIdx);
      expect(task.calls.commitMock).toHaveBeenCalled();
    });

    it('用例提交子行后断言失败：合并台账仍按依赖顺序精确回收，不残留不误删', async () => {
      // 场景：用例已提交 repair_request（父行来自套件夹具），随后断言失败。
      // 正确收尾 = 子行创建成功即登记进同一合并台账，清理时修复请求先于
      // 客户账号/机型/组织删除；失败不会遗留子行，也不会触碰台账外数据。
      const ledger = createOwnedResourceLedger();
      registerOrgAndAccount(ledger);
      recordOwnedResource(ledger, 'equipmentModel', 300, {
        modelCode: 'MODEL-300',
        modelName: '型号300',
        enabled: true,
        sortOrder: 1,
      });
      recordOwnedResource(ledger, 'repairRequest', 9001, {
        requestNo: 'REQ-9001',
        customerAccountId: 200,
        equipmentModelId: 300,
        errorCode: 'E001',
        faultDescription: '故障描述',
      });

      const rows: Record<string, FakeRow[]> = {
        organization: [orgRow],
        base_user_account: [accountRow],
        equipment_model: [
          { id: 300, model_code: 'MODEL-300', model_name: '型号300', enabled: 1, sort_order: 1 },
        ],
        repair_request: [
          {
            id: 9001,
            request_no: 'REQ-9001',
            customer_account_id: 200,
            equipment_model_id: 300,
            accepted_by_engineer_account_id: null,
            is_accepted: 0,
            deprecated: 0,
            error_code: 'E001',
            fault_description: '故障描述',
            content_md: null,
            intake_id: null,
          },
        ],
      };

      // 模拟用例体在提交子行之后抛出断言错误：清理仍由套件统一执行。
      const assertionFailure = new Error('用例断言失败（模拟）');
      const caseBody = (): Promise<void> => Promise.reject(assertionFailure);
      await expect(caseBody()).rejects.toThrow('用例断言失败（模拟）');

      const task = runCleanup(ledger, rows, 'v13-case-failure');
      await task;

      const deletes = task.calls.deleteStatements;
      const requestIdx = deletes.findIndex((s) => s.includes('DELETE FROM repair_request '));
      const accountIdx = deletes.findIndex((s) => s.includes('DELETE FROM base_user_account'));
      const modelIdx = deletes.findIndex((s) => s.includes('DELETE FROM equipment_model'));
      const orgIdx = deletes.findIndex((s) => s.includes('DELETE FROM organization'));
      expect(requestIdx).toBeGreaterThanOrEqual(0);
      expect(accountIdx).toBeGreaterThanOrEqual(0);
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(orgIdx).toBeGreaterThanOrEqual(0);
      // 子行（工单）必须先于其全部父行（客户账号/机型/组织）删除。
      expect(requestIdx).toBeLessThan(accountIdx);
      expect(requestIdx).toBeLessThan(modelIdx);
      expect(requestIdx).toBeLessThan(orgIdx);
      expect(task.calls.commitMock).toHaveBeenCalledTimes(1);
      expect(task.calls.rollbackMock).not.toHaveBeenCalled();
    });

    it('删除中途失败：后续 DELETE 不执行且事务回滚', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'backupRestoreRun', 'br-1', V13_FACT_FIXTURES.backupRestoreRun());
      recordAny(ledger, 'backupAsset', 'ba-1', V13_FACT_FIXTURES.backupAsset());
      recordAny(ledger, 'storedFile', 'file-1', V13_FACT_FIXTURES.storedFile());

      const rows: Record<string, FakeRow[]> = {
        backup_restore_run: [
          {
            restore_id: 'br-1',
            backup_id: 'ba-1',
            protection_backup_id: 'ba-2',
            organization_id: 100,
            started_by_account_id: 200,
          },
        ],
        backup_asset: [
          {
            backup_id: 'ba-1',
            run_id: 4001,
            organization_id: 100,
            storage_reference: 'oss://bucket/backup-1',
            file_sha256: 'f'.repeat(64),
            local_cleanup_run_id: null,
          },
        ],
        stored_file: [
          {
            file_id: 'file-1',
            uploaded_by_account_id: 200,
            owner_organization_id: 100,
            storage_reference: 'oss://bucket/file-1',
            original_filename: 'a.txt',
            checksum_sha256: 'c'.repeat(64),
            upload_context_id: 'ctx-1',
          },
        ],
      };

      const task = runCleanup(ledger, rows, 'v13-delete-fail', /DELETE FROM backup_asset/);
      await expect(task).rejects.toThrow(/模拟删除失败/);

      const deletes = task.calls.deleteStatements;
      expect(deletes.some((s) => s.includes('DELETE FROM backup_restore_run'))).toBe(true);
      expect(deletes.some((s) => s.includes('DELETE FROM backup_asset'))).toBe(true);
      // backup_asset 失败即中止：stored_file 不删除。
      expect(deletes.some((s) => s.includes('DELETE FROM stored_file'))).toBe(false);
      expect(task.calls.rollbackMock).toHaveBeenCalled();
      expect(task.calls.commitMock).not.toHaveBeenCalled();
    });

    it('maintenance_report_fault 只按登记 ID 删除（父报告不在清理范围）', async () => {
      const ledger = createOwnedResourceLedger();
      recordAny(ledger, 'maintenanceReportFault', 6501, V13_FACT_FIXTURES.maintenanceReportFault());
      const rows: Record<string, FakeRow[]> = {
        maintenance_report_fault: [
          {
            id: 6501,
            report_id: 7001,
            fault_uuid: 'uuid-fault-1',
            branch_kind: 'DEVICE',
            step_code: null,
            lifecycle_source: 'SYSTEM',
          },
        ],
      };
      const task = runCleanup(ledger, rows, 'v13-fault');
      await task;
      expect(
        task.calls.deleteStatements.some((s) =>
          s.includes('DELETE FROM maintenance_report_fault WHERE id IN'),
        ),
      ).toBe(true);
      // 不对 maintenance_report 发出任何语句。
      expect(
        task.calls.deleteStatements.some((s) => s.includes('DELETE FROM maintenance_report ')),
      ).toBe(false);
    });

    it('空台账重复执行为 no-op：不开启事务、不执行任何语句', async () => {
      const ledger = createOwnedResourceLedger();
      const task = runCleanup(ledger, {}, 'v13-noop');
      await task;
      expect(task.calls.selectSql).toHaveLength(0);
      expect(task.calls.deleteStatements).toHaveLength(0);
      expect(task.calls.commitMock).not.toHaveBeenCalled();
    });
  });
});
