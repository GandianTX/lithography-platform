// src/core/local-runtime/policy/sync-conflict-local-resolution.policy.ts

import { SYNC_ERROR } from '@core/common/errors/domain-error';
import { compareConflictVersionToRecord } from './sync-conflict-version.policy';
import {
  readConflictSnapshotBody,
  SYNC_CONFLICT_SNAPSHOT_SCHEMA_VERSION,
  type SyncConflictSnapshotBody,
} from './sync-conflict-snapshot.policy';

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
 * 信封 `{ "schema_version": 1, ..., "body": {...} }`，受控字段在 `body` 里
 * （`content_md`／`handling_result`／`closure_reason`／`maintenance`／
 * `expected_maintenance_version`）；旧契约把受控字段直接挂在信封根上，
 * 两种承载位置都认（见 `sync-conflict-snapshot.policy.ts`）。
 * - 快照里**没有**的字段一律不补、不猜（不拿当前库里的值冒充快照内容）；
 * - 快照里**类型非法**的已知字段必须被拒绝（不能当成"没有"——那会让保留本地丢掉正文）；
 * - 快照里**未知**的键一律忽略（不猜语义），但 schema_version 不符即拒绝；
 * - `process_entries`（旧过程文本）**不映射**：旧过程已只读，修订不得成为写旧过程的旁路。
 */

/** 本地快照契约版本（与冲突快照契约同版本，避免两份版本号漂移） */
export const SYNC_CONFLICT_LOCAL_SNAPSHOT_SCHEMA_VERSION = SYNC_CONFLICT_SNAPSHOT_SCHEMA_VERSION;

/**
 * 已有受控版本写入入口的资源类型。
 *
 * - `REPAIR_REQUEST`：任务 04 的工单受控修订入口（管理员动作）；
 * - `REFERENCE_DOCUMENT`：资料域管理修订入口（一级管理员动作，任务 09 第 05 项补齐）。
 *
 * 其余类型（维修报告等）没有受控修订入口 ⇒ 显式拒绝，不用"通用写库"绕过受控入口。
 */
export const LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES = [
  'REPAIR_REQUEST',
  'REFERENCE_DOCUMENT',
] as const;
export type LocalResolutionResourceType =
  (typeof LOCAL_RESOLUTION_SUPPORTED_RESOURCE_TYPES)[number];

/** 保留本地裁决的写入理由（进受控修订历史行；调用方会补上冲突 ID 以便回溯） */
export const LOCAL_RESOLUTION_REASON = '同步冲突裁决：保留本地版本';

/** 工单裁决载荷（已按受控入口的白名单字段裁剪） */
export type LocalResolutionRepairRequestPayload = {
  resourceType: 'REPAIR_REQUEST';
  /** 并发版本取数口径：冲突登记的本地版本（必须等于受控入口要求的当前版本） */
  expectedVersion: number;
  reason: string;
  contentMd?: string | null;
  handlingResult?: string | null;
  closureReason?: string | null;
  expectedMaintenanceVersion?: number | null;
  maintenance?: unknown;
};

/**
 * 资料裁决载荷（已按资料域受控入口的白名单字段裁剪）。
 *
 * 受控字段只有 **标题 `title` 与说明 `description`**：
 * - 资料正文（`content_text`）**不反写**——「保留本地」要保留的就是本地正文本身，
 *   而资料的生效正文可能来自冻结的维修报告版本（`source_kind` 指向报告），
 *   用快照里的资料自身正文覆盖会破坏冻结报告正文（读侧会回退到自身正文）；
 * - 文档类型、原件名、MIME、扩展名属于结构与原件身份，一律不参与裁决写入。
 */
export type LocalResolutionReferenceDocumentPayload = {
  resourceType: 'REFERENCE_DOCUMENT';
  expectedVersion: number;
  reason: string;
  /** 标题（本地快照登记值） */
  title?: string | null;
  /** 说明（本地快照登记值） */
  description?: string | null;
};

/** 裁决载荷（按资源类型区分的受控字段集合） */
export type LocalResolutionPayload =
  LocalResolutionRepairRequestPayload | LocalResolutionReferenceDocumentPayload;

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
      snapshot: SyncConflictSnapshotBody;
    }
  | { kind: 'reject'; code: string; message: string } {
  const read = readConflictSnapshotBody(localSnapshot, {
    invalidCode: SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
  });
  if (read.kind === 'reject') {
    return read;
  }
  return { kind: 'ok', snapshot: read.body };
}

/**
 * 读快照里的三个可选文本字段：
 * - 缺省与 null 按"没有该字段"处理；
 * - **类型非法必须被发现**（当成"没有"会让保留本地丢掉正文）。
 */
function readSnapshotFields(snapshot: SyncConflictSnapshotBody):
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
 *
 * 资源类型分流（每个类型一套受控字段，不共用一张大表）：
 * - 工单：正文／处理结果／结单原因／结构化维修记录；
 * - 资料：标题／说明（正文不反写，见 `LocalResolutionReferenceDocumentPayload`）。
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

  if (supported === 'REFERENCE_DOCUMENT') {
    return planReferenceDocumentResolution(expectedVersion, snapshotRead.snapshot);
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
      resourceType: 'REPAIR_REQUEST',
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

/**
 * 资料「保留本地」载荷映射（纯规则）。
 *
 * 字段名取业务同步 body 的 **snake_case**（`business-sync-source.service.ts`
 * 的资料分支正是这个形态）：`title` / `description` / `content_text`。
 *
 * 口径与工单分支一致：
 * - 缺省与 null 按"没有该字段"处理（不补、不猜）；
 * - 空串按"没有该字段"处理（不用空串覆盖本地已有内容）；
 * - 类型非法的已知字段必须被拒绝（当成"没有"会让保留本地丢掉标题）。
 *
 * 正文 `content_text` **不进入载荷**：保留本地＝保留本地正文本身，
 * 资料生效正文可能来自冻结的维修报告版本，反写会破坏它。
 */
function planReferenceDocumentResolution(
  expectedVersion: number,
  snapshot: SyncConflictSnapshotBody,
): LocalResolutionPlan {
  const title = readOptionalString(snapshot['title']);
  if (title.kind === 'invalid') {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照里的资料标题类型非法，不能按"没有该字段"处理',
    );
  }
  const description = readOptionalString(snapshot['description']);
  if (description.kind === 'invalid') {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照里的资料说明类型非法，不能按"没有该字段"处理',
    );
  }
  // 正文只做类型校验（快照里出现非法的正文值说明快照本身不可信），
  // 但不进入载荷：保留本地不改写资料正文。
  const contentText = readOptionalString(snapshot['content_text']);
  if (contentText.kind === 'invalid') {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照里的资料正文类型非法，不能按"没有该字段"处理',
    );
  }

  const titleValue = title.kind === 'value' && title.value !== '' ? title.value : null;
  const descriptionValue =
    description.kind === 'value' && description.value !== '' ? description.value : null;
  if (titleValue === null && descriptionValue === null) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID,
      '本地快照没有可写入的资料受控字段，拒绝空修订',
    );
  }

  return {
    kind: 'apply',
    payload: {
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion,
      reason: LOCAL_RESOLUTION_REASON,
      title: titleValue,
      description: descriptionValue,
    },
  };
}

/**
 * 「保留本地」裁决的幂等状态（review M7）。
 *
 * 背景：裁决跨三段写入——tx1 锁读规划、tx2 由来源业务受控入口写正文（自持事务）、
 * tx3 写回冲突事实。tx3 失败时**正文已写、冲突事实未改写**，此时重放同一裁决
 * 若没有幂等依据就会再写一份正文。
 *
 * 幂等键就是冲突主键 `conflict_id`（不另立键）；状态落在
 * `sync_conflict.local_resolution_state` 上：
 * - `WRITING`：正文写入已开始（尚未写回冲突事实）；
 * - `WRITTEN`：正文与冲突事实都已写回。
 */
export const localResolutionStateValues = {
  WRITING: 'WRITING',
  WRITTEN: 'WRITTEN',
} as const;

export type LocalResolutionState =
  (typeof localResolutionStateValues)[keyof typeof localResolutionStateValues];

/** 幂等裁决所需的事实 */
export type LocalResolutionReplayInput = {
  /** 冲突行记录的幂等状态；null 表示从未走过本地裁决 */
  resolutionState: string | null;
  /** 冲突登记的本地版本；null 表示历史未知 */
  localVersion: number | null;
  /** 来源记录的当前版本；null 表示取不到 */
  sourceCurrentVersion: number | null;
};

export type LocalResolutionReplayOutcome =
  /** 正常路径：需要写正文 */
  | { kind: 'write-body' }
  /** 幂等重放：正文已写，只需补写冲突事实 */
  | { kind: 'body-already-written' }
  | { kind: 'reject'; code: string; message: string };

/**
 * 裁决"这一次该不该再写正文"。
 *
 * - 幂等状态 `WRITING` 且来源版本已推进 → 正文**已经写了**（tx3 失败留下的状态）：
 *   跳过正文写入，只补写冲突事实——重放不会产生第二份正文；
 * - 幂等状态 `WRITING` 但来源版本没动 → 正文没写成（tx2 失败）：允许重试；
 * - 没有幂等状态 → 首次执行：版本条件成立才允许写；
 * - 版本条件不成立且没有幂等依据 → 拒绝（不能把"别人推进的版本"当成"我们写的"）。
 */
export function resolveLocalResolutionReplay(
  input: LocalResolutionReplayInput,
): LocalResolutionReplayOutcome {
  const state = input.resolutionState;
  const localVersion = input.localVersion;
  const currentVersion = input.sourceCurrentVersion;

  if (localVersion === null || !Number.isInteger(localVersion) || localVersion < 1) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
      '冲突没有登记可用的本地版本，无法按版本条件执行保留本地裁决',
    );
  }
  if (currentVersion === null) {
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
      '取不到来源记录的当前版本，不能判断保留本地裁决是否已写入正文',
    );
  }
  // 版本比较统一走 `compareConflictVersionToRecord`（与「使用云端」路径同一比较点）；
  // 这里只多承担一层写入编排：来源当前版本比冲突登记版本更早时同样不可写。
  const versionComparison = compareConflictVersionToRecord({
    conflictLocalVersion: localVersion,
    recordCurrentVersion: currentVersion,
    versionTrusted: true,
  });

  if (state === localResolutionStateValues.WRITTEN) {
    // 正文与冲突事实都已写回：不需要再写正文
    return { kind: 'body-already-written' };
  }

  if (state === localResolutionStateValues.WRITING) {
    if (currentVersion > localVersion) {
      // tx3 失败留下的状态：正文已写、事实未改写——只补事实
      return { kind: 'body-already-written' };
    }
    if (currentVersion === localVersion) {
      // tx2 失败：正文没写成，允许重试
      return { kind: 'write-body' };
    }
    return reject(
      SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
      '来源记录的当前版本早于冲突登记的本地版本，不能执行保留本地裁决',
    );
  }

  if (versionComparison === 'MATCH') {
    return { kind: 'write-body' };
  }
  return reject(
    SYNC_ERROR.LOCAL_RESOLUTION_VERSION_UNAVAILABLE,
    '冲突登记的本地版本已不是来源记录的当前版本，且没有本次裁决的写入记录，不能执行保留本地裁决',
  );
}
