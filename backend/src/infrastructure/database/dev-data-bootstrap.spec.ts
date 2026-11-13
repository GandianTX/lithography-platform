import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EntityManager } from 'typeorm';

import {
  buildDevReportSnapshot,
  containsDevSampleFiles,
  decideEquipmentModel,
  decideMaintenanceReport,
  decideReferenceDocument,
  decideRepairRequest,
  parseDevDataConfig,
  upsertReferenceDocuments,
  type DevDataConfig,
  type DevReferenceDocumentSeed,
} from './dev-data-bootstrap';
import {
  claimDevSampleFilesDirectory,
  deriveDevSampleStorageReference,
  sha256Of,
} from './dev-sample-files';

const SERVER_UUID = '6ccd2f7e-1b0f-11ee-be56-0242ac120002';

function sampleFile(content: string, name: string): Record<string, unknown> {
  return {
    original_filename: name,
    mime_type: 'text/plain',
    byte_size: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    content,
  };
}

function validConfig(): Record<string, unknown> {
  return {
    schema_version: 1,
    equipment_models: [
      { model_code: 'DEV-MODEL-A', model_name: '开发机型 A', sort_order: 10 },
      { model_code: 'DEV-MODEL-B', model_name: '开发机型 B', sort_order: 20, enabled: false },
    ],
    repair_requests: [
      {
        request_no: 'DEV-RR-A-001',
        customer_login_name: 'dev-customer-a1',
        service_organization_code: 'ORG-DEV-B',
        equipment_model_code: 'DEV-MODEL-A',
        error_code: 'DEV-E-1001',
        fault_description: '待接单样例',
        content_md: '现场反馈设备无法完成曝光。',
        created_at: '2026-10-01T01:00:00.000Z',
        accepted_by_login_name: null,
        accepted_at: null,
        handling_result: null,
        handling_recorded_by_login_name: null,
        handling_recorded_at: null,
        handling_ended_at: null,
        closure_reason: null,
      },
      {
        request_no: 'DEV-RR-B-001',
        customer_login_name: 'dev-customer-b1',
        service_organization_code: 'ORG-DEV-B',
        equipment_model_code: 'DEV-MODEL-A',
        error_code: 'DEV-E-2001',
        fault_description: '处理中样例',
        content_md: '设备报警后暂停使用。',
        created_at: '2026-10-02T01:00:00.000Z',
        accepted_by_login_name: 'dev-engineer-b',
        accepted_at: '2026-10-02T02:00:00.000Z',
        handling_result: 'INTERRUPTED',
        handling_recorded_by_login_name: 'dev-engineer-b',
        handling_recorded_at: '2026-10-03T02:00:00.000Z',
        handling_ended_at: null,
        closure_reason: '等待备件到货',
      },
      {
        request_no: 'DEV-RR-A-002',
        customer_login_name: 'dev-customer-a2',
        service_organization_code: 'ORG-DEV-A',
        equipment_model_code: 'DEV-MODEL-B',
        error_code: 'DEV-E-3001',
        fault_description: '已完成样例',
        content_md: '更换部件后恢复。',
        created_at: '2026-10-04T01:00:00.000Z',
        accepted_by_login_name: 'dev-engineer-a',
        accepted_at: '2026-10-04T02:00:00.000Z',
        handling_result: 'FIXED',
        handling_recorded_by_login_name: 'dev-engineer-a',
        handling_recorded_at: '2026-10-05T02:00:00.000Z',
        handling_ended_at: '2026-10-06T02:00:00.000Z',
        closure_reason: null,
      },
    ],
    maintenance_reports: [
      {
        repair_request_no: 'DEV-RR-B-001',
        owner_organization_code: 'ORG-DEV-B',
        title: '设备报警处理记录（草稿）',
        customer_factory_name: '开发客户 B 工厂',
        equipment_model_code: 'DEV-MODEL-A',
        maintenance_date: '2026-10-03',
        engineer_login_name: 'dev-engineer-b',
        status: 'DRAFT',
        handling_result: null,
        reset_result: null,
        actual_cause: null,
        repair_actions: null,
        verification_result: null,
        alarms: [
          {
            alarm_index: 1,
            alarm_code: 'ALM-101',
            alarm_description: '曝光异常',
            phase_code: 'PHASE_02',
            reset_result: 'NOT_ATTEMPTED',
          },
        ],
        steps: [
          {
            step_no: 1,
            step_code: 'STEP-01',
            phase_code: 'PHASE_02',
            part_name: '光学模组',
            action_text: '检查光路并记录报警。',
            result_text: '等待备件。',
            new_alarm_code: null,
            is_valid_new_branch: false,
          },
        ],
      },
      {
        repair_request_no: 'DEV-RR-A-002',
        owner_organization_code: 'ORG-DEV-A',
        title: '曝光异常维修报告',
        customer_factory_name: '开发客户 A 工厂',
        equipment_model_code: 'DEV-MODEL-B',
        maintenance_date: '2026-10-06',
        engineer_login_name: 'dev-engineer-a',
        status: 'APPROVED',
        handling_result: 'FIXED',
        reset_result: 'NORMAL',
        actual_cause: '部件老化',
        repair_actions: '更换部件并复测。',
        verification_result: '连续运行正常。',
        alarms: [
          {
            alarm_index: 1,
            alarm_code: 'ALM-201',
            alarm_description: '光源功率不足',
            phase_code: 'PHASE_03',
            reset_result: 'RESET_OK',
          },
        ],
        steps: [
          {
            step_no: 1,
            step_code: 'STEP-01',
            phase_code: 'PHASE_03',
            part_name: '光源',
            action_text: '更换光源并复测功率。',
            result_text: '功率恢复。',
            new_alarm_code: null,
            is_valid_new_branch: false,
          },
        ],
        submitted_at: '2026-10-07T01:00:00.000Z',
        reviewed_at: '2026-10-08T01:00:00.000Z',
        reviewer_login_name: 'admin-l2-a',
        review_comment: '内容完整，同意归档。',
      },
    ],
    reference_documents: [
      {
        seed_key: 'dev-reference-document-a',
        title: '开发客户 A 保养手册',
        document_type: 'MAINTENANCE_MANUAL',
        owner_organization_code: 'ORG-DEV-A',
        equipment_model_code: 'DEV-MODEL-B',
        description: '开发联调资料 A',
        content_text: '保养前请断电并确认安全。',
        created_by_login_name: 'dev-engineer-a',
        file: sampleFile('开发联调资料 A 原件\n', 'dev-reference-a.txt'),
      },
      {
        seed_key: 'dev-reference-document-b',
        title: '开发客户 B 故障代码表',
        document_type: 'FAULT_CODE_TABLE',
        owner_organization_code: 'ORG-DEV-B',
        equipment_model_code: 'DEV-MODEL-A',
        description: '开发联调资料 B',
        content_text: 'ALM-101 表示曝光异常。',
        created_by_login_name: 'dev-engineer-b',
        file: sampleFile('开发联调资料 B 原件\n', 'dev-reference-b.txt'),
      },
    ],
  };
}

function parseValid(): DevDataConfig {
  return parseDevDataConfig(JSON.stringify(validConfig()));
}

function cloneValid(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validConfig())) as Record<string, unknown>;
}

describe('开发联调样例配置（不连接实库）', () => {
  it('合法配置覆盖机型、待接单/处理中/已完成、草稿/正式报告与两家公司资料', () => {
    const config = parseValid();
    expect(config.equipmentModels).toHaveLength(2);
    expect(config.repairRequests.map((entry) => entry.requestNo)).toEqual([
      'DEV-RR-A-001',
      'DEV-RR-B-001',
      'DEV-RR-A-002',
    ]);
    expect(config.maintenanceReports.map((entry) => entry.status)).toEqual(['DRAFT', 'APPROVED']);
    expect(config.referenceDocuments).toHaveLength(2);
    expect(containsDevSampleFiles(config)).toBe(true);
    expect(config.referenceDocuments.map((entry) => entry.seedKey)).toEqual([
      'dev-reference-document-a',
      'dev-reference-document-b',
    ]);
  });

  it('资料缺少 seed_key、缺少原件或 seed_key 重复/非法时失败关闭', () => {
    const missingSeed = cloneValid();
    delete (missingSeed.reference_documents as Array<Record<string, unknown>>)[0].seed_key;
    expect(() => parseDevDataConfig(JSON.stringify(missingSeed))).toThrow(/seed_key/);

    const missingFile = cloneValid();
    delete (missingFile.reference_documents as Array<Record<string, unknown>>)[0].file;
    expect(() => parseDevDataConfig(JSON.stringify(missingFile))).toThrow(/只支持带原件的资料样例/);

    const duplicate = cloneValid();
    const duplicateDocs = duplicate.reference_documents as Array<Record<string, unknown>>;
    duplicateDocs[1].seed_key = duplicateDocs[0].seed_key;
    expect(() => parseDevDataConfig(JSON.stringify(duplicate))).toThrow(/重复资料稳定键/);

    const invalid = cloneValid();
    (invalid.reference_documents as Array<Record<string, unknown>>)[0].seed_key = 'A B';
    expect(() => parseDevDataConfig(JSON.stringify(invalid))).toThrow(/seed_key/);
  });

  it('资料原件必须同时声明可核对的字节数与 SHA-256', () => {
    const raw = cloneValid();
    const documents = raw.reference_documents as Array<Record<string, unknown>>;
    const content = '开发联调原件\n第二行。\n';
    documents[0].file = {
      original_filename: 'dev-sample-a.txt',
      mime_type: 'text/plain',
      byte_size: Buffer.byteLength(content, 'utf8'),
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      content,
    };
    const config = parseDevDataConfig(JSON.stringify(raw));
    expect(containsDevSampleFiles(config)).toBe(true);
    expect(config.referenceDocuments[0].file?.originalFilename).toBe('dev-sample-a.txt');

    const wrongHash = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const wrongHashDocs = wrongHash.reference_documents as Array<Record<string, unknown>>;
    (wrongHashDocs[0].file as Record<string, unknown>).sha256 = 'f'.repeat(64);
    expect(() => parseDevDataConfig(JSON.stringify(wrongHash))).toThrow(/sha256/);

    const wrongSize = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const wrongSizeDocs = wrongSize.reference_documents as Array<Record<string, unknown>>;
    (wrongSizeDocs[0].file as Record<string, unknown>).byte_size = 1;
    expect(() => parseDevDataConfig(JSON.stringify(wrongSize))).toThrow(/byte_size/);
  });

  it('资料原件只接受纯文本 .txt 且拒绝未知字段', () => {
    const makeRaw = (overrides: Record<string, unknown>): Record<string, unknown> => {
      const raw = cloneValid();
      const documents = raw.reference_documents as Array<Record<string, unknown>>;
      documents[0].file = {
        original_filename: 'dev-sample-a.txt',
        mime_type: 'text/plain',
        byte_size: 3,
        sha256: createHash('sha256').update('abc', 'utf8').digest('hex'),
        content: 'abc',
        ...overrides,
      };
      return raw;
    };
    expect(() => parseDevDataConfig(JSON.stringify(makeRaw({})))).not.toThrow();
    expect(() =>
      parseDevDataConfig(JSON.stringify(makeRaw({ original_filename: 'a.pdf' }))),
    ).toThrow(/\.txt/);
    expect(() =>
      parseDevDataConfig(JSON.stringify(makeRaw({ mime_type: 'application/json' }))),
    ).toThrow(/text\/plain/);
    expect(() => parseDevDataConfig(JSON.stringify(makeRaw({ extra: 'x' })))).toThrow(
      /不支持的字段/,
    );
  });

  it('缺少待接单/处理中/已完成覆盖时失败关闭', () => {
    const raw = cloneValid();
    const requests = raw.repair_requests as Array<Record<string, unknown>>;
    requests[0].accepted_by_login_name = 'dev-engineer-b';
    requests[0].accepted_at = '2026-10-01T02:00:00.000Z';
    expect(() => parseDevDataConfig(JSON.stringify(raw))).toThrow(/PENDING/);
  });

  it('报告未同时覆盖草稿与正式结果时失败关闭', () => {
    const raw = cloneValid();
    const reports = raw.maintenance_reports as Array<Record<string, unknown>>;
    reports[1].status = 'DRAFT';
    reports[1].submitted_at = null;
    reports[1].reviewed_at = null;
    reports[1].reviewer_login_name = null;
    expect(() => parseDevDataConfig(JSON.stringify(raw))).toThrow(/DRAFT 与 APPROVED/);
  });

  it('正式报告只能关联已完成工单且处理结果一致', () => {
    const raw = cloneValid();
    const reports = raw.maintenance_reports as Array<Record<string, unknown>>;
    reports[1].repair_request_no = 'DEV-RR-B-001';
    expect(() => parseDevDataConfig(JSON.stringify(raw))).toThrow(/只能关联已完成工单|同一工单/);
  });

  it('处理结果与接单/结束时间不自洽时失败关闭', () => {
    const raw = cloneValid();
    const requests = raw.repair_requests as Array<Record<string, unknown>>;
    requests[1].handling_ended_at = '2026-10-03T03:00:00.000Z';
    expect(() => parseDevDataConfig(JSON.stringify(raw))).toThrow(/处理中工单不得提供/);
  });

  it('未知字段、重复稳定键与缺失覆盖公司均失败关闭', () => {
    const unknown = cloneValid();
    (unknown.equipment_models as Array<Record<string, unknown>>)[0].extra = 'x';
    expect(() => parseDevDataConfig(JSON.stringify(unknown))).toThrow(/不支持的字段/);

    const duplicate = cloneValid();
    const requests = duplicate.repair_requests as Array<Record<string, unknown>>;
    requests[2].request_no = 'DEV-RR-A-001';
    expect(() => parseDevDataConfig(JSON.stringify(duplicate))).toThrow(/重复工单号/);

    const singleOwner = cloneValid();
    const documents = singleOwner.reference_documents as Array<Record<string, unknown>>;
    documents[1].owner_organization_code = 'ORG-DEV-A';
    expect(() => parseDevDataConfig(JSON.stringify(singleOwner))).toThrow(/至少 2 家归属公司/);
  });
});

describe('开发联调样例幂等决策（不连接实库）', () => {
  const config = parseValid();

  it('机型同键同名保持 UNCHANGED，同键异名拒绝', () => {
    const seed = config.equipmentModels[0];
    expect(decideEquipmentModel({ id: 1, modelName: seed.modelName }, seed)).toBe('UNCHANGED');
    expect(decideEquipmentModel(null, seed)).toBe('CREATE');
    expect(() => decideEquipmentModel({ id: 1, modelName: '其他名称' }, seed)).toThrow(/拒绝/);
  });

  it('工单同键同归属保持 UNCHANGED（状态推进不覆盖），同键异主拒绝', () => {
    const expected = {
      customerAccountId: 11,
      equipmentModelId: 21,
      ownerOrganizationId: 31,
      serviceOrganizationId: 31,
    };
    expect(decideRepairRequest({ id: 41, ...expected }, expected, 'DEV-RR-A-001')).toBe(
      'UNCHANGED',
    );
    expect(decideRepairRequest(null, expected, 'DEV-RR-A-001')).toBe('CREATE');
    expect(() =>
      decideRepairRequest({ id: 41, ...expected, customerAccountId: 99 }, expected, 'DEV-RR-A-001'),
    ).toThrow(/拒绝/);
  });

  it('报告同键同归属保持 UNCHANGED（状态推进不覆盖），异主/异来源拒绝', () => {
    const expected = { ownerOrganizationId: 31, repairRequestId: 41 };
    expect(
      decideMaintenanceReport(
        { id: 51, ownerOrganizationId: 31, sourceType: 'WORK_ORDER_SUMMARY', repairRequestId: 41 },
        expected,
        'DEV-RR-A-001',
      ),
    ).toBe('UNCHANGED');
    expect(decideMaintenanceReport(null, expected, 'DEV-RR-A-001')).toBe('CREATE');
    expect(() =>
      decideMaintenanceReport(
        { id: 51, ownerOrganizationId: 32, sourceType: 'WORK_ORDER_SUMMARY', repairRequestId: 41 },
        expected,
        'DEV-RR-A-001',
      ),
    ).toThrow(/拒绝/);
    expect(() =>
      decideMaintenanceReport(
        { id: 51, ownerOrganizationId: 31, sourceType: 'AI_REPORT', repairRequestId: 41 },
        expected,
        'DEV-RR-A-001',
      ),
    ).toThrow(/拒绝/);
  });

  it('参考资料按 seed_key 派生引用认领，异主、异来源、异后端或命中多条拒绝', () => {
    const seed = config.referenceDocuments[0];
    const ownerId = 31;
    const reference = deriveDevSampleStorageReference(seed.seedKey);
    const identity = (overrides: Record<string, unknown> = {}) => ({
      id: 61,
      ownerOrganizationId: ownerId,
      sourceKind: 'MATERIAL',
      storageReference: reference,
      storageBackend: 'local',
      originalFilename: 'dev-reference-a.txt',
      mimeType: 'text/plain',
      ...overrides,
    });
    expect(decideReferenceDocument([identity()], [], seed, ownerId)).toBe('UNCHANGED');
    expect(decideReferenceDocument([], [], seed, ownerId)).toBe('CREATE');
    expect(() =>
      decideReferenceDocument([identity({ ownerOrganizationId: 32 })], [], seed, ownerId),
    ).toThrow(/其他公司/);
    expect(() =>
      decideReferenceDocument([identity({ sourceKind: 'REPORT_VERSION' })], [], seed, ownerId),
    ).toThrow(/MATERIAL/);
    expect(() =>
      decideReferenceDocument([identity({ storageBackend: 's3' })], [], seed, ownerId),
    ).toThrow(/存储归属/);
    expect(() =>
      decideReferenceDocument([identity(), identity({ id: 62 })], [], seed, ownerId),
    ).toThrow(/多条记录/);
  });

  it('旧现场按标题命中但引用不是 seed_key 派生值时拒绝认领也不另造', () => {
    const seed = config.referenceDocuments[0];
    const ownerId = 31;
    const legacy = {
      id: 61,
      ownerOrganizationId: ownerId,
      sourceKind: 'MATERIAL',
      storageReference: `${'ab'.repeat(16)}.txt`,
      storageBackend: 'local',
      originalFilename: 'dev-reference-a.txt',
      mimeType: 'text/plain',
    };
    expect(() => decideReferenceDocument([], [legacy], seed, ownerId)).toThrow(/旧现场/);
    expect(() =>
      decideReferenceDocument([], [{ ...legacy, ownerOrganizationId: 32 }], seed, ownerId),
    ).not.toThrow();
  });

  it('正式报告快照固定 AI 未使用，不伪造 AI 来源与评价', () => {
    const report = config.maintenanceReports[1];
    const snapshot = buildDevReportSnapshot({
      repairRequestId: 41,
      seed: report,
      equipmentModelId: 21,
      engineerAccountId: 71,
      engineerName: '开发工程师 A',
    });
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.ai).toEqual({
      usage: 'NOT_USED',
      sourceType: null,
      sourceId: null,
      sourceVersion: null,
      score: null,
      correctness: null,
      helpfulness: null,
      note: null,
    });
    expect(snapshot.steps).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/AI_REPORT|score_/);
  });
});

interface FakeReferenceRow {
  id: number;
  title: string;
  owner_organization_id: number;
  source_kind: string;
  storage_reference: string | null;
  storage_backend: string | null;
  original_filename: string | null;
  mime_type: string | null;
}

function makeReferenceManager(initial: ReadonlyArray<FakeReferenceRow>): {
  readonly manager: EntityManager;
  readonly rows: FakeReferenceRow[];
  readonly inserts: FakeReferenceRow[];
} {
  const rows = initial.map((row) => ({ ...row }));
  const inserts: FakeReferenceRow[] = [];
  let nextId = 100;
  const query = jest.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
    if (sql.includes('FROM `organization`')) {
      return [
        {
          id: 31,
          name: '开发客户 A',
          short_name: '客户A',
          kind: 'CUSTOMER',
          is_managed_company: 0,
          is_service_provider: 0,
          status: 'ACTIVE',
        },
      ];
    }
    if (sql.includes('FROM `base_user_account`')) {
      return [
        {
          id: 71,
          admin_level: null,
          identity_hint: null,
          login_email: null,
          account_status: 'ACTIVE',
          info_id: 72,
          customer_organization_id: null,
          access_group: null,
          meta_digest: null,
          user_state: 'ACTIVE',
        },
      ];
    }
    if (sql.includes('FROM `organization_membership`')) {
      return [{ member_role: 'ENGINEER', left_at: null }];
    }
    if (sql.includes('FROM `base_user_info`')) {
      return [{ nickname: '开发工程师 A', real_name: null }];
    }
    if (sql.includes('WHERE `storage_reference` = ?')) {
      return rows.filter((row) => row.storage_reference === params?.[0]).slice(0, 2);
    }
    if (sql.includes('WHERE `owner_organization_id` = ?')) {
      return rows
        .filter(
          (row) =>
            row.owner_organization_id === params?.[0] &&
            row.source_kind === 'MATERIAL' &&
            row.original_filename === params?.[1],
        )
        .slice(0, 20);
    }
    if (sql.includes('WHERE `title` = ?')) {
      return rows.filter((row) => row.title === params?.[0]).slice(0, 20);
    }
    if (sql.includes('INSERT INTO `reference_document`')) {
      const values = params ?? [];
      const row: FakeReferenceRow = {
        id: nextId,
        title: String(values[0]),
        owner_organization_id: Number(values[9]),
        source_kind: 'MATERIAL',
        storage_reference: String(values[8]),
        storage_backend: String(values[7]),
        original_filename: String(values[4]),
        mime_type: String(values[5]),
      };
      nextId += 1;
      rows.push(row);
      inserts.push(row);
      return { insertId: row.id };
    }
    throw new Error(`未预期的 SQL: ${sql}`);
  });
  return { manager: { query } as unknown as EntityManager, rows, inserts };
}

describe('参考资料稳定身份（不连接实库）', () => {
  const config = parseValid();
  const modelIds = new Map<string, number>([['DEV-MODEL-B', 21]]);

  function makeSeedDatabase(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-data-seed-'));
    const dir = path.join(root, 'lithography_dev_v13_seed');
    fs.mkdirSync(dir);
    return dir;
  }

  it('首次创建后正式改名再重跑：行数、ID、引用、文件哈希不变，标题保留且目录无新增', async () => {
    const dir = makeSeedDatabase();
    const ownership = await claimDevSampleFilesDirectory(
      dir,
      'lithography_dev_v13_seed',
      SERVER_UUID,
    );
    const seed = config.referenceDocuments[0];
    if (seed.file === null) {
      throw new Error('测试配置缺少原件');
    }
    const db = makeReferenceManager([]);

    const first = await upsertReferenceDocuments(db.manager, [seed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });
    expect(first[0]).toMatchObject({ key: seed.seedKey, outcome: 'CREATED' });
    expect(db.rows).toHaveLength(1);
    const persisted = db.rows[0];
    const reference = persisted.storage_reference;
    if (reference === null) {
      throw new Error('测试插入缺少存储引用');
    }
    const beforeFiles = fs.readdirSync(dir).sort();
    const beforeHash = sha256Of(fs.readFileSync(path.join(dir, reference)));

    persisted.title = '用户正式改名后的标题';
    const second = await upsertReferenceDocuments(db.manager, [seed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });

    expect(db.inserts).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(second[0]).toMatchObject({ key: seed.seedKey, outcome: 'UNCHANGED', id: persisted.id });
    expect(persisted.title).toBe('用户正式改名后的标题');
    expect(persisted.storage_reference).toBe(reference);
    expect(fs.readdirSync(dir).sort()).toEqual(beforeFiles);
    expect(sha256Of(fs.readFileSync(path.join(dir, reference)))).toBe(beforeHash);
  });

  it('模板标题变化但 seed_key 不变时仍按稳定引用保持不变', async () => {
    const dir = makeSeedDatabase();
    const ownership = await claimDevSampleFilesDirectory(
      dir,
      'lithography_dev_v13_seed',
      SERVER_UUID,
    );
    const seed = config.referenceDocuments[0];
    const db = makeReferenceManager([]);
    await upsertReferenceDocuments(db.manager, [seed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });
    const persisted = db.rows[0];
    const renamedSeed: DevReferenceDocumentSeed = { ...seed, title: '模板中的新标题' };
    const rerun = await upsertReferenceDocuments(db.manager, [renamedSeed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });
    expect(rerun[0]).toMatchObject({ outcome: 'UNCHANGED', id: persisted.id });
    expect(db.rows).toHaveLength(1);
    expect(persisted.title).toBe(seed.title);
  });

  it('异主命中稳定引用时拒绝且不改库、不写文件', async () => {
    const dir = makeSeedDatabase();
    const ownership = await claimDevSampleFilesDirectory(
      dir,
      'lithography_dev_v13_seed',
      SERVER_UUID,
    );
    const seed = config.referenceDocuments[0];
    const reference = deriveDevSampleStorageReference(seed.seedKey);
    const db = makeReferenceManager([
      {
        id: 61,
        title: seed.title,
        owner_organization_id: 99,
        source_kind: 'MATERIAL',
        storage_reference: reference,
        storage_backend: 'local',
        original_filename: 'dev-reference-a.txt',
        mime_type: 'text/plain',
      },
    ]);
    const before = fs.readdirSync(dir).sort();

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/其他公司/);
    expect(db.rows).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('旧验收库随机引用按标题命中时拒绝自动认领，也不重跑另造', async () => {
    const dir = makeSeedDatabase();
    const ownership = await claimDevSampleFilesDirectory(
      dir,
      'lithography_dev_v13_seed',
      SERVER_UUID,
    );
    const seed = config.referenceDocuments[0];
    const db = makeReferenceManager([
      {
        id: 61,
        title: seed.title,
        owner_organization_id: 31,
        source_kind: 'MATERIAL',
        storage_reference: `${'ab'.repeat(16)}.txt`,
        storage_backend: 'local',
        original_filename: 'dev-reference-a.txt',
        mime_type: 'text/plain',
      },
    ]);
    const before = fs.readdirSync(dir).sort();

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/旧现场/);
    expect(db.rows).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('旧现场已改名但同主同原件哈希一致时仍拒绝另造', async () => {
    const dir = makeSeedDatabase();
    const ownership = await claimDevSampleFilesDirectory(
      dir,
      'lithography_dev_v13_seed',
      SERVER_UUID,
    );
    const seed = config.referenceDocuments[0];
    if (seed.file === null) {
      throw new Error('测试配置缺少原件');
    }
    const legacyReference = `${'cd'.repeat(16)}.txt`;
    fs.writeFileSync(path.join(dir, legacyReference), seed.file.content);
    const db = makeReferenceManager([
      {
        id: 61,
        title: '旧现场已改名的标题',
        owner_organization_id: 31,
        source_kind: 'MATERIAL',
        storage_reference: legacyReference,
        storage_backend: 'local',
        original_filename: seed.file.originalFilename,
        mime_type: seed.file.mimeType,
      },
    ]);
    const before = fs.readdirSync(dir).sort();

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/旧现场/);
    expect(db.rows).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});
