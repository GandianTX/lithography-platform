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
  decideRepairRequestIntake,
  parseDevDataConfig,
  upsertReferenceDocuments,
  upsertRepairRequests,
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

/** 在旧三张样例上追加两张带报修来源与维修明细的工单，用于关联/重跑回归。 */
function rawWithIntakeAndMaintenance(): Record<string, unknown> {
  const raw = cloneValid();
  const requests = raw.repair_requests as Array<Record<string, unknown>>;
  requests[1].intake = { record_uuid: '00000000-0000-4000-8000-000000000101' };
  requests[1].maintenance = {
    maintenance_date: '2026-10-03',
    reset_result: 'SAME_FAULT',
    supplementary_note: '步骤排查发现新故障，等待备件。',
    diagnostic_steps: [
      {
        step_no: 1,
        error_code: 'DEV-E-2001',
        part_name: '光学模组',
        action_text: '检查光路并记录报警。',
        result_code: 'UNRESOLVED',
      },
      {
        step_no: 2,
        error_code: 'DEV-E-2002',
        part_name: '真空单元',
        action_text: '检查真空压力，发现持续偏低。',
        result_code: 'NEW_FAULT',
      },
    ],
    fault_panels: [
      {
        panel_type: 'INITIAL',
        phase_code: 'PHASE_02',
        main_error: 'DEV-E-2001',
        unit_error: 'ALM-101',
        source: 'MAIN',
        error_type: 'EQUIPMENT',
        gpib_status: 'NORMAL',
        fault_status: 'ACTIVE',
        description: '曝光异常。',
        action: '检查光路。',
      },
      {
        panel_type: 'STEP_NEW_FAULT',
        step_no: 2,
        phase_code: 'PHASE_04',
        main_error: 'DEV-E-2002',
        unit_error: 'ALM-104',
        source: 'UNIT',
        error_type: 'EQUIPMENT',
        gpib_status: 'ABNORMAL',
        fault_status: 'ACTIVE',
        description: '真空压力持续偏低。',
        action: '等待备件。',
      },
    ],
  };
  requests[2].intake = { record_uuid: '00000000-0000-4000-8000-000000000102' };
  requests[2].maintenance = {
    maintenance_date: '2026-10-05',
    reset_result: 'NEW_FAULT',
    supplementary_note: '复位后出现新的对准报警。',
    diagnostic_steps: [
      {
        step_no: 1,
        error_code: 'DEV-E-3001',
        part_name: '光源',
        action_text: '更换光源并复测功率。',
        result_code: 'RESOLVED',
      },
    ],
    fault_panels: [
      {
        panel_type: 'INITIAL',
        phase_code: 'PHASE_03',
        main_error: 'DEV-E-3001',
        unit_error: 'ALM-201',
        source: 'MAIN',
        error_type: 'EQUIPMENT',
        gpib_status: 'NORMAL',
        fault_status: 'ACTIVE',
        description: '光源功率不足。',
        action: '更换光源。',
      },
      {
        panel_type: 'RESET_NEW_FAULT',
        phase_code: 'PHASE_07',
        main_error: 'DEV-E-3002',
        unit_error: 'ALM-207',
        source: 'UNIT',
        error_type: 'EQUIPMENT',
        gpib_status: 'ABNORMAL',
        fault_status: 'ACTIVE',
        description: '复位后出现新的对准报警。',
        action: '记录并交接。',
      },
    ],
  };
  return raw;
}

interface FakeSeedState {
  readonly organizations: Map<string, Record<string, unknown>>;
  readonly accounts: Map<string, Record<string, unknown>>;
  readonly memberships: Map<string, Record<string, unknown>>;
  readonly requests: Array<Record<string, unknown>>;
  readonly intakes: Array<Record<string, unknown>>;
  readonly steps: Array<Record<string, unknown>>;
  readonly panels: Array<Record<string, unknown>>;
  failOn?: string;
}

/**
 * 仅供单测使用的最小数据库替身：按固定开发账号/公司事实响应 SQL，
 * 并用内存数组记录工单、报修来源与两张维修子表，便于核对双向引用与重跑。
 */
function createSeedManager(): { manager: EntityManager; state: FakeSeedState } {
  const state: FakeSeedState = {
    organizations: new Map([
      [
        'ORG-DEV-A',
        {
          id: 31,
          name: '开发维修公司 A',
          short_name: '公司 A',
          kind: 'PEER',
          is_managed_company: 1,
          is_service_provider: 1,
          status: 'ACTIVE',
        },
      ],
      [
        'ORG-DEV-B',
        {
          id: 32,
          name: '开发维修公司 B',
          short_name: '公司 B',
          kind: 'PEER',
          is_managed_company: 1,
          is_service_provider: 1,
          status: 'ACTIVE',
        },
      ],
    ]),
    accounts: new Map([
      ['dev-customer-a1', fakeAccount(11, 31, 'CUSTOMER', '开发客户 A1')],
      ['dev-customer-a2', fakeAccount(12, 31, 'CUSTOMER', '开发客户 A2')],
      ['dev-customer-b1', fakeAccount(13, 32, 'CUSTOMER', '开发客户 B1')],
      ['dev-engineer-a', fakeAccount(51, 31, 'ENGINEER', '开发工程师 A')],
      ['dev-engineer-b', fakeAccount(52, 32, 'ENGINEER', '开发工程师 B')],
    ]),
    memberships: new Map([
      ['11:31', { member_role: 'CUSTOMER', left_at: null }],
      ['12:31', { member_role: 'CUSTOMER', left_at: null }],
      ['13:32', { member_role: 'CUSTOMER', left_at: null }],
      ['51:31', { member_role: 'ENGINEER', left_at: null }],
      ['52:32', { member_role: 'ENGINEER', left_at: null }],
    ]),
    requests: [],
    intakes: [],
    steps: [],
    panels: [],
  };
  let nextRequestId = 100;
  let nextIntakeId = 200;
  let nextStepId = 300;
  let nextPanelId = 400;

  const manager = {
    async query(sql: string, params: unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      const text = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (state.failOn !== undefined && text.includes(state.failOn.toLowerCase())) {
        throw new Error('模拟子表写入失败');
      }
      if (text.includes('from `organization`')) {
        if (text.includes('organization_code')) {
          const organization = state.organizations.get(String(params[0]));
          return organization === undefined ? [] : [organization];
        }
        const organization = [...state.organizations.values()].find(
          (row) => row.id === Number(params[0]),
        );
        return organization === undefined ? [] : [{ ...organization, status: 'ACTIVE' }];
      }
      if (text.includes('from `base_user_account`')) {
        const account = state.accounts.get(String(params[0]));
        return account === undefined ? [] : [account];
      }
      if (text.includes('from `organization_membership`')) {
        const membership = state.memberships.get(`${String(params[0])}:${String(params[1])}`);
        return membership === undefined ? [] : [membership];
      }
      if (text.includes('from `base_user_info`') && text.includes('nickname')) {
        const account = [...state.accounts.values()].find((row) => row.id === Number(params[0]));
        return account === undefined
          ? []
          : [{ nickname: account.nickname, real_name: account.real_name }];
      }
      if (text.includes('from `repair_request_intake`')) {
        const intake = state.intakes.find((row) => row.record_uuid === params[0]);
        return intake === undefined ? [] : [intake];
      }
      if (text.startsWith('select') && text.includes('from `repair_request`')) {
        const request = state.requests.find((row) => row.request_no === params[0]);
        return request === undefined ? [] : [request];
      }
      if (text.startsWith('insert into `repair_request_intake`')) {
        const id = nextIntakeId++;
        state.intakes.push({
          id,
          record_uuid: params[0],
          customer_account_id: params[1],
          customer_organization_id: params[2],
          service_organization_id: params[3],
          equipment_model_id: params[4],
          error_code: params[5],
          fault_description: params[6],
          file_id: null,
          analysis_status: 'WAITING',
          analysis_generation: 0,
          converted_request_id: null,
          deleted_at: null,
          created_at: params[7],
        });
        return { insertId: id, affectedRows: 1 };
      }
      if (text.startsWith('insert into `repair_request`')) {
        const id = nextRequestId++;
        state.requests.push({
          id,
          request_no: params[0],
          customer_account_id: params[1],
          equipment_model_id: params[2],
          error_code: params[3],
          fault_description: params[4],
          content_md: params[5],
          created_at: params[6],
          is_accepted: params[7],
          accepted_by_engineer_account_id: params[8],
          accepted_at: params[9],
          owner_organization_id: params[10],
          handling_result: params[11],
          handling_status: params[12],
          handling_recorded_at: params[13],
          handling_recorded_by_account_id: params[14],
          handling_ended_at: params[15],
          intake_id: params[16],
          customer_organization_id: params[17],
          service_organization_id: params[18],
          closure_status: params[19],
          closed_at: params[20],
          closure_reason: params[21],
          current_revision_no: 0,
          is_historical: 0,
          maintenance_date: params[22],
          maintenance_engineer_name_snapshot: params[23],
          reset_result: params[24],
          supplementary_note: params[25],
          maintenance_attachment_file_id: null,
          maintenance_version_no: params[26],
        });
        return { insertId: id, affectedRows: 1 };
      }
      if (text.startsWith('update `repair_request_intake`')) {
        const intake = state.intakes.find((row) => row.id === Number(params[1]));
        if (intake === undefined || intake.converted_request_id !== null) {
          return { affectedRows: 0 };
        }
        intake.converted_request_id = params[0];
        return { affectedRows: 1 };
      }
      if (text.startsWith('insert into `repair_request_diagnostic_step`')) {
        const id = nextStepId++;
        state.steps.push({
          id,
          request_id: params[0],
          step_no: params[1],
          error_code: params[2],
          part_name: params[3],
          action_text: params[4],
          result_code: params[5],
        });
        return { insertId: id, affectedRows: 1 };
      }
      if (text.startsWith('insert into `repair_request_fault_panel`')) {
        const id = nextPanelId++;
        state.panels.push({
          id,
          request_id: params[0],
          panel_type: params[1],
          step_id: params[2],
          phase_code: params[3],
          main_error: params[4],
          unit_error: params[5],
          source: params[6],
          error_type: params[7],
          gpib_status: params[8],
          fault_status: params[9],
          description: params[10],
          action: params[11],
        });
        return { insertId: id, affectedRows: 1 };
      }
      throw new Error(`测试替身未实现的 SQL: ${text.slice(0, 120)}`);
    },
  } as unknown as EntityManager;
  return { manager, state };
}

function fakeAccount(
  id: number,
  customerOrganizationId: number,
  role: string,
  nickname: string,
): Record<string, unknown> {
  return {
    id,
    admin_level: null,
    identity_hint: null,
    login_email: null,
    account_status: 'ACTIVE',
    info_id: id,
    customer_organization_id: role === 'CUSTOMER' ? customerOrganizationId : null,
    access_group: null,
    meta_digest: null,
    user_state: 'ACTIVE',
    nickname,
    real_name: null,
  };
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

  it('旧三张工单模板保持兼容：可省略报修来源与维修明细', () => {
    const config = parseValid();
    expect(config.repairRequests).toHaveLength(3);
    expect(config.repairRequests.every((entry) => entry.intake === null)).toBe(true);
    expect(config.repairRequests.every((entry) => entry.maintenance === null)).toBe(true);
  });

  it('新增样例可声明报修来源与维修明细，步骤新故障关联同工单步骤号', () => {
    const config = parseDevDataConfig(JSON.stringify(rawWithIntakeAndMaintenance()));
    expect(
      config.repairRequests.map((entry) =>
        entry.intake === null ? null : entry.intake.recordUuid,
      ),
    ).toEqual([
      null,
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
    ]);
    const inProgress = config.repairRequests[1].maintenance;
    expect(inProgress?.resetResult).toBe('SAME_FAULT');
    expect(inProgress?.steps.map((step) => step.resultCode)).toEqual(['UNRESOLVED', 'NEW_FAULT']);
    expect(inProgress?.panels.map((panel) => panel.panelType)).toEqual([
      'INITIAL',
      'STEP_NEW_FAULT',
    ]);
    expect(inProgress?.panels[1].stepNo).toBe(2);
  });

  it('维修明细非法组合失败关闭：未接单、步骤/面板错配、复位结果不一致', () => {
    const pending = rawWithIntakeAndMaintenance();
    const pendingRequests = pending.repair_requests as Array<Record<string, unknown>>;
    pendingRequests[0].maintenance = pendingRequests[1].maintenance;
    delete pendingRequests[1].maintenance;
    expect(() => parseDevDataConfig(JSON.stringify(pending))).toThrow(/只允许在已接单工单/);

    const wrongStep = rawWithIntakeAndMaintenance();
    const wrongStepRequests = wrongStep.repair_requests as Array<Record<string, unknown>>;
    const wrongStepMaintenance = wrongStepRequests[1].maintenance as Record<string, unknown>;
    (wrongStepMaintenance.fault_panels as Array<Record<string, unknown>>)[1].step_no = 1;
    expect(() => parseDevDataConfig(JSON.stringify(wrongStep))).toThrow(/只能引用结果为 NEW_FAULT/);

    const missingStepPanel = rawWithIntakeAndMaintenance();
    const missingStepRequests = missingStepPanel.repair_requests as Array<Record<string, unknown>>;
    const missingStepMaintenance = missingStepRequests[1].maintenance as Record<string, unknown>;
    (missingStepMaintenance.fault_panels as Array<Record<string, unknown>>).pop();
    expect(() => parseDevDataConfig(JSON.stringify(missingStepPanel))).toThrow(
      /必须提供步骤新故障面板/,
    );

    const wrongReset = rawWithIntakeAndMaintenance();
    const wrongResetRequests = wrongReset.repair_requests as Array<Record<string, unknown>>;
    const wrongResetMaintenance = wrongResetRequests[1].maintenance as Record<string, unknown>;
    wrongResetMaintenance.reset_result = 'NEW_FAULT';
    expect(() => parseDevDataConfig(JSON.stringify(wrongReset))).toThrow(/必须提供复位新故障面板/);

    const extraReset = rawWithIntakeAndMaintenance();
    const extraResetRequests = extraReset.repair_requests as Array<Record<string, unknown>>;
    const extraResetMaintenance = extraResetRequests[2].maintenance as Record<string, unknown>;
    extraResetMaintenance.reset_result = 'NORMAL';
    expect(() => parseDevDataConfig(JSON.stringify(extraReset))).toThrow(/仅复位结果为 NEW_FAULT/);
  });

  it('维修明细结构非法时失败关闭：缺初始面板、步骤号不连续、未知字段、重复来源', () => {
    const noInitial = rawWithIntakeAndMaintenance();
    const noInitialRequests = noInitial.repair_requests as Array<Record<string, unknown>>;
    const noInitialMaintenance = noInitialRequests[1].maintenance as Record<string, unknown>;
    (noInitialMaintenance.fault_panels as Array<Record<string, unknown>>).shift();
    expect(() => parseDevDataConfig(JSON.stringify(noInitial))).toThrow(/初始故障面板/);

    const gap = rawWithIntakeAndMaintenance();
    const gapRequests = gap.repair_requests as Array<Record<string, unknown>>;
    const gapMaintenance = gapRequests[1].maintenance as Record<string, unknown>;
    (gapMaintenance.diagnostic_steps as Array<Record<string, unknown>>)[1].step_no = 3;
    expect(() => parseDevDataConfig(JSON.stringify(gap))).toThrow(/连续递增/);

    const unknown = rawWithIntakeAndMaintenance();
    const unknownRequests = unknown.repair_requests as Array<Record<string, unknown>>;
    (unknownRequests[1].intake as Record<string, unknown>).extra = 'x';
    expect(() => parseDevDataConfig(JSON.stringify(unknown))).toThrow(/不支持的字段/);

    const duplicateIntake = rawWithIntakeAndMaintenance();
    const duplicateRequests = duplicateIntake.repair_requests as Array<Record<string, unknown>>;
    (duplicateRequests[2].intake as Record<string, unknown>).record_uuid = (
      duplicateRequests[1].intake as Record<string, unknown>
    ).record_uuid;
    expect(() => parseDevDataConfig(JSON.stringify(duplicateIntake))).toThrow(/重复报修来源编号/);
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
    const existing = {
      id: 41,
      customerOrganizationId: 31,
      intakeId: null,
      ...expected,
    };
    expect(decideRepairRequest(existing, expected, 'DEV-RR-A-001')).toBe('UNCHANGED');
    expect(decideRepairRequest(null, expected, 'DEV-RR-A-001')).toBe('CREATE');
    expect(() =>
      decideRepairRequest({ ...existing, customerAccountId: 99 }, expected, 'DEV-RR-A-001'),
    ).toThrow(/拒绝/);
    expect(() =>
      decideRepairRequest(
        { ...existing, intakeId: 81 },
        { ...expected, intakeId: 82 },
        'DEV-RR-A-001',
      ),
    ).toThrow(/报修来源关联已断裂/);
    expect(() =>
      decideRepairRequest(
        { ...existing, customerOrganizationId: 32 },
        { ...expected, customerOrganizationId: 31 },
        'DEV-RR-A-001',
      ),
    ).toThrow(/客户公司/);
  });

  it('报修来源同键同归属保持 UNCHANGED，已删除或异主拒绝', () => {
    const expected = {
      customerAccountId: 11,
      customerOrganizationId: 31,
      serviceOrganizationId: 31,
      equipmentModelId: 21,
    };
    const existing = { id: 71, convertedRequestId: null, deletedAt: null, ...expected };
    expect(decideRepairRequestIntake(existing, expected, 'source-a')).toBe('UNCHANGED');
    expect(decideRepairRequestIntake(null, expected, 'source-a')).toBe('CREATE');
    expect(() =>
      decideRepairRequestIntake({ ...existing, serviceOrganizationId: 32 }, expected, 'source-a'),
    ).toThrow(/占用/);
    expect(() =>
      decideRepairRequestIntake({ ...existing, deletedAt: new Date() }, expected, 'source-a'),
    ).toThrow(/逻辑删除/);
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
    await Promise.resolve();
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

describe('开发联调工单双向关联与维修子表（不连接实库）', () => {
  const modelIds = new Map<string, number>([
    ['DEV-MODEL-A', 21],
    ['DEV-MODEL-B', 22],
  ]);
  const legacyConfig = parseValid();
  const linkedConfig = parseDevDataConfig(JSON.stringify(rawWithIntakeAndMaintenance()));

  it('旧模板三张工单首次创建时不写报修来源与维修明细', async () => {
    const { manager, state } = createSeedManager();
    const result = await upsertRepairRequests(manager, legacyConfig.repairRequests, modelIds);
    expect(result.results.map((entry) => entry.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    expect(state.requests).toHaveLength(3);
    expect(state.intakes).toHaveLength(0);
    expect(state.steps).toHaveLength(0);
    expect(state.panels).toHaveLength(0);
    for (const request of state.requests) {
      expect(request.intake_id).toBeNull();
      expect(request.maintenance_version_no).toBe(0);
      expect(request.maintenance_date).toBeNull();
      expect(request.maintenance_attachment_file_id).toBeNull();
    }
  });

  it('首次创建按数据库实际 ID 双向关联，并写入维修字段与真实步骤 ID', async () => {
    const { manager, state } = createSeedManager();
    const result = await upsertRepairRequests(manager, linkedConfig.repairRequests, modelIds);
    expect(result.results.map((entry) => entry.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    expect(state.requests).toHaveLength(3);
    expect(state.intakes).toHaveLength(2);
    expect(state.steps).toHaveLength(3);
    expect(state.panels).toHaveLength(4);

    const requestB = state.requests.find((row) => row.request_no === 'DEV-RR-B-001');
    const intakeB = state.intakes.find(
      (row) => row.record_uuid === '00000000-0000-4000-8000-000000000101',
    );
    expect(requestB).toBeDefined();
    expect(intakeB).toBeDefined();
    expect(requestB?.intake_id).toBe(intakeB?.id);
    expect(intakeB?.converted_request_id).toBe(requestB?.id);
    expect(intakeB?.analysis_status).toBe('WAITING');
    expect(intakeB?.analysis_generation).toBe(0);
    expect(intakeB?.file_id).toBeNull();
    expect(requestB?.maintenance_version_no).toBe(1);
    expect(requestB?.maintenance_date).toBe('2026-10-03');
    expect(requestB?.maintenance_engineer_name_snapshot).toBe('开发工程师 B');
    expect(requestB?.reset_result).toBe('SAME_FAULT');
    expect(requestB?.supplementary_note).toBe('步骤排查发现新故障，等待备件。');
    expect(requestB?.maintenance_attachment_file_id).toBeNull();

    const step2 = state.steps.find((row) => row.request_id === requestB?.id && row.step_no === 2);
    const stepPanel = state.panels.find(
      (row) => row.request_id === requestB?.id && row.panel_type === 'STEP_NEW_FAULT',
    );
    expect(step2).toBeDefined();
    expect(stepPanel?.step_id).toBe(String(step2?.id));
    expect(stepPanel?.step_id).not.toBe('2');
    expect(stepPanel?.description).toBe('真空压力持续偏低。');

    const requestA = state.requests.find((row) => row.request_no === 'DEV-RR-A-002');
    const resetPanel = state.panels.find(
      (row) => row.request_id === requestA?.id && row.panel_type === 'RESET_NEW_FAULT',
    );
    const initialPanel = state.panels.find(
      (row) => row.request_id === requestA?.id && row.panel_type === 'INITIAL',
    );
    expect(resetPanel?.step_id).toBeNull();
    expect(initialPanel?.step_id).toBeNull();
    expect(requestA?.maintenance_date).toBe('2026-10-05');
    expect(requestA?.reset_result).toBe('NEW_FAULT');
    expect(requestA?.maintenance_engineer_name_snapshot).toBe('开发工程师 A');
  });

  it('重跑不增行、不重置接单人/状态/版本或人工编辑内容', async () => {
    const { manager, state } = createSeedManager();
    await upsertRepairRequests(manager, linkedConfig.repairRequests, modelIds);
    const requestB = state.requests.find((row) => row.request_no === 'DEV-RR-B-001');
    expect(requestB).toBeDefined();
    if (requestB === undefined) {
      throw new Error('缺少测试工单');
    }
    requestB.accepted_by_engineer_account_id = 999;
    requestB.handling_status = 'COMPLETED';
    requestB.maintenance_version_no = 9;
    requestB.supplementary_note = '人工编辑保留';
    requestB.maintenance_date = '2099-01-01';

    const result = await upsertRepairRequests(manager, linkedConfig.repairRequests, modelIds);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
    expect(state.requests).toHaveLength(3);
    expect(state.intakes).toHaveLength(2);
    expect(state.steps).toHaveLength(3);
    expect(state.panels).toHaveLength(4);
    expect(requestB.accepted_by_engineer_account_id).toBe(999);
    expect(requestB.handling_status).toBe('COMPLETED');
    expect(requestB.maintenance_version_no).toBe(9);
    expect(requestB.supplementary_note).toBe('人工编辑保留');
    expect(requestB.maintenance_date).toBe('2099-01-01');
  });

  it('同键异主或双向引用不一致时整批失败', async () => {
    const owner = createSeedManager();
    await upsertRepairRequests(owner.manager, linkedConfig.repairRequests, modelIds);
    const ownerRequest = owner.state.requests.find((row) => row.request_no === 'DEV-RR-B-001');
    if (ownerRequest === undefined) {
      throw new Error('缺少测试工单');
    }
    ownerRequest.customer_account_id = 99;
    await expect(
      upsertRepairRequests(owner.manager, linkedConfig.repairRequests, modelIds),
    ).rejects.toThrow(/占用|客户公司/);

    const intakeOwner = createSeedManager();
    await upsertRepairRequests(intakeOwner.manager, linkedConfig.repairRequests, modelIds);
    const intake = intakeOwner.state.intakes.find(
      (row) => row.record_uuid === '00000000-0000-4000-8000-000000000101',
    );
    if (intake === undefined) {
      throw new Error('缺少测试报修来源');
    }
    intake.service_organization_id = 999;
    await expect(
      upsertRepairRequests(intakeOwner.manager, linkedConfig.repairRequests, modelIds),
    ).rejects.toThrow(/占用/);

    const brokenLink = createSeedManager();
    await upsertRepairRequests(brokenLink.manager, linkedConfig.repairRequests, modelIds);
    const brokenIntake = brokenLink.state.intakes.find(
      (row) => row.record_uuid === '00000000-0000-4000-8000-000000000101',
    );
    if (brokenIntake === undefined) {
      throw new Error('缺少测试报修来源');
    }
    brokenIntake.converted_request_id = 999;
    await expect(
      upsertRepairRequests(brokenLink.manager, linkedConfig.repairRequests, modelIds),
    ).rejects.toThrow(/双向关联不一致/);

    const missingIntake = createSeedManager();
    await upsertRepairRequests(missingIntake.manager, linkedConfig.repairRequests, modelIds);
    const missingIntakeRequest = missingIntake.state.requests.find(
      (row) => row.request_no === 'DEV-RR-B-001',
    );
    if (missingIntakeRequest === undefined) {
      throw new Error('缺少测试工单');
    }
    missingIntakeRequest.intake_id = null;
    await expect(
      upsertRepairRequests(missingIntake.manager, linkedConfig.repairRequests, modelIds),
    ).rejects.toThrow(/报修来源关联已断裂/);
  });

  it('维修子表写入失败时向上抛出，不返回半成功结果', async () => {
    const { manager, state } = createSeedManager();
    state.failOn = '`repair_request_fault_panel`';
    // 事务由 database:deploy 持有；这里验证失败向上传播，令调用方整批回滚。
    await expect(
      upsertRepairRequests(manager, linkedConfig.repairRequests, modelIds),
    ).rejects.toThrow(/模拟子表写入失败/);
    expect(state.requests.map((row) => row.request_no)).toEqual(['DEV-RR-A-001', 'DEV-RR-B-001']);
    expect(state.intakes).toHaveLength(1);
    expect(state.steps).toHaveLength(2);
    expect(state.panels).toHaveLength(0);
  });
});

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
    await ownership.close();
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
    await ownership.close();
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
    await ownership.close();
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
    await ownership.close();
  });

  function replaceConfiguredDirectory(dir: string): string {
    const claimed = `${dir}.claimed`;
    fs.renameSync(dir, claimed);
    fs.mkdirSync(dir);
    return claimed;
  }

  it('旧资料识别：配置路径被替换后即使外部文件哈希相同也拒绝核验通过', async () => {
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
    const legacyReference = `${'ef'.repeat(16)}.txt`;
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
    const replaced = replaceConfiguredDirectory(dir);
    // 替换后的配置路径放置字节与哈希完全一致的文件，旧实现会按绝对路径读取并判定已核验。
    fs.writeFileSync(path.join(dir, legacyReference), seed.file.content);

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/配置路径已指向其他目录/);
    expect(db.inserts).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([legacyReference]);
    expect(fs.readFileSync(path.join(dir, legacyReference))).toEqual(seed.file.content);
    expect(fs.readdirSync(replaced)).toContain(legacyReference);
    await ownership.close();
  });

  it('旧资料识别：原件为符号链接时拒绝，不按目标文件哈希当作已核验', async () => {
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
    const legacyReference = `${'ef'.repeat(16)}.txt`;
    const outside = path.join(path.dirname(dir), 'outside-sample.txt');
    fs.writeFileSync(outside, seed.file.content);
    fs.symlinkSync(outside, path.join(dir, legacyReference));
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

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/符号链接/);
    expect(db.inserts).toHaveLength(0);
    expect(fs.lstatSync(path.join(dir, legacyReference)).isSymbolicLink()).toBe(true);
    await ownership.close();
  });

  it('健康重跑：配置路径被替换后即使外部文件哈希相同也拒绝核验通过', async () => {
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
    const reference = deriveDevSampleStorageReference(seed.seedKey);
    fs.writeFileSync(path.join(dir, reference), seed.file.content);
    const db = makeReferenceManager([
      {
        id: 61,
        title: seed.title,
        owner_organization_id: 31,
        source_kind: 'MATERIAL',
        storage_reference: reference,
        storage_backend: 'local',
        original_filename: seed.file.originalFilename,
        mime_type: seed.file.mimeType,
      },
    ]);
    const replaced = replaceConfiguredDirectory(dir);
    fs.writeFileSync(path.join(dir, reference), seed.file.content);

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/配置路径已指向其他目录/);
    expect(db.inserts).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([reference]);
    expect(fs.readdirSync(replaced)).toContain(reference);
    await ownership.close();
  });

  it('健康重跑：既有原件为符号链接时拒绝，不按目标文件哈希判定 VERIFIED', async () => {
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
    const reference = deriveDevSampleStorageReference(seed.seedKey);
    const outside = path.join(path.dirname(dir), 'outside-sample.txt');
    fs.writeFileSync(outside, seed.file.content);
    fs.symlinkSync(outside, path.join(dir, reference));
    const db = makeReferenceManager([
      {
        id: 61,
        title: seed.title,
        owner_organization_id: 31,
        source_kind: 'MATERIAL',
        storage_reference: reference,
        storage_backend: 'local',
        original_filename: seed.file.originalFilename,
        mime_type: seed.file.mimeType,
      },
    ]);

    await expect(
      upsertReferenceDocuments(db.manager, [seed], modelIds, {
        sampleFilesDir: dir,
        directoryOwnership: ownership,
      }),
    ).rejects.toThrow(/符号链接/);
    expect(fs.lstatSync(path.join(dir, reference)).isSymbolicLink()).toBe(true);
    await ownership.close();
  });

  it('正常健康重跑：既有引用与文件一致时报告 VERIFIED，不改库也不改文件', async () => {
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
    await upsertReferenceDocuments(db.manager, [seed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });
    const persisted = db.rows[0];
    const reference = persisted.storage_reference;
    if (reference === null) {
      throw new Error('测试插入缺少存储引用');
    }
    const beforeFiles = fs.readdirSync(dir).sort();
    const beforeHash = sha256Of(fs.readFileSync(path.join(dir, reference)));

    const rerun = await upsertReferenceDocuments(db.manager, [seed], modelIds, {
      sampleFilesDir: dir,
      directoryOwnership: ownership,
    });

    expect(rerun[0]).toMatchObject({ outcome: 'UNCHANGED', id: persisted.id });
    expect(rerun[0].file).toMatchObject({ state: 'VERIFIED', storageReference: reference });
    expect(db.inserts).toHaveLength(1);
    expect(fs.readdirSync(dir).sort()).toEqual(beforeFiles);
    expect(sha256Of(fs.readFileSync(path.join(dir, reference)))).toBe(beforeHash);
    await ownership.close();
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
    await ownership.close();
  });
});
