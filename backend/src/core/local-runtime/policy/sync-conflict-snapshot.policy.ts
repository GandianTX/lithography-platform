// src/core/local-runtime/policy/sync-conflict-snapshot.policy.ts

import { SYNC_ERROR } from '@core/common/errors/domain-error';

/**
 * 冲突快照契约（任务 09 R067／R068）。
 *
 * 快照是什么：冲突登记方（业务同步回执链）把冲突双方的**正文快照**写进
 * `sync_conflict.local_snapshot`／`cloud_snapshot`；裁决侧（保留本地／使用云端）
 * 从这两份快照里取"可写入的受控字段"。
 *
 * 契约版本 1 的形态（**冲突登记方实际写入的形态**）：
 * ```
 * {
 *   schema_version: 1,
 *   resource_type?: string,
 *   record_uuid?: string,
 *   version_no?: number | null,
 *   manifest_checksum?: string,
 *   body: { ...受控字段... }
 * }
 * ```
 *
 * 正文载荷有两个**已声明**的承载位置，字段名与语义完全相同：
 * 1. 信封的 `body`（冲突登记方实际写入的位置，见
 *    `dispatch-business-sync-tasks.usecase.ts#recordConflict`）；
 * 2. 信封根（旧契约：受控字段直接挂在快照根上）。
 *
 * 取用顺序固定为「先 `body`、后信封根」；两处都没有该字段即"没有该字段"，
 * **不猜、不补、不拿当前库里的值冒充快照内容**。
 *
 * 为什么要把两个位置都认下来：真实冲突由业务同步回执链登记，写的是
 * 「信封 ＋ `body`」；只认信封根会让**真实数据**取不到任何受控字段
 * （保留本地必然被拒），只认 `body` 又会让按旧契约登记的历史快照取不到字段。
 * 两个位置都是本仓已声明的契约形态，不是"猜字段含义"。
 */

/** 冲突快照契约版本 */
export const SYNC_CONFLICT_SNAPSHOT_SCHEMA_VERSION = 1;

/** 冲突快照正文（受控字段集合） */
export type SyncConflictSnapshotBody = Record<string, unknown>;

/** 快照读取结果 */
export type SyncConflictSnapshotRead =
  | { kind: 'ok'; body: SyncConflictSnapshotBody }
  | { kind: 'reject'; code: string; message: string };

/** 可选字符串字段的三态读取结果 */
export type OptionalStringRead =
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'value'; value: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 读取冲突快照的正文载荷。
 *
 * 失败关闭：不是合法 JSON、不是对象、结构版本不符、`body` 存在但不是对象
 * —— 任一情形都拒绝，不返回"半可信"的载荷。
 *
 * @param snapshot 快照 JSON 原文
 * @param options.invalidCode 拒绝时使用的错误码（保留本地／使用云端各有自己的码）
 */
export function readConflictSnapshotBody(
  snapshot: string,
  options: { invalidCode?: string } = {},
): SyncConflictSnapshotRead {
  const invalidCode = options.invalidCode ?? SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID;

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return {
      kind: 'reject',
      code: invalidCode,
      message: '冲突快照不是合法 JSON，无法映射为受控载荷',
    };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'reject', code: invalidCode, message: '冲突快照必须是 JSON 对象' };
  }
  if (parsed['schema_version'] !== SYNC_CONFLICT_SNAPSHOT_SCHEMA_VERSION) {
    return {
      kind: 'reject',
      code: invalidCode,
      message: '冲突快照结构版本不符，不能猜测字段含义',
    };
  }

  const body = parsed['body'];
  if (body !== undefined && body !== null && !isPlainObject(body)) {
    return {
      kind: 'reject',
      code: invalidCode,
      message: '冲突快照的正文载荷必须是 JSON 对象',
    };
  }
  if (isPlainObject(body)) {
    return { kind: 'ok', body };
  }
  // 旧契约：受控字段直接挂在快照根上（信封根即正文）
  return { kind: 'ok', body: parsed };
}

/**
 * 读取一个可选字符串字段。
 *
 * - 缺省与 null 按"没有该字段"处理；
 * - **类型非法必须被发现**（当成"没有"会让裁决丢掉正文）。
 */
export function readOptionalStringField(
  body: SyncConflictSnapshotBody,
  key: string,
): OptionalStringRead {
  const value = body[key];
  if (value === undefined || value === null) {
    return { kind: 'absent' };
  }
  return typeof value === 'string' ? { kind: 'value', value } : { kind: 'invalid' };
}
