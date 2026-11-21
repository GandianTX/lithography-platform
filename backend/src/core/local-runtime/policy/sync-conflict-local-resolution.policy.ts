// src/core/local-runtime/policy/sync-conflict-local-resolution.policy.ts

import { SYNC_ERROR } from '@core/common/errors/domain-error';

/**
 * 「保留本地」裁决的载荷映射与准入纯规则（任务 09 R-03，09 侧可独立部分）。
 *
 * 边界：
 * - R-03 原挂三点待裁定：①载荷映射 ②并发版本取数 ③权限口径。
 *   本文件给出 **09 侧可自行决定的①②**；③不新立口径——直接复用来源业务既有的受控版本
 *   写入入口（任务 04 的工单受控修订入口），由该入口自己裁决权限与公司范围，
 *   09 侧不叠加第二套权限规则（叠加只会制造两套口径）。
 * - 只有**已有受控写入入口**的资源类型才允许走 LOCAL；其余类型显式拒绝，
 *   不用"通用写库"绕过受控入口。
 *
 * 本地快照契约（冲突登记方写 `sync_conflict.local_snapshot` 时必须满足）：
 * `{ "schema_version": 1, "content_md"?, "handling_result"?, "closure_reason"?,
 *    "maintenance"?, "expected_maintenance_version"? }`
 * - 快照里**没有**的字段一律不补、不猜（不拿当前库里的值冒充快照内容）；
 * - 快照里**类型非法**的已知字段必须被拒绝（不能当成"没有"——那会让保留本地丢掉正文）；
 * - 快照里**未知**的键一律忽略（不猜语义），但 schema_version 不符即拒绝；
 * - `process_entries`（旧过程文本）**不映射**：旧过程已只读，修订不得成为写旧过程的旁路。
 */

/** 本地快照契约版本 */
export const SYNC_CONFLICT_LOCAL_SNAPSHOT_SCHEMA_VERSION = 1;

/** 已有受控版本写入入口的资源类型（任务 04 只交付了工单受控修订入口） */
export const LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES = ['REPAIR_REQUEST'] as const;
export type LocalResolutionResourceType =
  (typeof LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES)[number];

/** 保留本地裁决的写入理由（进 04 修订历史行；调用方会补上冲突 ID 以便回溯） */
export const LOCAL_RESOLUTION_REASON = '同步冲突裁决：保留本地版本';

/** 裁决载荷（已按受控入口的白名单字段裁剪） */
export type LocalResolutionPayload = {
  resourceType: LocalResolutionResourceType;
  /** 并发版本取数口径：冲突登记的本地版本（必须等于受控入口要求的当前版本） */
  expectedVersion: number;
  reason: string;
  contentMd?: string | null;
  handlingResult?: string | null;
  closureReason?: string | null;
  expectedMaintenanceVersion?: number | null;
  maintenance?: unknown;
};

export type LocalResolutionPlan =
  | { kind: 'apply'; payload: LocalResolutionPayload }
  | { kind: 'reject'; code: string; message: string };

export type LocalResolutionPlanInput = {
  /** 冲突登记的资源类型 */
  resourceType: string;
  /** 冲突登记的本地版本；null 表示历史未知 */
  localVersion: number | null;
  /** 冲突登记的本地快照 JSON 原文 */
  localSnapshot: string;
};

type OptionalStringRead =
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'value'; value: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 统一的拒绝结果（各层按自己的返回类型接收） */
const reject = (
  code: string,
  message: string,
): { kind: 'reject'; code: string; message: string } => ({
  kind: 'reject',
  code,
  message,
});

/** 可选字符串：缺省与 null 按"没有该字段"处理；类型非法单独标记 */
const readOptionalString = (value: unknown): OptionalStringRead => {
  if (value === undefined || value === null) {
    return { kind: 'absent' };
  }
  return typeof value === 'string' ? { kind: 'value', value } : { kind: 'invalid' };
};

/** 资源类型准入：没有受控写入入口的类型一律拒绝 */
function resolveSupportedResourceType(resourceType: string): LocalResolutionResourceType | null {
  return (
    LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES.find((candidate) => candidate === resourceType) ??
    null
  );
}

/** 并发版本取数：冲突登记的本地版本必须是 ≥1 的整数 */
function resolveExpectedVersion(localVersion: number | null): number | null {
  if (localVersion === null || !Number.isInteger(localVersion) || localVersion < 1) {
    return null;
  }
  return localVersion;
}

/** 读并校验本地快照契约（JSON 对象 ＋ 约定的结构版本） */
function readSnapshot(localSnapshot: string):
  | {
      kind: 'ok';
      snapshot: Record<string, unknown>;
    }
  | { kind: 'reject'; code: string; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localSnapshot);
  } catch {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照不是合法 JSON，无法映射为受控写入载荷',
    );
  }
  if (!isPlainObject(parsed)) {
    return reject(SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID, '本地快照必须是 JSON 对象');
  }
  if (parsed['schema_version'] !== SYNC_CONFLICT_LOCAL_SNAPSHOT_SCHEMA_VERSION) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照结构版本不符，不能猜测字段含义',
    );
  }
  return { kind: 'ok', snapshot: parsed };
}

/**
 * 读快照里的三个可选文本字段：
 * - 缺省与 null 按"没有该字段"处理；
 * - **类型非法必须被发现**（当成"没有"会让保留本地丢掉正文）。
 */
function readSnapshotFields(snapshot: Record<string, unknown>):
  | {
      kind: 'ok';
      contentMd: OptionalStringRead;
      handlingResult: OptionalStringRead;
      closureReason: OptionalStringRead;
      hasMaintenance: boolean;
    }
  | { kind: 'reject'; code: string; message: string } {
  const contentMd = readOptionalString(snapshot['content_md']);
  const handlingResult = readOptionalString(snapshot['handling_result']);
  const closureReason = readOptionalString(snapshot['closure_reason']);
  if (
    contentMd.kind === 'invalid' ||
    handlingResult.kind === 'invalid' ||
    closureReason.kind === 'invalid'
  ) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照里的已知字段类型非法，不能按"没有该字段"处理',
    );
  }
  const maintenanceRaw = snapshot['maintenance'];
  return {
    kind: 'ok',
    contentMd,
    handlingResult,
    closureReason,
    hasMaintenance: maintenanceRaw !== undefined && maintenanceRaw !== null,
  };
}

/**
 * 结构化维修记录载荷：给了维修记录就必须同时给出可用的维修记录版本条件，
 * 否则拒绝（不能用"当前库的版本"冒充快照里的版本条件）。
 */
function readMaintenancePlan(snapshot: Record<string, unknown>):
  | {
      kind: 'ok';
      expectedMaintenanceVersion: number | null;
      maintenance: unknown;
    }
  | { kind: 'reject'; code: string; message: string } {
  const maintenanceRaw = snapshot['maintenance'];
  if (maintenanceRaw === undefined || maintenanceRaw === null) {
    return { kind: 'ok', expectedMaintenanceVersion: null, maintenance: null };
  }
  if (!isPlainObject(maintenanceRaw)) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照的结构化维修记录必须是 JSON 对象',
    );
  }
  const versionRaw = snapshot['expected_maintenance_version'];
  if (
    versionRaw === undefined ||
    versionRaw === null ||
    !Number.isInteger(versionRaw) ||
    (versionRaw as number) < 0
  ) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '修订结构化维修记录必须同时给出可用的维修记录版本条件',
    );
  }
  return {
    kind: 'ok',
    expectedMaintenanceVersion: versionRaw as number,
    maintenance: maintenanceRaw,
  };
}

/**
 * 计算一次「保留本地」裁决的写入计划。
 *
 * 失败关闭：任何不确定的情形都返回 `reject` 并带明确错误码，不产出"看起来能用"的载荷。
 */
export function planLocalConflictResolution(input: LocalResolutionPlanInput): LocalResolutionPlan {
  const supported = resolveSupportedResourceType(input.resourceType);
  if (supported === null) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED,
      '该资源类型还没有受控版本写入入口，不能执行保留本地裁决',
    );
  }

  const expectedVersion = resolveExpectedVersion(input.localVersion);
  if (expectedVersion === null) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
      '冲突没有登记可用的本地版本，无法按版本条件执行保留本地裁决',
    );
  }

  const snapshotRead = readSnapshot(input.localSnapshot);
  if (snapshotRead.kind === 'reject') {
    return snapshotRead;
  }

  const fields = readSnapshotFields(snapshotRead.snapshot);
  if (fields.kind === 'reject') {
    return fields;
  }

  const maintenance = readMaintenancePlan(snapshotRead.snapshot);
  if (maintenance.kind === 'reject') {
    return maintenance;
  }

  const hasWritableField =
    fields.contentMd.kind !== 'absent' ||
    fields.handlingResult.kind !== 'absent' ||
    fields.closureReason.kind !== 'absent' ||
    fields.hasMaintenance;
  if (!hasWritableField) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照没有可写入的受控字段，拒绝空修订',
    );
  }

  return {
    kind: 'apply',
    payload: {
      resourceType: supported,
      expectedVersion,
      reason: LOCAL_RESOLUTION_REASON,
      contentMd: fields.contentMd.kind === 'value' ? fields.contentMd.value : null,
      handlingResult: fields.handlingResult.kind === 'value' ? fields.handlingResult.value : null,
      closureReason: fields.closureReason.kind === 'value' ? fields.closureReason.value : null,
      expectedMaintenanceVersion: maintenance.expectedMaintenanceVersion,
      maintenance: maintenance.maintenance,
    },
  };
}
