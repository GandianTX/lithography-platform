// src/core/local-runtime/policy/sync-conflict-cloud-alignment.policy.ts

import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import { resolveRepairRequestHandlingStatus } from '@core/repair-request/policy/repair-request-handling.policy';
import {
  readConflictSnapshotBody,
  readOptionalStringField,
  type SyncConflictSnapshotBody,
} from './sync-conflict-snapshot.policy';

/**
 * 「使用云端」的**本地视图对齐**计划（任务 09 R068）。
 *
 * R068 的原文口径：
 * - 「复核同一资源读取权和已展示云端版本 → **对齐本地当前有权视图** →
 *   保留原本地冲突副本及明确选择事实」；
 * - 「只对齐本地有权视图，**不取得新编辑权**」；
 * - 「不 UPDATE 云端原记录或覆盖原始历史，**重复确认不产生新业务版本**」。
 *
 * 所以"使用云端"不是"把云端内容随便写回业务表"：
 * 它是**一次受控的本地视图对齐**——把云端快照里**明确存在**的受控字段
 * 落到本地当前视图，产出**至多一个**新的本地业务版本，
 * 原本地冲突副本留在 `sync_conflict.local_snapshot` 里不动。
 *
 * 三种结果：
 * 1. `align`：可写来源 ⇒ 按版本条件对齐本地视图（写一次受控修订）；
 * 2. `view-only`：**只读采用**（来源已结单）⇒ 只呈现云端视图，
 *    **不写业务记录、不改历史**（R066／R068「已结单只读工单可按读取权限
 *    采用云端，但不能保留本地反向覆盖」）；
 * 3. `reject`：失败关闭，并给出可定位的受控原因码。
 *
 * 字段口径（与冲突快照契约一致，见 `sync-conflict-snapshot.policy.ts`）：
 * - 只对齐**云端快照里存在且非 null**的字段；缺省／null 一律按"云端没有该字段"
 *   处理，本地保持原值（不猜、不补、不拿当前库里的值冒充云端内容）；
 * - **空串按"云端没有该字段"处理**（不写空、不清空本地已有内容）；
 * - 云端快照里**类型非法**的已知字段必须被拒绝（当成"没有"会让对齐丢掉正文）；
 * - 处理结果与处理状态必须自洽：状态由结果**推导**（同一套映射口径），
 *   云端给的态与推导结果不一致 ⇒ 拒绝（不自相矛盾地落库）。
 *
 * 资源类型口径（按来源域受控入口逐个放行）：
 * - `REPAIR_REQUEST`：受控字段＝正文 `content_md` ＋ 处理结果／处理状态；
 * - `REFERENCE_DOCUMENT`：受控字段＝标题 `title`、说明 `description`、
 *   正文 `content_text`（**不**含文档类型、原件名、MIME 与扩展名——
 *   那些属于原件与结构身份，云端原件不得覆盖本地原件登记）；
 * - 其余类型（维修报告等）**没有**受控对齐入口 ⇒ 失败关闭。
 */

/** 有受控本地视图对齐入口的资源类型 */
export const CLOUD_ALIGNMENT_SUPPORTED_RESOURCE_TYPES = [
  'REPAIR_REQUEST',
  'REFERENCE_DOCUMENT',
] as const;
export type CloudAlignmentResourceType = (typeof CLOUD_ALIGNMENT_SUPPORTED_RESOURCE_TYPES)[number];

/**
 * 工单对齐载荷（受控字段；null 表示"云端没有该字段"，本地保持原值）。
 */
export type SyncConflictRepairRequestAlignmentPayload = {
  resourceType: 'REPAIR_REQUEST';
  /** 版本条件：必须是来源记录的当前版本（并发裁决的唯一依据） */
  expectedVersion: number;
  /** 正文 */
  contentMd: string | null;
  /** 处理结果（真实枚举值） */
  handlingResult: RepairRequestHandlingResult | null;
  /** 处理状态（由处理结果推导） */
  handlingStatus: RepairRequestHandlingStatus | null;
};

/**
 * 资料对齐载荷（受控字段；null 表示"云端没有该字段"，本地保持原值）。
 */
export type SyncConflictReferenceDocumentAlignmentPayload = {
  resourceType: 'REFERENCE_DOCUMENT';
  /** 版本条件：必须是来源资料的当前版本 */
  expectedVersion: number;
  /** 标题 */
  title: string | null;
  /** 说明 */
  description: string | null;
  /** 正文（资料自身可搜索文本） */
  contentText: string | null;
};

/** 对齐载荷（按资源类型区分的受控字段集合） */
export type SyncConflictCloudAlignmentPayload =
  SyncConflictRepairRequestAlignmentPayload | SyncConflictReferenceDocumentAlignmentPayload;

/** 对齐计划 */
export type SyncConflictCloudAlignmentPlan =
  | { kind: 'align'; payload: SyncConflictCloudAlignmentPayload }
  | { kind: 'view-only' }
  | { kind: 'reject'; code: string; message: string };

export type SyncConflictCloudAlignmentInput = {
  /** 冲突登记的资源类型 */
  resourceType: string;
  /** 冲突登记的本地版本；null 表示没有登记可用版本 */
  localVersion: number | null;
  /** 云端快照 JSON 原文 */
  cloudSnapshot: string;
  /** 是否为**只读采用**（来源已结单：只呈现视图，不写业务历史） */
  readOnlyAdoption: boolean;
};

const HANDLING_RESULT_VALUES: ReadonlySet<string> = new Set(
  Object.values(RepairRequestHandlingResult) as string[],
);
const HANDLING_STATUS_VALUES: ReadonlySet<string> = new Set(
  Object.values(RepairRequestHandlingStatus) as string[],
);

const reject = (code: string, message: string): SyncConflictCloudAlignmentPlan => ({
  kind: 'reject',
  code,
  message,
});

/**
 * 计算一次「使用云端」的本地视图对齐计划（纯函数）。
 *
 * 失败关闭：任何不确定的情形都返回 `reject` 并带明确错误码，
 * 不产出"看起来能用"的载荷。
 */
export function planCloudConflictAlignment(
  input: SyncConflictCloudAlignmentInput,
): SyncConflictCloudAlignmentPlan {
  // 只读采用：来源已结单 ⇒ 只呈现云端视图，不写业务记录、不改历史。
  if (input.readOnlyAdoption) {
    return { kind: 'view-only' };
  }

  const supported = CLOUD_ALIGNMENT_SUPPORTED_RESOURCE_TYPES.find(
    (candidate) => candidate === input.resourceType,
  );
  if (supported === undefined) {
    return reject(
      SYNC_ERROR.CLOUD_ALIGNMENT_RESOURCE_UNSUPPORTED,
      '该资源类型还没有受控的本地视图对齐入口，不能执行使用云端裁决',
    );
  }

  const expectedVersion = resolveExpectedVersion(input.localVersion);
  if (expectedVersion === null) {
    return reject(
      SYNC_ERROR.CLOUD_ALIGNMENT_VERSION_UNAVAILABLE,
      '冲突没有登记可用的本地版本，无法按版本条件对齐本地视图',
    );
  }

  const snapshot = readConflictSnapshotBody(input.cloudSnapshot, {
    invalidCode: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
  });
  if (snapshot.kind === 'reject') {
    return reject(snapshot.code, snapshot.message);
  }

  if (supported === 'REPAIR_REQUEST') {
    const mapped = mapRepairRequestAlignmentFields(snapshot.body);
    if (mapped.kind === 'reject') {
      return reject(mapped.code, mapped.message);
    }
    if (!mapped.hasAlignableField) {
      return reject(
        SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
        '云端快照没有可对齐的受控字段，拒绝空对齐',
      );
    }
    return {
      kind: 'align',
      payload: {
        resourceType: 'REPAIR_REQUEST',
        expectedVersion,
        contentMd: mapped.contentMd,
        handlingResult: mapped.handlingResult,
        handlingStatus: mapped.handlingStatus,
      },
    };
  }

  const mapped = mapReferenceDocumentAlignmentFields(snapshot.body);
  if (mapped.kind === 'reject') {
    return reject(mapped.code, mapped.message);
  }
  if (!mapped.hasAlignableField) {
    return reject(
      SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      '云端快照没有可对齐的受控字段，拒绝空对齐',
    );
  }
  return {
    kind: 'align',
    payload: {
      resourceType: 'REFERENCE_DOCUMENT',
      expectedVersion,
      title: mapped.title,
      description: mapped.description,
      contentText: mapped.contentText,
    },
  };
}

/** 并发版本取数：冲突登记的本地版本必须是 ≥1 的整数 */
function resolveExpectedVersion(localVersion: number | null): number | null {
  if (localVersion === null || !Number.isInteger(localVersion) || localVersion < 1) {
    return null;
  }
  return localVersion;
}

type RepairRequestAlignmentFields = {
  contentMd: string | null;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
  hasAlignableField: boolean;
};

/**
 * 把云端快照正文映射为工单可对齐的受控字段。
 *
 * - 缺省与 null 一律按"云端没有该字段"处理（本地保持原值）；
 * - 空串按"云端没有该字段"处理（不写空、不清空）；
 * - 类型非法的已知字段一律拒绝；
 * - 处理结果与处理状态必须自洽（状态由结果推导）。
 */
function mapRepairRequestAlignmentFields(
  body: SyncConflictSnapshotBody,
):
  | ({ kind: 'ok' } & RepairRequestAlignmentFields)
  | { kind: 'reject'; code: string; message: string } {
  const contentMd = readOptionalStringField(body, 'content_md');
  if (contentMd.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的正文类型非法，不能按"没有该字段"处理',
    };
  }

  const rawResult = readOptionalStringField(body, 'handling_result');
  if (rawResult.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的处理结果类型非法，不能按"没有该字段"处理',
    };
  }
  const rawStatus = readOptionalStringField(body, 'handling_status');
  if (rawStatus.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的处理状态类型非法，不能按"没有该字段"处理',
    };
  }

  // 处理结果：必须是真实枚举值
  let handlingResult: RepairRequestHandlingResult | null = null;
  if (rawResult.kind === 'value' && rawResult.value !== '') {
    if (!HANDLING_RESULT_VALUES.has(rawResult.value)) {
      return {
        kind: 'reject',
        code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
        message: '云端快照里的处理结果不是受控取值，不能猜语义',
      };
    }
    handlingResult = rawResult.value as RepairRequestHandlingResult;
  }

  // 处理状态：必须是真实枚举值
  let handlingStatus: RepairRequestHandlingStatus | null = null;
  if (rawStatus.kind === 'value' && rawStatus.value !== '') {
    if (!HANDLING_STATUS_VALUES.has(rawStatus.value)) {
      return {
        kind: 'reject',
        code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
        message: '云端快照里的处理状态不是受控取值，不能猜语义',
      };
    }
    handlingStatus = rawStatus.value as RepairRequestHandlingStatus;
  }

  // 自洽性：有结果必须有状态（库级映射 CHECK 要求两者同时存在或同时为空）；
  // 状态由结果推导，云端给的态与推导结果不一致 ⇒ 拒绝，不落自相矛盾的数据。
  if (handlingResult !== null) {
    const derived = resolveRepairRequestHandlingStatus(handlingResult);
    if (handlingStatus !== null && handlingStatus !== derived) {
      return {
        kind: 'reject',
        code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
        message: '云端快照里的处理结果与处理状态不自洽，不能落库',
      };
    }
    handlingStatus = derived;
  } else if (handlingStatus !== null) {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照给了处理状态却没有对应处理结果，不能落库',
    };
  }

  return {
    kind: 'ok',
    contentMd: contentMd.kind === 'value' && contentMd.value !== '' ? contentMd.value : null,
    handlingResult,
    handlingStatus,
    hasAlignableField:
      (contentMd.kind === 'value' && contentMd.value !== '') || handlingResult !== null,
  };
}

type ReferenceDocumentAlignmentFields = {
  title: string | null;
  description: string | null;
  contentText: string | null;
  hasAlignableField: boolean;
};

/**
 * 把云端快照正文映射为资料可对齐的受控字段。
 *
 * 受控白名单只有三项：**标题 / 说明 / 资料自身正文**。
 * 文档类型、原件名、MIME、扩展名属于结构与原件身份，
 * 云端不得覆盖本地登记（对齐不是"换一份资料"）。
 *
 * 字段名取业务同步 body 的 **snake_case**（`business-sync-source.service.ts`
 * 的资料分支正是这个形态）：`title` / `description` / `content_text`。
 */
function mapReferenceDocumentAlignmentFields(
  body: SyncConflictSnapshotBody,
):
  | ({ kind: 'ok' } & ReferenceDocumentAlignmentFields)
  | { kind: 'reject'; code: string; message: string } {
  const title = readOptionalStringField(body, 'title');
  if (title.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的资料标题类型非法，不能按"没有该字段"处理',
    };
  }

  const description = readOptionalStringField(body, 'description');
  if (description.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的资料说明类型非法，不能按"没有该字段"处理',
    };
  }

  const contentText = readOptionalStringField(body, 'content_text');
  if (contentText.kind === 'invalid') {
    return {
      kind: 'reject',
      code: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
      message: '云端快照里的资料正文类型非法，不能按"没有该字段"处理',
    };
  }

  const titleValue = title.kind === 'value' && title.value !== '' ? title.value : null;
  const descriptionValue =
    description.kind === 'value' && description.value !== '' ? description.value : null;
  const contentTextValue =
    contentText.kind === 'value' && contentText.value !== '' ? contentText.value : null;

  return {
    kind: 'ok',
    title: titleValue,
    description: descriptionValue,
    contentText: contentTextValue,
    hasAlignableField:
      titleValue !== null || descriptionValue !== null || contentTextValue !== null,
  };
}
