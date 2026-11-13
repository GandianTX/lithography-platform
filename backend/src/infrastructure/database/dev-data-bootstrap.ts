// src/infrastructure/database/dev-data-bootstrap.ts
//
// 开发联调业务样例受控初始化。
//
// 本模块只服务显式开启的开发环境部署：在已创建的组织、管理员与开发账号之上，
// 补齐可人工验收的机型、工单、报告与参考资料。所有稳定键在写入前锁定核对，
// 已存在时只验证归属，不覆盖用户的合法编辑；同键异主直接失败关闭。
// 不生成 AI 任务、同步、备份、导入/恢复记录；参考资料可按模板附带无敏感信息的
// 纯文本原件，原件只写入目标库专属目录并回读核对字节数与哈希。

import type { EntityManager } from 'typeorm';
import {
  loadActiveMembership,
  loadBootstrapAccount,
  type BootstrapAccountFacts,
} from './bootstrap-account';
import {
  isTruthyFlag,
  lockOrganizationByCode,
  type OrganizationRow,
} from './organization-bootstrap';
import {
  DEV_SAMPLE_FILE_MAX_BYTES,
  DEV_SAMPLE_FILE_MIME_TYPE,
  type DevSampleDirectoryOwnership,
  type DevSampleFileClaim,
  type DevSampleFileSpec,
  type DevSampleFileState,
  assertSha256,
  deriveDevSampleStorageReference,
  sha256Of,
  verifyDevSampleFile,
  writeDevSampleFile,
} from './dev-sample-files';

export const DEV_DATA_CONFIRMATION = 'APPLY-DEV-DATA';

export const DEV_HANDLING_RESULTS = [
  'FIXED',
  'PART_PURCHASED',
  'PROVIDE_PLAN_SELF_EXECUTE',
  'INTERRUPTED',
  'UNREPAIRABLE',
] as const;
export type DevHandlingResult = (typeof DEV_HANDLING_RESULTS)[number];

export const DEV_ALARM_PHASE_CODES = [
  'PHASE_01',
  'PHASE_02',
  'PHASE_03',
  'PHASE_04',
  'PHASE_05',
  'PHASE_06',
  'PHASE_07',
  'PHASE_08',
  'PHASE_09',
  'PHASE_10',
] as const;
export type DevPhaseCode = (typeof DEV_ALARM_PHASE_CODES)[number];

export const DEV_ALARM_RESET_RESULTS = ['RESET_OK', 'RESET_FAILED', 'NOT_ATTEMPTED'] as const;
export type DevAlarmResetResult = (typeof DEV_ALARM_RESET_RESULTS)[number];

export const DEV_REPORT_RESET_RESULTS = ['NORMAL', 'SAME_FAULT', 'NEW_FAULT'] as const;
export type DevReportResetResult = (typeof DEV_REPORT_RESET_RESULTS)[number];

export type DevReportStatus = 'DRAFT' | 'APPROVED';

export interface DevEquipmentModelSeed {
  readonly modelCode: string;
  readonly modelName: string;
  readonly sortOrder: number;
  readonly enabled: boolean;
}

export interface DevRepairRequestSeed {
  readonly requestNo: string;
  readonly customerLoginName: string;
  readonly serviceOrganizationCode: string;
  readonly equipmentModelCode: string;
  readonly errorCode: string;
  readonly faultDescription: string;
  readonly contentMd: string;
  readonly createdAt: string;
  readonly acceptedByLoginName: string | null;
  readonly acceptedAt: string | null;
  readonly handlingResult: DevHandlingResult | null;
  readonly handlingRecordedByLoginName: string | null;
  readonly handlingRecordedAt: string | null;
  readonly handlingEndedAt: string | null;
  readonly closureReason: string | null;
}

export interface DevReportAlarmSeed {
  readonly alarmIndex: number;
  readonly alarmCode: string;
  readonly alarmDescription: string | null;
  readonly phaseCode: DevPhaseCode;
  readonly resetResult: DevAlarmResetResult;
}

export interface DevReportStepSeed {
  readonly stepNo: number;
  readonly stepCode: string;
  readonly phaseCode: DevPhaseCode;
  readonly partName: string | null;
  readonly actionText: string;
  readonly resultText: string | null;
  readonly newAlarmCode: string | null;
  readonly isValidNewBranch: boolean;
}

export interface DevMaintenanceReportSeed {
  readonly repairRequestNo: string;
  readonly ownerOrganizationCode: string;
  readonly title: string;
  readonly customerFactoryName: string;
  readonly equipmentModelCode: string;
  readonly maintenanceDate: string;
  readonly engineerLoginName: string;
  readonly createdByLoginName: string;
  readonly updatedByLoginName: string;
  readonly status: DevReportStatus;
  readonly handlingResult: DevHandlingResult | null;
  readonly resetResult: DevReportResetResult | null;
  readonly actualCause: string | null;
  readonly repairActions: string | null;
  readonly verificationResult: string | null;
  readonly supplementaryNote: string | null;
  readonly alarms: ReadonlyArray<DevReportAlarmSeed>;
  readonly steps: ReadonlyArray<DevReportStepSeed>;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly reviewerLoginName: string | null;
  readonly reviewComment: string | null;
}

export interface DevReferenceDocumentSeed {
  /** 不可变样例身份；标题只用于展示，不参与认领。 */
  readonly seedKey: string;
  readonly title: string;
  readonly documentType: string;
  readonly ownerOrganizationCode: string;
  readonly equipmentModelCode: string | null;
  readonly description: string | null;
  readonly contentText: string;
  readonly createdByLoginName: string;
  readonly file: DevSampleFileSpec | null;
}

export interface DevDataConfig {
  readonly schemaVersion: 1;
  readonly equipmentModels: ReadonlyArray<DevEquipmentModelSeed>;
  readonly repairRequests: ReadonlyArray<DevRepairRequestSeed>;
  readonly maintenanceReports: ReadonlyArray<DevMaintenanceReportSeed>;
  readonly referenceDocuments: ReadonlyArray<DevReferenceDocumentSeed>;
}

export type DevDataOutcome = 'CREATED' | 'UNCHANGED';

export interface DevDataSeedResult {
  readonly key: string;
  readonly outcome: DevDataOutcome;
  readonly id: number;
}

export interface DevReferenceFileFacts {
  readonly storageReference: string | null;
  readonly byteSize: number;
  readonly sha256: string;
  readonly state: 'CREATED' | 'ABSENT' | DevSampleFileState;
}

export interface DevReferenceDocumentResult extends DevDataSeedResult {
  readonly file: DevReferenceFileFacts | null;
}

export interface DevDataBootstrapResult {
  readonly equipmentModels: ReadonlyArray<DevDataSeedResult>;
  readonly repairRequests: ReadonlyArray<DevDataSeedResult>;
  readonly maintenanceReports: ReadonlyArray<DevDataSeedResult>;
  readonly referenceDocuments: ReadonlyArray<DevReferenceDocumentResult>;
}

export interface DevDataBootstrapOptions {
  readonly sampleFilesDir: string | null;
  /** 已核对的目标实例 UUID + 精确库名目录归属；缺失时不允许写入原件。 */
  readonly directoryOwnership?: DevSampleDirectoryOwnership | null;
  /** 本轮实际新写入的原件所有权；供事务失败后的保留报告使用。 */
  readonly createdSampleFiles?: DevSampleFileClaim[];
}

const CONFIG_KEYS = new Set([
  'schema_version',
  'equipment_models',
  'repair_requests',
  'maintenance_reports',
  'reference_documents',
]);
const EQUIPMENT_KEYS = new Set(['model_code', 'model_name', 'sort_order', 'enabled']);
const REQUEST_KEYS = new Set([
  'request_no',
  'customer_login_name',
  'service_organization_code',
  'equipment_model_code',
  'error_code',
  'fault_description',
  'content_md',
  'created_at',
  'accepted_by_login_name',
  'accepted_at',
  'handling_result',
  'handling_recorded_by_login_name',
  'handling_recorded_at',
  'handling_ended_at',
  'closure_reason',
]);
const REPORT_KEYS = new Set([
  'repair_request_no',
  'owner_organization_code',
  'title',
  'customer_factory_name',
  'equipment_model_code',
  'maintenance_date',
  'engineer_login_name',
  'created_by_login_name',
  'updated_by_login_name',
  'status',
  'handling_result',
  'reset_result',
  'actual_cause',
  'repair_actions',
  'verification_result',
  'supplementary_note',
  'alarms',
  'steps',
  'submitted_at',
  'reviewed_at',
  'reviewer_login_name',
  'review_comment',
]);
const ALARM_KEYS = new Set([
  'alarm_index',
  'alarm_code',
  'alarm_description',
  'phase_code',
  'reset_result',
]);
const STEP_KEYS = new Set([
  'step_no',
  'step_code',
  'phase_code',
  'part_name',
  'action_text',
  'result_text',
  'new_alarm_code',
  'is_valid_new_branch',
]);
const REFERENCE_KEYS = new Set([
  'seed_key',
  'title',
  'document_type',
  'owner_organization_code',
  'equipment_model_code',
  'description',
  'content_text',
  'created_by_login_name',
  'file',
]);
const REFERENCE_FILE_KEYS = new Set([
  'original_filename',
  'mime_type',
  'byte_size',
  'sha256',
  'content',
]);

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEED_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,99}$/;
const MIN_EQUIPMENT_MODELS = 2;
const MIN_REPAIR_REQUESTS = 3;
const MIN_MAINTENANCE_REPORTS = 2;
const MIN_REFERENCE_DOCUMENTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} 存在不支持的字段 ${key}`);
    }
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 缺少非空字符串字段 ${key}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${label} 字段 ${key} 超过最大长度 ${String(maxLength)}`);
  }
  return trimmed;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} 字段 ${key} 必须为字符串或省略`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} 字段 ${key} 超过最大长度 ${String(maxLength)}`);
  }
  return trimmed;
}

function readBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 字段 ${key} 必须为布尔值`);
  }
  return value;
}

function readBooleanOr(
  record: Record<string, unknown>,
  key: string,
  label: string,
  fallback: boolean,
): boolean {
  if (record[key] === undefined) {
    return fallback;
  }
  return readBoolean(record, key, label);
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 字段 ${key} 必须为 ${String(min)}-${String(max)} 的整数`);
  }
  return value;
}

function readArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label} 字段 ${key} 必须为数组`);
  }
  return value;
}

function parseTimestamp(value: string, label: string): string {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 UTC ISO 时间（例如 2026-10-08T01:30:00.000Z）`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} 不是合法时间`);
  }
  return value;
}

function parseOptionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = readOptionalString(record, key, label, 40);
  return value === null ? null : parseTimestamp(value, `${label}.${key}`);
}

function parseDateOnly(value: string, label: string): string {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} 不是合法日期`);
  }
  return value;
}

function parseEnum<T extends string>(value: unknown, allowed: ReadonlyArray<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 只接受 ${allowed.join('/')}`);
  }
  return value as T;
}

function parseEquipmentModels(value: unknown): ReadonlyArray<DevEquipmentModelSeed> {
  if (!Array.isArray(value)) {
    throw new Error('开发样例 equipment_models 必须为数组');
  }
  const seen = new Set<string>();
  return value.map((item, index): DevEquipmentModelSeed => {
    const label = `开发样例 equipment_models[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, EQUIPMENT_KEYS, label);
    const modelCode = readString(item, 'model_code', label, 50);
    if (seen.has(modelCode)) {
      throw new Error(`开发样例存在重复机型编码 ${modelCode}`);
    }
    seen.add(modelCode);
    return {
      modelCode,
      modelName: readString(item, 'model_name', label, 100),
      sortOrder: readInteger(item, 'sort_order', label, 0, 4_294_967_295),
      enabled: readBooleanOr(item, 'enabled', label, true),
    };
  });
}

function parseRepairRequests(value: unknown): ReadonlyArray<DevRepairRequestSeed> {
  if (!Array.isArray(value)) {
    throw new Error('开发样例 repair_requests 必须为数组');
  }
  const seen = new Set<string>();
  return value.map((item, index): DevRepairRequestSeed => {
    const label = `开发样例 repair_requests[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, REQUEST_KEYS, label);
    const requestNo = readString(item, 'request_no', label, 50);
    if (seen.has(requestNo)) {
      throw new Error(`开发样例存在重复工单号 ${requestNo}`);
    }
    seen.add(requestNo);

    const acceptedByLoginName = readOptionalString(item, 'accepted_by_login_name', label, 30);
    const acceptedAt = parseOptionalTimestamp(item, 'accepted_at', label);
    if ((acceptedByLoginName === null) !== (acceptedAt === null)) {
      throw new Error(`${label} 的 accepted_by_login_name 与 accepted_at 必须同时给出或同时省略`);
    }

    const handlingResult =
      item.handling_result === undefined || item.handling_result === null
        ? null
        : parseEnum(item.handling_result, DEV_HANDLING_RESULTS, `${label}.handling_result`);
    const handlingRecordedByLoginName = readOptionalString(
      item,
      'handling_recorded_by_login_name',
      label,
      30,
    );
    const handlingRecordedAt = parseOptionalTimestamp(item, 'handling_recorded_at', label);
    const handlingEndedAt = parseOptionalTimestamp(item, 'handling_ended_at', label);
    const closureReason = readOptionalString(item, 'closure_reason', label, 2000);

    if (handlingResult === null) {
      if (
        handlingRecordedByLoginName !== null ||
        handlingRecordedAt !== null ||
        handlingEndedAt !== null ||
        closureReason !== null
      ) {
        throw new Error(`${label} 未记录处理结果时不得提供处理记录人/时间/结束时间/结束原因`);
      }
    } else {
      if (acceptedByLoginName === null || acceptedAt === null) {
        throw new Error(`${label} 记录处理结果前必须先接单`);
      }
      if (handlingRecordedByLoginName === null || handlingRecordedAt === null) {
        throw new Error(`${label} 记录处理结果时必须提供记录人与记录时间`);
      }
      const status = handlingStatusOf(handlingResult);
      if (status === 'IN_PROGRESS' && handlingEndedAt !== null) {
        throw new Error(`${label} 处理中工单不得提供 handling_ended_at`);
      }
      if (status !== 'IN_PROGRESS' && handlingEndedAt === null) {
        throw new Error(`${label} 完成/未完成工单必须提供 handling_ended_at`);
      }
      if (
        (handlingResult === 'INTERRUPTED' || handlingResult === 'UNREPAIRABLE') &&
        closureReason === null
      ) {
        throw new Error(`${label} 中断或无法修复时必须提供 closure_reason`);
      }
      if (
        handlingResult !== 'INTERRUPTED' &&
        handlingResult !== 'UNREPAIRABLE' &&
        closureReason !== null
      ) {
        throw new Error(`${label} 仅中断或无法修复时允许 closure_reason`);
      }
    }

    const createdAt = parseTimestamp(
      readString(item, 'created_at', label, 40),
      `${label}.created_at`,
    );
    assertNonDecreasing(createdAt, acceptedAt, `${label}.accepted_at 不得早于 created_at`);
    assertNonDecreasing(
      acceptedAt,
      handlingRecordedAt,
      `${label}.handling_recorded_at 不得早于 accepted_at`,
    );
    assertNonDecreasing(
      handlingRecordedAt,
      handlingEndedAt,
      `${label}.handling_ended_at 不得早于 handling_recorded_at`,
    );

    return {
      requestNo,
      customerLoginName: readString(item, 'customer_login_name', label, 30),
      serviceOrganizationCode: readString(item, 'service_organization_code', label, 64),
      equipmentModelCode: readString(item, 'equipment_model_code', label, 50),
      errorCode: readString(item, 'error_code', label, 100),
      faultDescription: readString(item, 'fault_description', label, 20_000),
      contentMd: readString(item, 'content_md', label, 200_000),
      createdAt,
      acceptedByLoginName,
      acceptedAt,
      handlingResult,
      handlingRecordedByLoginName,
      handlingRecordedAt,
      handlingEndedAt,
      closureReason,
    };
  });
}

function assertNonDecreasing(earlier: string | null, later: string | null, message: string): void {
  if (earlier === null || later === null) {
    return;
  }
  if (new Date(later).getTime() < new Date(earlier).getTime()) {
    throw new Error(message);
  }
}

export function handlingStatusOf(
  result: DevHandlingResult,
): 'COMPLETED' | 'IN_PROGRESS' | 'UNRESOLVED' {
  switch (result) {
    case 'FIXED':
    case 'PART_PURCHASED':
    case 'PROVIDE_PLAN_SELF_EXECUTE':
      return 'COMPLETED';
    case 'INTERRUPTED':
      return 'IN_PROGRESS';
    case 'UNREPAIRABLE':
      return 'UNRESOLVED';
  }
}

function parseAlarms(value: unknown, label: string): ReadonlyArray<DevReportAlarmSeed> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须为数组`);
  }
  const seenIndexes = new Set<number>();
  return value.map((item, index): DevReportAlarmSeed => {
    const itemLabel = `${label}[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${itemLabel} 必须是对象`);
    }
    assertNoUnknownKeys(item, ALARM_KEYS, itemLabel);
    const alarmIndex = readInteger(item, 'alarm_index', itemLabel, 1, 8);
    if (seenIndexes.has(alarmIndex)) {
      throw new Error(`${label} 存在重复报警槽位 ${String(alarmIndex)}`);
    }
    seenIndexes.add(alarmIndex);
    return {
      alarmIndex,
      alarmCode: readString(item, 'alarm_code', itemLabel, 100),
      alarmDescription: readOptionalString(item, 'alarm_description', itemLabel, 500),
      phaseCode: parseEnum(item.phase_code, DEV_ALARM_PHASE_CODES, `${itemLabel}.phase_code`),
      resetResult: parseEnum(
        item.reset_result,
        DEV_ALARM_RESET_RESULTS,
        `${itemLabel}.reset_result`,
      ),
    };
  });
}

function parseSteps(value: unknown, label: string): ReadonlyArray<DevReportStepSeed> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须为数组`);
  }
  const seenCodes = new Set<string>();
  return value.map((item, index): DevReportStepSeed => {
    const itemLabel = `${label}[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${itemLabel} 必须是对象`);
    }
    assertNoUnknownKeys(item, STEP_KEYS, itemLabel);
    const stepNo = readInteger(item, 'step_no', itemLabel, 1, 65_535);
    if (stepNo !== index + 1) {
      throw new Error(`${label} 的 step_no 必须从 1 连续递增，期望 ${String(index + 1)}`);
    }
    const stepCode = readString(item, 'step_code', itemLabel, 64);
    if (seenCodes.has(stepCode)) {
      throw new Error(`${label} 存在重复步骤编码 ${stepCode}`);
    }
    seenCodes.add(stepCode);
    const isValidNewBranch = readBoolean(item, 'is_valid_new_branch', itemLabel);
    const newAlarmCode = readOptionalString(item, 'new_alarm_code', itemLabel, 100);
    if (isValidNewBranch && newAlarmCode === null) {
      throw new Error(`${itemLabel} 标记为新故障分支时必须提供 new_alarm_code`);
    }
    if (!isValidNewBranch && newAlarmCode !== null) {
      throw new Error(`${itemLabel} 未标记新故障分支时不得提供 new_alarm_code`);
    }
    return {
      stepNo,
      stepCode,
      phaseCode: parseEnum(item.phase_code, DEV_ALARM_PHASE_CODES, `${itemLabel}.phase_code`),
      partName: readOptionalString(item, 'part_name', itemLabel, 300),
      actionText: readString(item, 'action_text', itemLabel, 10_000),
      resultText: readOptionalString(item, 'result_text', itemLabel, 2000),
      newAlarmCode,
      isValidNewBranch,
    };
  });
}

function parseMaintenanceReports(value: unknown): ReadonlyArray<DevMaintenanceReportSeed> {
  if (!Array.isArray(value)) {
    throw new Error('开发样例 maintenance_reports 必须为数组');
  }
  const seenRequests = new Set<string>();
  return value.map((item, index): DevMaintenanceReportSeed => {
    const label = `开发样例 maintenance_reports[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, REPORT_KEYS, label);

    const repairRequestNo = readString(item, 'repair_request_no', label, 50);
    if (seenRequests.has(repairRequestNo)) {
      throw new Error(`开发样例同一工单只允许一份报告，重复 ${repairRequestNo}`);
    }
    seenRequests.add(repairRequestNo);

    const status = parseEnum(item.status, ['DRAFT', 'APPROVED'] as const, `${label}.status`);
    const handlingResult =
      item.handling_result === undefined || item.handling_result === null
        ? null
        : parseEnum(item.handling_result, DEV_HANDLING_RESULTS, `${label}.handling_result`);
    const resetResult =
      item.reset_result === undefined || item.reset_result === null
        ? null
        : parseEnum(item.reset_result, DEV_REPORT_RESET_RESULTS, `${label}.reset_result`);
    const submittedAt = parseOptionalTimestamp(item, 'submitted_at', label);
    const reviewedAt = parseOptionalTimestamp(item, 'reviewed_at', label);
    const reviewerLoginName = readOptionalString(item, 'reviewer_login_name', label, 30);
    const reviewComment = readOptionalString(item, 'review_comment', label, 2000);

    const alarms = parseAlarms(readArray(item, 'alarms', label), `${label}.alarms`);
    const steps = parseSteps(readArray(item, 'steps', label), `${label}.steps`);
    if (steps.length === 0) {
      throw new Error(`${label} 至少需要一条排查步骤`);
    }

    if (status === 'DRAFT') {
      if (submittedAt !== null || reviewedAt !== null || reviewerLoginName !== null) {
        throw new Error(`${label} 草稿不得提供提交/审核时间或审核人`);
      }
    } else {
      if (submittedAt === null || reviewedAt === null || reviewerLoginName === null) {
        throw new Error(`${label} 正式报告必须提供提交时间、审核时间与审核人`);
      }
      if (new Date(reviewedAt).getTime() < new Date(submittedAt).getTime()) {
        throw new Error(`${label}.reviewed_at 不得早于 submitted_at`);
      }
      if (handlingResult === null) {
        throw new Error(`${label} 正式报告必须提供处理结果`);
      }
      if (resetResult === null) {
        throw new Error(`${label} 正式报告必须提供复位结果`);
      }
      if (
        readOptionalString(item, 'actual_cause', label, 2000) === null ||
        readOptionalString(item, 'repair_actions', label, 10_000) === null ||
        readOptionalString(item, 'verification_result', label, 2000) === null
      ) {
        throw new Error(`${label} 正式报告必须提供实际原因、修复动作与验证结果`);
      }
    }

    const engineerLoginName = readString(item, 'engineer_login_name', label, 30);
    return {
      repairRequestNo,
      ownerOrganizationCode: readString(item, 'owner_organization_code', label, 64),
      title: readString(item, 'title', label, 200),
      customerFactoryName: readString(item, 'customer_factory_name', label, 200),
      equipmentModelCode: readString(item, 'equipment_model_code', label, 50),
      maintenanceDate: parseDateOnly(
        readString(item, 'maintenance_date', label, 10),
        `${label}.maintenance_date`,
      ),
      engineerLoginName,
      createdByLoginName:
        readOptionalString(item, 'created_by_login_name', label, 30) ?? engineerLoginName,
      updatedByLoginName:
        readOptionalString(item, 'updated_by_login_name', label, 30) ?? engineerLoginName,
      status,
      handlingResult,
      resetResult,
      actualCause: readOptionalString(item, 'actual_cause', label, 2000),
      repairActions: readOptionalString(item, 'repair_actions', label, 10_000),
      verificationResult: readOptionalString(item, 'verification_result', label, 2000),
      supplementaryNote: readOptionalString(item, 'supplementary_note', label, 10_000),
      alarms,
      steps,
      submittedAt,
      reviewedAt,
      reviewerLoginName,
      reviewComment,
    };
  });
}

/**
 * 解析单条资料的可选原件规格。
 *
 * 只接受无敏感信息的纯文本 `.txt`：模板必须同时声明字节数与 SHA-256，
 * 解析时按 UTF-8 实际字节核对，防止模板损坏或内容被替换后仍然落库。
 */
function parseReferenceFile(value: unknown, label: string): DevSampleFileSpec | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`${label}.file 必须是对象或省略`);
  }
  assertNoUnknownKeys(value, REFERENCE_FILE_KEYS, `${label}.file`);

  const originalFilename = readString(value, 'original_filename', `${label}.file`, 255);
  if (!/^[^/\\]+\.txt$/.test(originalFilename)) {
    throw new Error(`${label}.file 只允许无路径分隔符的 .txt 文件名`);
  }
  const mimeType = readString(value, 'mime_type', `${label}.file`, 127);
  if (mimeType !== DEV_SAMPLE_FILE_MIME_TYPE) {
    throw new Error(`${label}.file 的 mime_type 必须为 ${DEV_SAMPLE_FILE_MIME_TYPE}`);
  }
  const content = value.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`${label}.file 缺少非空 content`);
  }
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength > DEV_SAMPLE_FILE_MAX_BYTES) {
    throw new Error(
      `${label}.file 内容超过 ${String(DEV_SAMPLE_FILE_MAX_BYTES)} 字节上限：${String(buffer.byteLength)}`,
    );
  }
  const byteSize = readInteger(value, 'byte_size', `${label}.file`, 1, DEV_SAMPLE_FILE_MAX_BYTES);
  if (byteSize !== buffer.byteLength) {
    throw new Error(
      `${label}.file 声明的 byte_size ${String(byteSize)} 与实际 ${String(buffer.byteLength)} 不一致`,
    );
  }
  const sha256 = assertSha256(readString(value, 'sha256', `${label}.file`, 64), `${label}.file`);
  if (sha256 !== sha256Of(buffer)) {
    throw new Error(`${label}.file 声明的 sha256 与实际内容不一致`);
  }
  return { originalFilename, mimeType, byteSize, sha256, content: buffer };
}

function parseReferenceDocuments(value: unknown): ReadonlyArray<DevReferenceDocumentSeed> {
  if (!Array.isArray(value)) {
    throw new Error('开发样例 reference_documents 必须为数组');
  }
  const seen = new Set<string>();
  return value.map((item, index): DevReferenceDocumentSeed => {
    const label = `开发样例 reference_documents[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${label} 必须是对象`);
    }
    assertNoUnknownKeys(item, REFERENCE_KEYS, label);
    const ownerOrganizationCode = readString(item, 'owner_organization_code', label, 64);
    const title = readString(item, 'title', label, 255);
    const seedKey = readString(item, 'seed_key', label, 100);
    if (!SEED_KEY_PATTERN.test(seedKey)) {
      throw new Error(
        `${label}.seed_key 必须为 3-100 位小写字母、数字、点、下划线或短横线，且不得以符号开头`,
      );
    }
    if (seen.has(seedKey)) {
      throw new Error(`开发样例存在重复资料稳定键 ${seedKey}`);
    }
    seen.add(seedKey);
    const file = parseReferenceFile(item.file, label);
    if (file === null) {
      throw new Error(
        `${label}.file 必须提供：本轮只支持带原件的资料样例，无原件样例没有可证明的稳定身份`,
      );
    }
    return {
      seedKey,
      title,
      documentType: readString(item, 'document_type', label, 100),
      ownerOrganizationCode,
      equipmentModelCode: readOptionalString(item, 'equipment_model_code', label, 50),
      description: readOptionalString(item, 'description', label, 2000),
      contentText: readString(item, 'content_text', label, 200_000),
      createdByLoginName: readString(item, 'created_by_login_name', label, 30),
      file,
    };
  });
}

/** 配置是否要求写入样例原件；用于部署入口在连接数据库前校验目录参数。 */
export function containsDevSampleFiles(config: DevDataConfig): boolean {
  return config.referenceDocuments.some((entry) => entry.file !== null);
}

/**
 * 解析并校验开发联调样例文件。
 *
 * 除字段形状外，还在写入前验证计划要求的覆盖矩阵：
 * - ≥2 个机型、≥2 家公司（工单服务公司/客户账号）、≥2 条参考资料且归属两家公司；
 * - ≥3 张工单覆盖待接单/处理中/已完成；
 * - ≥2 份报告覆盖草稿/正式结果。
 */
export function parseDevDataConfig(raw: string): DevDataConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知解析错误';
    throw new Error(`开发样例文件不是合法 JSON: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('开发样例文件根节点必须是对象');
  }
  assertNoUnknownKeys(parsed, CONFIG_KEYS, '开发样例文件');
  if (parsed.schema_version !== 1) {
    throw new Error('开发样例文件 schema_version 必须为 1');
  }

  const equipmentModels = parseEquipmentModels(parsed.equipment_models);
  const repairRequests = parseRepairRequests(parsed.repair_requests);
  const maintenanceReports = parseMaintenanceReports(parsed.maintenance_reports);
  const referenceDocuments = parseReferenceDocuments(parsed.reference_documents);

  if (equipmentModels.length < MIN_EQUIPMENT_MODELS) {
    throw new Error(`开发样例至少需要 ${String(MIN_EQUIPMENT_MODELS)} 个设备机型`);
  }
  if (repairRequests.length < MIN_REPAIR_REQUESTS) {
    throw new Error(`开发样例至少需要 ${String(MIN_REPAIR_REQUESTS)} 张工单`);
  }
  if (maintenanceReports.length < MIN_MAINTENANCE_REPORTS) {
    throw new Error(`开发样例至少需要 ${String(MIN_MAINTENANCE_REPORTS)} 份维修报告`);
  }
  if (referenceDocuments.length < MIN_REFERENCE_DOCUMENTS) {
    throw new Error(`开发样例至少需要 ${String(MIN_REFERENCE_DOCUMENTS)} 条参考资料`);
  }

  const modelCodes = new Set(equipmentModels.map((entry) => entry.modelCode));
  for (const request of repairRequests) {
    if (!modelCodes.has(request.equipmentModelCode)) {
      throw new Error(
        `工单 ${request.requestNo} 引用的机型 ${request.equipmentModelCode} 未在 equipment_models 中定义`,
      );
    }
  }

  const requestsByNo = new Map(repairRequests.map((entry) => [entry.requestNo, entry]));
  for (const report of maintenanceReports) {
    const request = requestsByNo.get(report.repairRequestNo);
    if (request === undefined) {
      throw new Error(`报告引用的工单 ${report.repairRequestNo} 未在 repair_requests 中定义`);
    }
    if (report.ownerOrganizationCode !== request.serviceOrganizationCode) {
      throw new Error(
        `报告 ${report.repairRequestNo} 的归属公司 ${report.ownerOrganizationCode} 与工单服务公司 ${request.serviceOrganizationCode} 不一致`,
      );
    }
    if (report.equipmentModelCode !== request.equipmentModelCode) {
      throw new Error(
        `报告 ${report.repairRequestNo} 的机型与工单机型 ${request.equipmentModelCode} 不一致`,
      );
    }
    if (
      request.acceptedByLoginName !== null &&
      report.engineerLoginName !== request.acceptedByLoginName
    ) {
      throw new Error(
        `报告 ${report.repairRequestNo} 的工程师 ${report.engineerLoginName} 与工单接单工程师 ${request.acceptedByLoginName} 不一致`,
      );
    }
    if (report.status === 'APPROVED') {
      if (
        request.handlingResult === null ||
        handlingStatusOf(request.handlingResult) !== 'COMPLETED'
      ) {
        throw new Error(`正式报告 ${report.repairRequestNo} 只能关联已完成工单`);
      }
      if (report.handlingResult !== request.handlingResult) {
        throw new Error(`正式报告 ${report.repairRequestNo} 的处理结果与工单处理结果不一致`);
      }
    }
  }

  const statuses = new Set(
    repairRequests.map((entry) =>
      entry.acceptedByLoginName === null
        ? 'PENDING'
        : entry.handlingResult === null
          ? 'ACCEPTED'
          : handlingStatusOf(entry.handlingResult),
    ),
  );
  for (const required of ['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const) {
    if (!statuses.has(required)) {
      throw new Error(`开发样例工单必须覆盖 ${required} 状态`);
    }
  }
  const customerLogins = new Set(repairRequests.map((entry) => entry.customerLoginName));
  if (customerLogins.size < 2) {
    throw new Error('开发样例工单必须覆盖至少 2 个客户账号');
  }
  const serviceOrganizations = new Set(
    repairRequests.map((entry) => entry.serviceOrganizationCode),
  );
  if (serviceOrganizations.size < 2) {
    throw new Error('开发样例工单必须覆盖至少 2 家服务公司');
  }

  const reportStatuses = new Set(maintenanceReports.map((entry) => entry.status));
  if (!reportStatuses.has('DRAFT') || !reportStatuses.has('APPROVED')) {
    throw new Error('开发样例维修报告必须同时覆盖 DRAFT 与 APPROVED');
  }

  const documentOwners = new Set(referenceDocuments.map((entry) => entry.ownerOrganizationCode));
  if (documentOwners.size < 2) {
    throw new Error('开发样例参考资料必须覆盖至少 2 家归属公司');
  }
  for (const document of referenceDocuments) {
    if (document.equipmentModelCode !== null && !modelCodes.has(document.equipmentModelCode)) {
      throw new Error(
        `参考资料 ${document.title} 引用的机型 ${document.equipmentModelCode} 未在 equipment_models 中定义`,
      );
    }
  }

  return {
    schemaVersion: 1,
    equipmentModels,
    repairRequests,
    maintenanceReports,
    referenceDocuments,
  };
}

export interface MaintenanceReportSnapshotPayloadV2 {
  readonly schemaVersion: 2;
  readonly sourceType: 'WORK_ORDER_SUMMARY';
  readonly repairRequestId: number;
  readonly title: string;
  readonly customerFactoryName: string;
  readonly equipmentModelId: number;
  readonly equipmentModelText: null;
  readonly maintenanceDate: string;
  readonly maintenanceEngineerAccountId: number;
  readonly maintenanceEngineerName: string;
  readonly phaseFlowVersion: 1;
  readonly alarms: ReadonlyArray<{
    readonly alarmIndex: number;
    readonly alarmCode: string;
    readonly alarmDescription: string | null;
    readonly phaseCode: string;
    readonly resetResult: string;
  }>;
  readonly steps: ReadonlyArray<{
    readonly stepNo: number;
    readonly stepCode: string;
    readonly phaseCode: string;
    readonly partName: string | null;
    readonly actionText: string;
    readonly resultText: string | null;
    readonly newAlarmCode: string | null;
    readonly isValidNewBranch: boolean;
  }>;
  readonly ai: {
    readonly usage: 'NOT_USED';
    readonly sourceType: null;
    readonly sourceId: null;
    readonly sourceVersion: null;
    readonly score: null;
    readonly correctness: null;
    readonly helpfulness: null;
    readonly note: null;
  };
}

/**
 * 构建与正式送审同口径的 v2 快照；只写入真实落库事实，AI 使用固定为 NOT_USED，
 * 不伪造任何 AI 分析来源或评价。
 */
export function buildDevReportSnapshot(params: {
  readonly repairRequestId: number;
  readonly seed: DevMaintenanceReportSeed;
  readonly equipmentModelId: number;
  readonly engineerAccountId: number;
  readonly engineerName: string;
}): MaintenanceReportSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    sourceType: 'WORK_ORDER_SUMMARY',
    repairRequestId: params.repairRequestId,
    title: params.seed.title,
    customerFactoryName: params.seed.customerFactoryName,
    equipmentModelId: params.equipmentModelId,
    equipmentModelText: null,
    maintenanceDate: params.seed.maintenanceDate,
    maintenanceEngineerAccountId: params.engineerAccountId,
    maintenanceEngineerName: params.engineerName,
    phaseFlowVersion: 1,
    alarms: params.seed.alarms.map((alarm) => ({
      alarmIndex: alarm.alarmIndex,
      alarmCode: alarm.alarmCode,
      alarmDescription: alarm.alarmDescription,
      phaseCode: alarm.phaseCode,
      resetResult: alarm.resetResult,
    })),
    steps: params.seed.steps.map((step) => ({
      stepNo: step.stepNo,
      stepCode: step.stepCode,
      phaseCode: step.phaseCode,
      partName: step.partName,
      actionText: step.actionText,
      resultText: step.resultText,
      newAlarmCode: step.newAlarmCode,
      isValidNewBranch: step.isValidNewBranch,
    })),
    ai: {
      usage: 'NOT_USED',
      sourceType: null,
      sourceId: null,
      sourceVersion: null,
      score: null,
      correctness: null,
      helpfulness: null,
      note: null,
    },
  };
}

// ---------------------------------------------------------------------------
// 幂等决策：与 SQL 分离，便于离线验证“重跑不重复、不覆盖合法编辑、同键异主拒绝”。
// ---------------------------------------------------------------------------

export interface EquipmentModelFacts {
  readonly id: number;
  readonly modelName: string;
}

export function decideEquipmentModel(
  existing: EquipmentModelFacts | null,
  seed: DevEquipmentModelSeed,
): 'CREATE' | 'UNCHANGED' {
  if (existing === null) {
    return 'CREATE';
  }
  if (existing.modelName !== seed.modelName) {
    throw new Error(
      `机型编码 ${seed.modelCode} 已被名称 ${existing.modelName} 占用，拒绝按开发样例接管`,
    );
  }
  return 'UNCHANGED';
}

export interface RepairRequestIdentity {
  readonly id: number;
  readonly customerAccountId: number;
  readonly equipmentModelId: number;
  readonly ownerOrganizationId: number | null;
  readonly serviceOrganizationId: number | null;
}

export interface ExpectedRepairRequestIdentity {
  readonly customerAccountId: number;
  readonly equipmentModelId: number;
  readonly ownerOrganizationId: number;
  readonly serviceOrganizationId: number;
}

export function decideRepairRequest(
  existing: RepairRequestIdentity | null,
  expected: ExpectedRepairRequestIdentity,
  requestNo: string,
): 'CREATE' | 'UNCHANGED' {
  if (existing === null) {
    return 'CREATE';
  }
  const same =
    existing.customerAccountId === expected.customerAccountId &&
    existing.equipmentModelId === expected.equipmentModelId &&
    existing.ownerOrganizationId === expected.ownerOrganizationId &&
    existing.serviceOrganizationId === expected.serviceOrganizationId;
  if (!same) {
    throw new Error(`工单号 ${requestNo} 已被其他客户/公司/机型占用，拒绝按开发样例接管`);
  }
  return 'UNCHANGED';
}

export interface MaintenanceReportIdentity {
  readonly id: number;
  readonly ownerOrganizationId: number;
  readonly sourceType: string;
  readonly repairRequestId: number | null;
}

export function decideMaintenanceReport(
  existing: MaintenanceReportIdentity | null,
  expected: { readonly ownerOrganizationId: number; readonly repairRequestId: number },
  requestNo: string,
): 'CREATE' | 'UNCHANGED' {
  if (existing === null) {
    return 'CREATE';
  }
  const same =
    existing.ownerOrganizationId === expected.ownerOrganizationId &&
    existing.sourceType === 'WORK_ORDER_SUMMARY' &&
    existing.repairRequestId === expected.repairRequestId;
  if (!same) {
    throw new Error(`工单 ${requestNo} 已有其他归属/来源的报告，拒绝按开发样例接管`);
  }
  return 'UNCHANGED';
}

export interface ReferenceDocumentIdentity {
  readonly id: number;
  readonly ownerOrganizationId: number | null;
  readonly sourceKind: string;
  readonly storageReference: string | null;
  readonly storageBackend: string | null;
  readonly originalFilename: string | null;
  readonly mimeType: string | null;
}

/**
 * 参考资料幂等决策。
 *
 * 身份只认由 seed_key 派生的稳定存储引用；标题仅用于展示，不参与认领。
 * 若同主同标题存在旧现场（随机引用），拒绝自动认领，也拒绝另造一份；
 * 复用旧现场必须单独授权并先核实首次生成的 ID、引用与哈希。
 */
export function decideReferenceDocument(
  existingByIdentity: ReadonlyArray<ReferenceDocumentIdentity>,
  existingByTitle: ReadonlyArray<ReferenceDocumentIdentity>,
  seed: DevReferenceDocumentSeed,
  expectedOwnerOrganizationId: number,
): 'CREATE' | 'UNCHANGED' {
  const expectedReference = deriveDevSampleStorageReference(seed.seedKey);
  if (existingByIdentity.length > 1) {
    throw new Error(
      `参考资料 stable seed_key=${seed.seedKey} 的存储引用 ${expectedReference} 命中多条记录，拒绝猜测归属`,
    );
  }
  if (existingByIdentity.length === 1) {
    const row = existingByIdentity[0];
    if (row.ownerOrganizationId !== expectedOwnerOrganizationId) {
      throw new Error(`参考资料 ${seed.title} 已归属其他公司，拒绝按开发样例接管`);
    }
    if (row.sourceKind !== 'MATERIAL') {
      throw new Error(`参考资料 ${seed.title} 已存在但不是 MATERIAL，拒绝按开发样例接管`);
    }
    if (row.storageBackend !== 'local' || row.storageReference !== expectedReference) {
      throw new Error(
        `参考资料 ${seed.title} 的存储归属不是本轮 seed_key 派生的本地引用 ${expectedReference}，拒绝接管`,
      );
    }
    return 'UNCHANGED';
  }
  const legacy = existingByTitle.filter(
    (row) =>
      row.ownerOrganizationId === expectedOwnerOrganizationId &&
      row.sourceKind === 'MATERIAL' &&
      row.storageReference !== expectedReference,
  );
  if (legacy.length > 0) {
    throw new Error(
      `参考资料 ${seed.title} 命中同主旧现场（随机引用 ${legacy
        .map((row) => `${String(row.id)}:${row.storageReference ?? '(空)'}`)
        .join(', ')}），但无法证明与本轮 seed_key=${seed.seedKey} 的稳定引用对应；` +
        '拒绝自动认领，也拒绝重跑另造一份。复用旧现场需单独授权并先核实首次生成的 ID、引用与哈希',
    );
  }
  return 'CREATE';
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

interface ResolvedAccount {
  readonly id: number;
  readonly displayName: string;
  readonly role: string;
  readonly organizationId: number;
}

interface ResolvedRequest {
  readonly seed: DevRepairRequestSeed;
  readonly id: number;
  readonly customerAccountId: number;
  readonly customerOrganizationId: number;
  readonly serviceOrganizationId: number;
  readonly equipmentModelId: number;
  readonly engineerAccountId: number | null;
  readonly engineerName: string | null;
  readonly handlingStatus: 'COMPLETED' | 'IN_PROGRESS' | 'UNRESOLVED' | null;
}

function rowsOf(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error('数据库查询结果不是数组');
  }
  return value as ReadonlyArray<Record<string, unknown>>;
}

function readInsertId(result: unknown, label: string): number {
  const raw = (result as { insertId?: unknown } | null)?.insertId;
  if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'bigint') {
    throw new Error(`${label} 未返回有效自增主键`);
  }
  const text = String(raw);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} 的自增主键无效: ${text}`);
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`${label} 的自增主键超出安全整数范围: ${text}`);
  }
  return id;
}

async function loadAccountDisplayName(
  manager: EntityManager,
  accountId: number,
  loginName: string,
): Promise<string> {
  const rows = rowsOf(
    await manager.query(
      'SELECT `nickname`, `real_name` FROM `base_user_info` WHERE `account_id` = ? LIMIT 1',
      [accountId],
    ),
  );
  if (rows.length === 0) {
    throw new Error(`账号 ${loginName} 缺少用户资料，无法确认显示名称`);
  }
  const nickname = rows[0].nickname;
  const realName = rows[0].real_name;
  if (typeof realName === 'string' && realName.trim().length > 0) {
    return realName.trim();
  }
  if (typeof nickname !== 'string' || nickname.trim().length === 0) {
    throw new Error(`账号 ${loginName} 的昵称为空，无法确认显示名称`);
  }
  return nickname.trim();
}

function assertActiveAccount(
  account: BootstrapAccountFacts | null,
  loginName: string,
): asserts account is BootstrapAccountFacts {
  if (account === null) {
    throw new Error(`开发样例引用的账号 ${loginName} 不存在；请先应用开发账号映射`);
  }
  if (!account.hasUserInfo) {
    throw new Error(`账号 ${loginName} 缺少用户资料，无法确认归属`);
  }
  if (account.accountStatus !== 'ACTIVE' || account.userState !== 'ACTIVE') {
    throw new Error(`账号 ${loginName} 不是 ACTIVE，拒绝用于开发样例`);
  }
}

async function lockOrganizationById(
  manager: EntityManager,
  organizationId: number,
  label: string,
): Promise<OrganizationRow> {
  const rows = rowsOf(
    await manager.query(
      `
        SELECT \`id\`, \`name\`, \`short_name\`, \`kind\`, \`is_managed_company\`,
               \`is_service_provider\`, \`status\`
        FROM \`organization\`
        WHERE \`id\` = ?
        LIMIT 1 FOR UPDATE
      `,
      [organizationId],
    ),
  );
  if (rows.length === 0) {
    throw new Error(`${label} 引用的公司 ${String(organizationId)} 不存在`);
  }
  const row = rows[0];
  const status = String(row.status);
  if (status !== 'ACTIVE') {
    throw new Error(`${label} 引用的公司 ${String(organizationId)} 不是 ACTIVE`);
  }
  return {
    id: Number(row.id),
    name: String(row.name),
    shortName: typeof row.short_name === 'string' ? row.short_name : null,
    kind: String(row.kind),
    isManagedCompany: isTruthyFlag(row.is_managed_company),
    isServiceProvider: isTruthyFlag(row.is_service_provider),
    status,
  };
}

async function resolveCustomerAccount(
  manager: EntityManager,
  loginName: string,
): Promise<{ readonly account: ResolvedAccount; readonly organization: OrganizationRow }> {
  const account = await loadBootstrapAccount(manager, loginName);
  assertActiveAccount(account, loginName);
  if (account.customerOrganizationId === null) {
    throw new Error(`客户账号 ${loginName} 缺少资料公司，无法确认工单归属`);
  }
  const organization = await lockOrganizationById(
    manager,
    account.customerOrganizationId,
    `客户账号 ${loginName}`,
  );
  const membership = await loadActiveMembership(manager, account.id, organization.id);
  if (membership === null || membership.member_role !== 'CUSTOMER' || membership.left_at !== null) {
    throw new Error(`客户账号 ${loginName} 缺少公司 ${organization.name} 的有效 CUSTOMER 成员关系`);
  }
  return {
    account: {
      id: account.id,
      displayName: await loadAccountDisplayName(manager, account.id, loginName),
      role: 'CUSTOMER',
      organizationId: organization.id,
    },
    organization,
  };
}

async function resolveEngineerAccount(
  manager: EntityManager,
  loginName: string,
  organization: OrganizationRow,
): Promise<ResolvedAccount> {
  const account = await loadBootstrapAccount(manager, loginName);
  assertActiveAccount(account, loginName);
  const membership = await loadActiveMembership(manager, account.id, organization.id);
  if (membership === null || membership.member_role !== 'ENGINEER' || membership.left_at !== null) {
    throw new Error(
      `工程师账号 ${loginName} 缺少公司 ${organization.name} 的有效 ENGINEER 成员关系`,
    );
  }
  return {
    id: account.id,
    displayName: await loadAccountDisplayName(manager, account.id, loginName),
    role: 'ENGINEER',
    organizationId: organization.id,
  };
}

async function resolveReviewerAccount(
  manager: EntityManager,
  loginName: string,
  organization: OrganizationRow,
): Promise<ResolvedAccount> {
  const account = await loadBootstrapAccount(manager, loginName);
  assertActiveAccount(account, loginName);
  if (account.adminLevel !== 2) {
    throw new Error(`审核人 ${loginName} 不是二级管理员，拒绝作为正式报告审核人`);
  }
  const membership = await loadActiveMembership(manager, account.id, organization.id);
  if (
    membership === null ||
    membership.member_role !== 'SUPER_ADMIN' ||
    membership.left_at !== null
  ) {
    throw new Error(
      `审核人 ${loginName} 缺少公司 ${organization.name} 的有效 SUPER_ADMIN 成员关系`,
    );
  }
  return {
    id: account.id,
    displayName: await loadAccountDisplayName(manager, account.id, loginName),
    role: 'SUPER_ADMIN',
    organizationId: organization.id,
  };
}

async function requireServiceOrganization(
  manager: EntityManager,
  organizationCode: string,
): Promise<OrganizationRow> {
  const organization = await lockOrganizationByCode(manager, organizationCode);
  if (organization === null) {
    throw new Error(`开发样例引用的服务公司 ${organizationCode} 不存在`);
  }
  if (organization.status !== 'ACTIVE') {
    throw new Error(`开发样例引用的服务公司 ${organizationCode} 不是 ACTIVE`);
  }
  if (!organization.isManagedCompany || !organization.isServiceProvider) {
    throw new Error(
      `开发样例引用的服务公司 ${organizationCode} 必须同时标记 is_managed_company 与 is_service_provider`,
    );
  }
  return organization;
}

async function requireActiveOrganization(
  manager: EntityManager,
  organizationCode: string,
): Promise<OrganizationRow> {
  const organization = await lockOrganizationByCode(manager, organizationCode);
  if (organization === null) {
    throw new Error(`开发样例引用的公司 ${organizationCode} 不存在`);
  }
  if (organization.status !== 'ACTIVE') {
    throw new Error(`开发样例引用的公司 ${organizationCode} 不是 ACTIVE`);
  }
  return organization;
}

async function upsertEquipmentModels(
  manager: EntityManager,
  seeds: ReadonlyArray<DevEquipmentModelSeed>,
): Promise<{
  readonly results: ReadonlyArray<DevDataSeedResult>;
  readonly ids: ReadonlyMap<string, number>;
}> {
  const results: DevDataSeedResult[] = [];
  const ids = new Map<string, number>();
  for (const seed of seeds) {
    const rows = rowsOf(
      await manager.query(
        'SELECT `id`, `model_name` FROM `equipment_model` WHERE `model_code` = ? LIMIT 1 FOR UPDATE',
        [seed.modelCode],
      ),
    );
    const existing =
      rows.length === 0 ? null : { id: Number(rows[0].id), modelName: String(rows[0].model_name) };
    const decision = decideEquipmentModel(existing, seed);
    if (decision === 'CREATE') {
      const inserted: unknown = await manager.query(
        `
          INSERT INTO \`equipment_model\`
            (\`model_code\`, \`model_name\`, \`sort_order\`, \`enabled\`, \`created_at\`, \`updated_at\`)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        `,
        [seed.modelCode, seed.modelName, seed.sortOrder, seed.enabled ? 1 : 0],
      );
      const id = readInsertId(inserted, `机型 ${seed.modelCode}`);
      ids.set(seed.modelCode, id);
      results.push({ key: seed.modelCode, outcome: 'CREATED', id });
    } else {
      const id = existing === null ? 0 : existing.id;
      ids.set(seed.modelCode, id);
      results.push({ key: seed.modelCode, outcome: 'UNCHANGED', id });
    }
  }
  return { results, ids };
}

async function upsertRepairRequests(
  manager: EntityManager,
  seeds: ReadonlyArray<DevRepairRequestSeed>,
  modelIds: ReadonlyMap<string, number>,
): Promise<{
  readonly results: ReadonlyArray<DevDataSeedResult>;
  readonly requests: ReadonlyArray<ResolvedRequest>;
}> {
  const results: DevDataSeedResult[] = [];
  const requests: ResolvedRequest[] = [];
  for (const seed of seeds) {
    const serviceOrganization = await requireServiceOrganization(
      manager,
      seed.serviceOrganizationCode,
    );
    const customer = await resolveCustomerAccount(manager, seed.customerLoginName);
    const modelId = modelIds.get(seed.equipmentModelCode);
    if (modelId === undefined) {
      throw new Error(`工单 ${seed.requestNo} 的机型 ${seed.equipmentModelCode} 未创建`);
    }
    const engineer =
      seed.acceptedByLoginName === null
        ? null
        : await resolveEngineerAccount(manager, seed.acceptedByLoginName, serviceOrganization);
    const recorder =
      seed.handlingRecordedByLoginName === null
        ? null
        : await resolveEngineerAccount(
            manager,
            seed.handlingRecordedByLoginName,
            serviceOrganization,
          );

    const rows = rowsOf(
      await manager.query(
        `
          SELECT
            \`id\`, \`customer_account_id\`, \`equipment_model_id\`,
            \`owner_organization_id\`, \`service_organization_id\`
          FROM \`repair_request\`
          WHERE \`request_no\` = ?
          LIMIT 1 FOR UPDATE
        `,
        [seed.requestNo],
      ),
    );
    const existing =
      rows.length === 0
        ? null
        : {
            id: Number(rows[0].id),
            customerAccountId: Number(rows[0].customer_account_id),
            equipmentModelId: Number(rows[0].equipment_model_id),
            ownerOrganizationId:
              rows[0].owner_organization_id === null ? null : Number(rows[0].owner_organization_id),
            serviceOrganizationId:
              rows[0].service_organization_id === null
                ? null
                : Number(rows[0].service_organization_id),
          };
    const expected = {
      customerAccountId: customer.account.id,
      equipmentModelId: modelId,
      ownerOrganizationId: serviceOrganization.id,
      serviceOrganizationId: serviceOrganization.id,
    };
    const decision = decideRepairRequest(existing, expected, seed.requestNo);

    let requestId: number;
    if (decision === 'CREATE') {
      const handlingStatus =
        seed.handlingResult === null ? null : handlingStatusOf(seed.handlingResult);
      const closureStatus =
        handlingStatus === 'COMPLETED' || handlingStatus === 'UNRESOLVED' ? 'CLOSED' : 'OPEN';
      const inserted: unknown = await manager.query(
        `
          INSERT INTO \`repair_request\`
            (\`request_no\`, \`customer_account_id\`, \`equipment_model_id\`,
             \`error_code\`, \`fault_description\`, \`content_md\`, \`created_at\`,
             \`is_accepted\`, \`accepted_by_engineer_account_id\`, \`accepted_at\`,
             \`deprecated\`, \`deleted_at\`, \`owner_organization_id\`,
             \`handling_result\`, \`handling_status\`, \`handling_recorded_at\`,
             \`handling_recorded_by_account_id\`, \`handling_ended_at\`,
             \`intake_id\`, \`customer_organization_id\`, \`service_organization_id\`,
             \`closure_status\`, \`closed_at\`, \`closure_reason\`,
             \`current_revision_no\`, \`is_historical\`)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)
        `,
        [
          seed.requestNo,
          customer.account.id,
          modelId,
          seed.errorCode,
          seed.faultDescription,
          seed.contentMd,
          new Date(seed.createdAt),
          engineer === null ? 0 : 1,
          engineer === null ? null : engineer.id,
          seed.acceptedAt === null ? null : new Date(seed.acceptedAt),
          serviceOrganization.id,
          seed.handlingResult,
          handlingStatus,
          seed.handlingRecordedAt === null ? null : new Date(seed.handlingRecordedAt),
          recorder === null ? null : recorder.id,
          seed.handlingEndedAt === null ? null : new Date(seed.handlingEndedAt),
          customer.organization.id,
          serviceOrganization.id,
          closureStatus,
          closureStatus === 'CLOSED' && seed.handlingEndedAt !== null
            ? new Date(seed.handlingEndedAt)
            : null,
          seed.closureReason,
        ],
      );
      requestId = readInsertId(inserted, `工单 ${seed.requestNo}`);
      results.push({ key: seed.requestNo, outcome: 'CREATED', id: requestId });
    } else {
      requestId = existing === null ? 0 : existing.id;
      results.push({ key: seed.requestNo, outcome: 'UNCHANGED', id: requestId });
    }

    requests.push({
      seed,
      id: requestId,
      customerAccountId: customer.account.id,
      customerOrganizationId: customer.organization.id,
      serviceOrganizationId: serviceOrganization.id,
      equipmentModelId: modelId,
      engineerAccountId: engineer === null ? null : engineer.id,
      engineerName: engineer === null ? null : engineer.displayName,
      handlingStatus: seed.handlingResult === null ? null : handlingStatusOf(seed.handlingResult),
    });
  }
  return { results, requests };
}

async function insertReportContent(
  manager: EntityManager,
  reportId: number,
  seed: DevMaintenanceReportSeed,
): Promise<void> {
  for (const alarm of seed.alarms) {
    await manager.query(
      `
        INSERT INTO \`maintenance_report_alarm\`
          (\`report_id\`, \`alarm_index\`, \`alarm_code\`, \`alarm_description\`,
           \`phase_code\`, \`reset_result\`)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        reportId,
        alarm.alarmIndex,
        alarm.alarmCode,
        alarm.alarmDescription,
        alarm.phaseCode,
        alarm.resetResult,
      ],
    );
  }
  for (const step of seed.steps) {
    await manager.query(
      `
        INSERT INTO \`maintenance_report_step\`
          (\`report_id\`, \`step_no\`, \`step_code\`, \`phase_code\`, \`part_name\`,
           \`action_text\`, \`result_text\`, \`new_alarm_code\`, \`is_valid_new_branch\`,
           \`created_at\`, \`updated_at\`)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      `,
      [
        reportId,
        step.stepNo,
        step.stepCode,
        step.phaseCode,
        step.partName,
        step.actionText,
        step.resultText,
        step.newAlarmCode,
        step.isValidNewBranch ? 1 : 0,
      ],
    );
  }
}

async function upsertMaintenanceReports(
  manager: EntityManager,
  seeds: ReadonlyArray<DevMaintenanceReportSeed>,
  requests: ReadonlyArray<ResolvedRequest>,
  modelIds: ReadonlyMap<string, number>,
): Promise<ReadonlyArray<DevDataSeedResult>> {
  const requestByNo = new Map(requests.map((entry) => [entry.seed.requestNo, entry]));
  const results: DevDataSeedResult[] = [];

  for (const seed of seeds) {
    const ownerOrganization = await requireServiceOrganization(manager, seed.ownerOrganizationCode);
    const request = requestByNo.get(seed.repairRequestNo);
    if (request === undefined) {
      throw new Error(`报告引用的工单 ${seed.repairRequestNo} 未创建`);
    }
    if (request.serviceOrganizationId !== ownerOrganization.id) {
      throw new Error(`报告 ${seed.repairRequestNo} 的归属公司工单服务公司不一致`);
    }
    const modelId = modelIds.get(seed.equipmentModelCode);
    if (modelId === undefined || modelId !== request.equipmentModelId) {
      throw new Error(`报告 ${seed.repairRequestNo} 的机型与工单机型不一致`);
    }
    const engineer = await resolveEngineerAccount(
      manager,
      seed.engineerLoginName,
      ownerOrganization,
    );
    if (request.engineerAccountId !== null && request.engineerAccountId !== engineer.id) {
      throw new Error(`报告 ${seed.repairRequestNo} 的工程师与工单接单工程师不一致`);
    }
    const createdBy = await resolveEngineerAccount(
      manager,
      seed.createdByLoginName,
      ownerOrganization,
    );
    const updatedBy = await resolveEngineerAccount(
      manager,
      seed.updatedByLoginName,
      ownerOrganization,
    );
    const reviewer =
      seed.reviewerLoginName === null
        ? null
        : await resolveReviewerAccount(manager, seed.reviewerLoginName, ownerOrganization);

    const rows = rowsOf(
      await manager.query(
        `
          SELECT \`id\`, \`owner_organization_id\`, \`source_type\`, \`repair_request_id\`
          FROM \`maintenance_report\`
          WHERE \`repair_request_id\` = ?
          LIMIT 1 FOR UPDATE
        `,
        [request.id],
      ),
    );
    const existing =
      rows.length === 0
        ? null
        : {
            id: Number(rows[0].id),
            ownerOrganizationId: Number(rows[0].owner_organization_id),
            sourceType: String(rows[0].source_type),
            repairRequestId:
              rows[0].repair_request_id === null ? null : Number(rows[0].repair_request_id),
          };
    const decision = decideMaintenanceReport(
      existing,
      { ownerOrganizationId: ownerOrganization.id, repairRequestId: request.id },
      seed.repairRequestNo,
    );

    if (decision === 'CREATE') {
      const isApproved = seed.status === 'APPROVED';
      const inserted: unknown = await manager.query(
        `
          INSERT INTO \`maintenance_report\`
            (\`owner_organization_id\`, \`source_type\`, \`repair_request_id\`, \`title\`,
             \`customer_factory_name\`, \`equipment_model_id\`, \`equipment_model_text\`,
             \`maintenance_date\`, \`maintenance_engineer_account_id\`,
             \`maintenance_engineer_name_snapshot\`, \`phase_flow_version\`, \`status\`,
             \`current_version_no\`, \`last_submitted_at\`, \`last_reviewed_at\`,
             \`ai_usage\`, \`created_by_account_id\`, \`updated_by_account_id\`,
             \`created_at\`, \`updated_at\`, \`supplementary_note\`, \`handling_result\`,
             \`closure_reason\`, \`reset_result\`, \`actual_cause\`, \`repair_actions\`,
             \`verification_result\`, \`submission_request_id\`, \`submission_payload_hash\`)
          VALUES (?, 'WORK_ORDER_SUMMARY', ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, 'NOT_USED',
                  ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `,
        [
          ownerOrganization.id,
          request.id,
          seed.title,
          seed.customerFactoryName,
          modelId,
          seed.maintenanceDate,
          engineer.id,
          engineer.displayName,
          seed.status,
          isApproved ? 1 : 0,
          isApproved ? new Date(seed.submittedAt as string) : null,
          isApproved ? new Date(seed.reviewedAt as string) : null,
          createdBy.id,
          updatedBy.id,
          seed.supplementaryNote,
          seed.handlingResult,
          null,
          seed.resetResult,
          seed.actualCause,
          seed.repairActions,
          seed.verificationResult,
        ],
      );
      const reportId = readInsertId(inserted, `报告 ${seed.repairRequestNo}`);

      await insertReportContent(manager, reportId, seed);

      if (seed.status === 'APPROVED') {
        const snapshot = buildDevReportSnapshot({
          repairRequestId: request.id,
          seed,
          equipmentModelId: modelId,
          engineerAccountId: engineer.id,
          engineerName: engineer.displayName,
        });
        const versionResult: unknown = await manager.query(
          `
            INSERT INTO \`maintenance_report_version\`
              (\`report_id\`, \`version_no\`, \`change_kind\`, \`change_reason\`,
               \`schema_version\`, \`payload_snapshot\`, \`submitted_by_account_id\`, \`submitted_at\`)
            VALUES (?, 1, 'SUBMIT', NULL, 2, ?, ?, ?)
          `,
          [reportId, JSON.stringify(snapshot), createdBy.id, new Date(seed.submittedAt as string)],
        );
        const versionId = readInsertId(versionResult, `报告版本 ${seed.repairRequestNo}`);
        if (reviewer === null) {
          throw new Error(`正式报告 ${seed.repairRequestNo} 缺少审核人`);
        }
        await manager.query(
          `
            INSERT INTO \`maintenance_report_review\`
              (\`report_id\`, \`version_id\`, \`decision\`, \`comment\`,
               \`reviewed_by_account_id\`, \`reviewed_at\`)
            VALUES (?, ?, 'APPROVE', ?, ?, ?)
          `,
          [
            reportId,
            versionId,
            seed.reviewComment,
            reviewer.id,
            new Date(seed.reviewedAt as string),
          ],
        );
      }

      results.push({ key: seed.repairRequestNo, outcome: 'CREATED', id: reportId });
    } else {
      results.push({
        key: seed.repairRequestNo,
        outcome: 'UNCHANGED',
        id: existing === null ? 0 : existing.id,
      });
    }
  }
  return results;
}

export async function upsertReferenceDocuments(
  manager: EntityManager,
  seeds: ReadonlyArray<DevReferenceDocumentSeed>,
  modelIds: ReadonlyMap<string, number>,
  options: DevDataBootstrapOptions,
): Promise<ReadonlyArray<DevReferenceDocumentResult>> {
  const results: DevReferenceDocumentResult[] = [];
  for (const seed of seeds) {
    const ownerOrganization = await requireActiveOrganization(manager, seed.ownerOrganizationCode);
    const creator = await resolveEngineerAccount(
      manager,
      seed.createdByLoginName,
      ownerOrganization,
    );
    let modelId: number | null = null;
    if (seed.equipmentModelCode !== null) {
      const resolved = modelIds.get(seed.equipmentModelCode);
      if (resolved === undefined) {
        throw new Error(`参考资料 ${seed.title} 的机型 ${seed.equipmentModelCode} 未创建`);
      }
      modelId = resolved;
    }
    const expectedReference = deriveDevSampleStorageReference(seed.seedKey);
    const identityRows = rowsOf(
      await manager.query(
        `
          SELECT \`id\`, \`owner_organization_id\`, \`source_kind\`, \`storage_reference\`,
                 \`storage_backend\`, \`original_filename\`, \`mime_type\`
          FROM \`reference_document\`
          WHERE \`storage_reference\` = ?
          LIMIT 2 FOR UPDATE
        `,
        [expectedReference],
      ),
    ).map(toReferenceIdentity);
    const titleRows = rowsOf(
      await manager.query(
        `
          SELECT \`id\`, \`owner_organization_id\`, \`source_kind\`, \`storage_reference\`,
                 \`storage_backend\`, \`original_filename\`, \`mime_type\`
          FROM \`reference_document\`
          WHERE \`title\` = ?
          LIMIT 20 FOR UPDATE
        `,
        [seed.title],
      ),
    ).map(toReferenceIdentity);
    const decision = decideReferenceDocument(identityRows, titleRows, seed, ownerOrganization.id);
    const key = seed.seedKey;

    if (decision === 'CREATE') {
      await rejectLegacyReferenceFileSite(
        manager,
        seed,
        ownerOrganization.id,
        expectedReference,
        options.sampleFilesDir,
      );
      if (seed.file === null) {
        throw new Error(
          `参考资料 ${seed.seedKey} 未提供原件；本轮只支持带原件的资料样例，拒绝生成无稳定身份的记录`,
        );
      }
      if (options.sampleFilesDir === null) {
        throw new Error(`参考资料 ${seed.title} 声明了原件，但未提供目标库专属原件目录`);
      }
      if (!options.directoryOwnership) {
        throw new Error(
          `参考资料 ${seed.title} 的原件目录归属未确认（实例 UUID + 精确库名），拒绝写入`,
        );
      }
      const written = await writeDevSampleFile(options.sampleFilesDir, seed.file, {
        storageReference: expectedReference,
        ownership: options.directoryOwnership,
        onClaim: (claim) => options.createdSampleFiles?.push(claim),
      });
      const file: DevReferenceFileFacts = {
        storageReference: written.storageReference,
        byteSize: seed.file.byteSize,
        sha256: seed.file.sha256,
        state: 'CREATED',
      };
      const inserted: unknown = await manager.query(
        `
          INSERT INTO \`reference_document\`
            (\`title\`, \`document_type\`, \`equipment_model_id\`, \`description\`,
             \`original_filename\`, \`mime_type\`, \`content_text\`, \`storage_backend\`,
             \`storage_reference\`, \`owner_organization_id\`, \`ingest_method\`,
             \`source_submission_id\`, \`publication_status\`, \`ownership_status\`,
             \`current_revision_no\`, \`source_kind\`, \`source_report_id\`,
             \`source_report_version_id\`, \`created_by_account_id\`, \`deprecated\`,
             \`deleted_at\`, \`created_at\`, \`updated_at\`)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_DIRECT', NULL,
                  'ONLINE', 'CONFIRMED', 0, 'MATERIAL', NULL, NULL, ?, 0, NULL,
                  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        `,
        [
          seed.title,
          seed.documentType,
          modelId,
          seed.description,
          seed.file.originalFilename,
          seed.file.mimeType,
          seed.contentText,
          'local',
          file.storageReference,
          ownerOrganization.id,
          creator.id,
        ],
      );
      const id = readInsertId(inserted, `参考资料 ${seed.title}`);
      results.push({ key, outcome: 'CREATED', id, file });
    } else {
      const row = identityRows[0];
      results.push({
        key,
        outcome: 'UNCHANGED',
        id: row.id,
        file: await inspectExistingReferenceFile(
          seed,
          {
            storageReference: row.storageReference,
            originalFilename: row.originalFilename,
            mimeType: row.mimeType,
          },
          options.sampleFilesDir,
        ),
      });
    }
  }
  return results;
}

/**
 * 即使旧记录标题已被改名，也拒绝为同一份原件另造一条新资料。
 *
 * 仅在同主、MATERIAL、原件文件名一致且磁盘内容哈希与模板完全一致时判定为旧现场；
 * 无法核实的存在不参与判定。命中即要求单独授权核实首次 ID、引用与哈希。
 */
async function rejectLegacyReferenceFileSite(
  manager: EntityManager,
  seed: DevReferenceDocumentSeed,
  expectedOwnerOrganizationId: number,
  expectedReference: string,
  sampleFilesDir: string | null,
): Promise<void> {
  if (seed.file === null || sampleFilesDir === null) {
    return;
  }
  const rows = rowsOf(
    await manager.query(
      `
        SELECT \`id\`, \`owner_organization_id\`, \`source_kind\`, \`storage_reference\`,
               \`storage_backend\`, \`original_filename\`, \`mime_type\`
        FROM \`reference_document\`
        WHERE \`owner_organization_id\` = ?
          AND \`source_kind\` = 'MATERIAL'
          AND \`original_filename\` = ?
        LIMIT 20 FOR UPDATE
      `,
      [expectedOwnerOrganizationId, seed.file.originalFilename],
    ),
  ).map(toReferenceIdentity);
  for (const row of rows) {
    if (row.storageReference === null || row.storageReference === expectedReference) {
      continue;
    }
    const state = await verifyDevSampleFile(sampleFilesDir, row.storageReference, seed.file);
    if (state === 'VERIFIED') {
      throw new Error(
        `参考资料 seed_key=${seed.seedKey} 命中同主旧现场（id=${row.id}，` +
          `storageReference=${row.storageReference}，原件哈希与模板一致），但引用不是 seed_key 派生值；` +
          '拒绝自动认领，也拒绝重跑另造一份。复用旧现场需单独授权并先核实首次生成的 ID、引用与哈希',
      );
    }
  }
}

function toReferenceIdentity(row: Record<string, unknown>): ReferenceDocumentIdentity {
  return {
    id: Number(row.id),
    ownerOrganizationId:
      row.owner_organization_id === null ? null : Number(row.owner_organization_id),
    sourceKind: String(row.source_kind),
    storageReference: typeof row.storage_reference === 'string' ? row.storage_reference : null,
    storageBackend: typeof row.storage_backend === 'string' ? row.storage_backend : null,
    originalFilename: typeof row.original_filename === 'string' ? row.original_filename : null,
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : null,
  };
}

/**
 * 幂等重跑时只读取核对既有原件，不改写记录或文件。
 *
 * 模板声明了原件但既有记录没有存储引用、元数据被合法编辑或字节不一致时，
 * 一律如实报告状态，交由调用方提示人工核对；绝不覆盖用户编辑。
 */
async function inspectExistingReferenceFile(
  seed: DevReferenceDocumentSeed,
  existing: {
    readonly storageReference: string | null;
    readonly originalFilename: string | null;
    readonly mimeType: string | null;
  },
  sampleFilesDir: string | null,
): Promise<DevReferenceFileFacts | null> {
  if (seed.file === null) {
    return null;
  }
  if (existing.storageReference === null) {
    return {
      storageReference: null,
      byteSize: seed.file.byteSize,
      sha256: seed.file.sha256,
      state: 'ABSENT',
    };
  }
  if (sampleFilesDir === null) {
    throw new Error(`参考资料 ${seed.title} 已有原件，但未提供原件目录用于核对`);
  }
  const metadataMatches =
    existing.originalFilename === seed.file.originalFilename &&
    existing.mimeType === seed.file.mimeType;
  const byteState = await verifyDevSampleFile(sampleFilesDir, existing.storageReference, seed.file);
  return {
    storageReference: existing.storageReference,
    byteSize: seed.file.byteSize,
    sha256: seed.file.sha256,
    state: metadataMatches ? byteState : 'MISMATCH',
  };
}

/**
 * 应用开发联调样例。
 *
 * 调用方必须已确认开发环境与目标实例；本函数在已有事务内执行，
 * 顺序固定为 机型 → 工单 → 报告 → 参考资料，保证外键与业务归属自洽。
 */
export async function applyDevDataBootstrap(
  manager: EntityManager,
  config: DevDataConfig,
  options: DevDataBootstrapOptions = { sampleFilesDir: null },
): Promise<DevDataBootstrapResult> {
  if (containsDevSampleFiles(config) && options.sampleFilesDir === null) {
    throw new Error('开发样例声明了资料原件，必须提供目标库专属原件目录');
  }
  const { results: equipmentModels, ids: modelIds } = await upsertEquipmentModels(
    manager,
    config.equipmentModels,
  );
  const { results: repairRequests, requests } = await upsertRepairRequests(
    manager,
    config.repairRequests,
    modelIds,
  );
  const maintenanceReports = await upsertMaintenanceReports(
    manager,
    config.maintenanceReports,
    requests,
    modelIds,
  );
  const referenceDocuments = await upsertReferenceDocuments(
    manager,
    config.referenceDocuments,
    modelIds,
    options,
  );

  return {
    equipmentModels,
    repairRequests,
    maintenanceReports,
    referenceDocuments,
  };
}
