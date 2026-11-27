// src/core/local-runtime/policy/sync-conflict-readonly-view.policy.ts

/**
 * 「已结单冲突采用云端」的**来源页只读投影**计划（任务 09 P1-4）。
 *
 * 缺陷背景（P1-4）：已结单工单的冲突「使用云端」走**只读采用**分支——
 * **不写业务记录、不改历史**（R066／R068）。但旧实现只把冲突行的 `local_version`
 * 推到云端版本，**既没写 `repair_request`，也没让来源页读到云端内容** ⇒
 * 用户选完"使用云端"、点"打开来源页"，看到的仍是**本地旧内容**。
 *
 * 口径：投影只发生在**读取时**；业务表一个字节都不动，历史不新增；
 * 不授予额外写权；`local_snapshot` 原样保留；
 * 呈现的是用户确认过的那个**点时云端快照**，不是实时拉取。
 *
 * 怎么区分"只读采用"与"业务对齐"（**不新增数据库列**）：
 * 比对**业务行当前的受控字段**与**冲突登记的本地快照**——
 * 只读采用 ⇒ 业务行没被这次裁决改过 ⇒ 两者一致 ⇒ 可投影；
 * 业务对齐 ⇒ 业务行已按云端改写 ⇒ 不一致 ⇒ 不投影（此时来源页本就是云端内容）；
 * 用户裁决后又自行编辑 ⇒ 不一致 ⇒ 不投影（不得用旧云端快照盖掉用户新编辑）。
 *
 * 为什么不拿版本号比：`local_version` 与 `cloud_version` 来自**两个不同序列**，
 * 大小不可比 ⇒ 不能用 `localVersion < cloudVersion` 当标记。
 *
 * 失败关闭：任何不确定情形都返回 `none`（不投影）。
 */

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { resolveRepairRequestHandlingStatus } from '@core/repair-request/policy/repair-request-handling.policy';

import { readConflictSnapshotBody } from './sync-conflict-snapshot.policy';

/** 受控字段（与工单对齐口径一致） */
export type SyncConflictRepairRequestControlledFields = {
  contentMd: string | null;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
};

/** 投影输入（全部来自服务端登记事实，不信任客户端） */
export type SyncConflictReadOnlyCloudViewInput = {
  resourceType: string;
  decision: string | null;
  status: string;
  localSnapshot: string;
  cloudSnapshot: string;
  sourceFields: SyncConflictRepairRequestControlledFields;
  sourceClosed: boolean;
};

/** 投影计划 */
export type SyncConflictReadOnlyCloudViewPlan =
  | { kind: 'none'; reason: string }
  | {
      kind: 'project';
      fields: SyncConflictRepairRequestControlledFields;
    };

const HANDLING_RESULT_VALUES: ReadonlySet<string> = new Set(
  Object.values(RepairRequestHandlingResult) as string[],
);
const HANDLING_STATUS_VALUES: ReadonlySet<string> = new Set(
  Object.values(RepairRequestHandlingStatus) as string[],
);

const none = (reason: string): SyncConflictReadOnlyCloudViewPlan => ({
  kind: 'none',
  reason,
});

/**
 * 计算来源页的只读云端投影计划（纯函数）。
 *
 * 只有**同时**满足下列条件才投影：
 * 1. 资源类型是工单；
 * 2. 冲突已裁决为「使用云端」且已 resolved；
 * 3. 来源记录已结单；
 * 4. 业务行当前受控字段与冲突登记的本地快照一致
 *    ⇒ 证明这次裁决**没有改写业务行**（只读采用），而不是用户后来又编辑过；
 * 5. 云端快照可解析且受控字段自洽。
 */
export function planReadOnlyCloudAdoptedView(
  input: SyncConflictReadOnlyCloudViewInput,
): SyncConflictReadOnlyCloudViewPlan {
  if (input.resourceType !== 'REPAIR_REQUEST') {
    return none('该资源类型没有只读云端投影口径');
  }
  if (input.decision !== 'CLOUD' || input.status !== 'RESOLVED') {
    return none('该冲突没有裁决为使用云端');
  }
  if (!input.sourceClosed) {
    return none('来源记录未结单（走的是业务对齐口径，不需要只读投影）');
  }

  const localSnapshot = readConflictSnapshotBody(input.localSnapshot, {
    invalidCode: 'CONFLICT_SNAPSHOT_INVALID',
  });
  if (localSnapshot.kind === 'reject') {
    return none('冲突登记的本地快照不可解析');
  }
  const cloudSnapshot = readConflictSnapshotBody(input.cloudSnapshot, {
    invalidCode: 'CONFLICT_SNAPSHOT_INVALID',
  });
  if (cloudSnapshot.kind === 'reject') {
    return none('冲突登记的云端快照不可解析');
  }

  const localFields = readControlledFields(localSnapshot.body);
  if (localFields === null) {
    return none('冲突登记的本地快照没有可比的受控字段');
  }
  if (!sameControlledFields(localFields, input.sourceFields)) {
    return none('业务行内容已不是冲突登记时的本地内容，不做只读投影');
  }

  const cloudFields = readControlledFields(cloudSnapshot.body);
  if (cloudFields === null) {
    return none('冲突登记的云端快照没有可投影的受控字段');
  }

  // 投影口径：**云端有则用云端、云端没有则保留本地原值**
  // （与业务对齐写入器口径一致 ⇒ 对齐场景投影也是幂等的）。
  return {
    kind: 'project',
    fields: {
      contentMd: cloudFields.contentMd ?? localFields.contentMd,
      handlingResult: cloudFields.handlingResult ?? localFields.handlingResult,
      handlingStatus: cloudFields.handlingStatus ?? localFields.handlingStatus,
    },
  };
}

/** 读取受控字段（云端没有的字段＝null；已知字段类型非法⇒拒绝） */
function readControlledFields(
  body: Record<string, unknown>,
): SyncConflictRepairRequestControlledFields | null {
  const contentMd = readStringOrNull(body['content_md']);
  if (contentMd === undefined) {
    return null;
  }
  const rawResult = body['handling_result'];
  let handlingResult: RepairRequestHandlingResult | null = null;
  if (rawResult !== undefined && rawResult !== null) {
    if (typeof rawResult !== 'string' || !HANDLING_RESULT_VALUES.has(rawResult)) {
      return null;
    }
    handlingResult = rawResult as RepairRequestHandlingResult;
  }
  const rawStatus = body['handling_status'];
  let handlingStatus: RepairRequestHandlingStatus | null = null;
  if (rawStatus !== undefined && rawStatus !== null) {
    if (typeof rawStatus !== 'string' || !HANDLING_STATUS_VALUES.has(rawStatus)) {
      return null;
    }
    handlingStatus = rawStatus as RepairRequestHandlingStatus;
  }
  // 状态必须由结果自洽推导（与对齐口径一致：不自洽⇒拒绝）
  if (handlingResult !== null) {
    const derived = resolveRepairRequestHandlingStatus(handlingResult);
    if (derived !== handlingStatus) {
      return null;
    }
  }
  return { contentMd, handlingResult, handlingStatus };
}

/** 字符串字段：缺省／null ⇒ null；非字符串 ⇒ undefined（表示类型非法） */
function readStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

/** 受控字段逐项比较（null 与 null 视为相同） */
function sameControlledFields(
  a: SyncConflictRepairRequestControlledFields,
  b: SyncConflictRepairRequestControlledFields,
): boolean {
  return (
    a.contentMd === b.contentMd &&
    a.handlingResult === b.handlingResult &&
    a.handlingStatus === b.handlingStatus
  );
}
