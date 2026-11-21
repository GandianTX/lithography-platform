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
 * - 快照里**未知**的键一律忽略（不猜语义），但 schema_version 不符即拒绝；
 * - `process_entries`（旧过程文本）**不映射**：旧过程已只读，修订不得成为写旧过程的旁路。
 */

/** 本地快照契约版本 */
export const SYNC_CONFLICT_LOCAL_SNAPSHOT_SCHEMA_VERSION = 1;

/** 已有受控版本写入入口的资源类型（任务 04 只交付了工单受控修订入口） */
export const LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES = ['REPAIR_REQUEST'] as const;
export type LocalResolutionResourceType =
  (typeof LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES)[number];

/** 保留本地裁决的写入理由（进 04 修订历史行） */
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 可选字符串：缺省与 null 都按"没有该字段"处理；非字符串视为非法 */
const readOptionalString = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
};

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
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '本地快照不是合法 JSON，无法映射为受控写入载荷',
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '本地快照必须是 JSON 对象',
    };
  }
  if (parsed['schema_version'] !== SYNC_CONFLICT_LOCAL_SNAPSHOT_SCHEMA_VERSION) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '本地快照结构版本不符，不能猜测字段含义',
    };
  }
  return { kind: 'ok', snapshot: parsed };
}

/**
 * 计算一次「保留本地」裁决的写入计划。
 *
 * 失败关闭：任何不确定的情形都返回 `reject` 并带明确错误码，不产出"看起来能用"的载荷。
 */
export function planLocalConflictResolution(input: LocalResolutionPlanInput): LocalResolutionPlan {
  const supported = LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES.find(
    (candidate) => candidate === input.resourceType,
  );
  if (supported === undefined) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED,
      message: '该资源类型还没有受控版本写入入口，不能执行保留本地裁决',
    };
  }

  if (
    input.localVersion === null ||
    !Number.isInteger(input.localVersion) ||
    input.localVersion < 1
  ) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
      message: '冲突没有登记可用的本地版本，无法按版本条件执行保留本地裁决',
    };
  }

  const snapshotRead = readSnapshot(input.localSnapshot);
  if (snapshotRead.kind === 'reject') {
    return snapshotRead;
  }
  const snapshot = snapshotRead.snapshot;

  const contentMd = readOptionalString(snapshot['content_md']);
  const handlingResult = readOptionalString(snapshot['handling_result']);
  const closureReason = readOptionalString(snapshot['closure_reason']);
  const maintenanceRaw = snapshot['maintenance'];
  const hasMaintenance = maintenanceRaw !== undefined && maintenanceRaw !== null;

  if (
    contentMd === undefined &&
    handlingResult === undefined &&
    closureReason === undefined &&
    !hasMaintenance
  ) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '本地快照没有可写入的受控字段，拒绝空修订',
    };
  }

  const maintenancePlan = readMaintenancePlan(snapshot);
  if (maintenancePlan.kind === 'reject') {
    return maintenancePlan;
  }

  return {
    kind: 'apply',
    payload: {
      resourceType: supported,
      expectedVersion: input.localVersion,
      reason: LOCAL_RESOLUTION_REASON,
      contentMd: contentMd ?? null,
      handlingResult: handlingResult ?? null,
      closureReason: closureReason ?? null,
      expectedMaintenanceVersion: maintenancePlan.expectedMaintenanceVersion,
      maintenance: maintenancePlan.maintenance,
    },
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
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '本地快照的结构化维修记录必须是 JSON 对象',
    };
  }
  const versionRaw = snapshot['expected_maintenance_version'];
  if (
    versionRaw === undefined ||
    versionRaw === null ||
    !Number.isInteger(versionRaw) ||
    (versionRaw as number) < 0
  ) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      message: '修订结构化维修记录必须同时给出可用的维修记录版本条件',
    };
  }
  return {
    kind: 'ok',
    expectedMaintenanceVersion: versionRaw as number,
    maintenance: maintenanceRaw,
  };
}
