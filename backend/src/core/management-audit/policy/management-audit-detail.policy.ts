// src/core/management-audit/policy/management-audit-detail.policy.ts

/**
 * 关键操作记录 `detail` 的安全投影（任务 10 读侧）。
 *
 * `detail` 是写入方自由组织的 TEXT 列：凭据类写成 `{ reason, loginNameMasked }`，
 * 三类业务操作的键由 07／09 决定。查询页绝不能把原值直接透传，否则正文、路径或
 * 凭据都可能随详情一起泄漏。
 *
 * 本策略只做一件事：把 `detail` 解析成**固定白名单字段**的结构化摘要。
 * - 非 JSON、非法 JSON、数组、标量、超长原文 → 一律返回 null（历史文本不做兜底猜测）；
 * - 只读取白名单键，其余键静默丢弃，不做合并、不做原样回传；
 * - 文本键做码点截断，`stage`／`changedFields`／`attemptNo` 追加字符集与数值约束，
 *   避免自由文本夹带业务正文；
 * - 不读取 I/O、配置或框架，可被单测穷举。
 *
 * 提供方兼容（2026-11-22 S2 实测）：任务 07 现有写入形状是
 * `{ reason, changes: { 字段: { from, to } } }`，`changes` 不在白名单键内。
 * 读侧额外兼容该形状——**只投影字段名**并入 `changedFields`，`from`／`to` 的值
 * 一律丢弃（账号 ID、公司 ID、状态文本都不属于只读页要展示的安全摘要）。
 * 写入侧仍只接受声明的六个键，两侧各自独立，不会互相放宽。
 *
 * 输出刻意保持语言无关（不带「原因：」等中文标签）：中英文页面由前端按字段渲染，
 * 服务端不持有 UI 文案。
 */

/** 允许对外展示的 `detail` 键（其余键一律丢弃）。 */
export const MANAGEMENT_AUDIT_DETAIL_ALLOWED_KEYS = [
  'reason',
  'stage',
  'changedFields',
  'attemptNo',
  'beforeOrganizationName',
  'afterOrganizationName',
] as const;

/** 结构化安全摘要；没有任何可展示字段时为 null。 */
export type ManagementAuditDetailView = {
  readonly reason?: string;
  readonly stage?: string;
  readonly changedFields?: ReadonlyArray<string>;
  readonly attemptNo?: number;
  readonly beforeOrganizationName?: string;
  readonly afterOrganizationName?: string;
};

/** detail 原文上限：审计摘要应为短文本，超限直接视为不可展示。 */
const MAX_RAW_LENGTH = 8_000;
/** 原因文本展示上限。 */
const MAX_REASON_LENGTH = 200;
/** 公司名展示上限。 */
const MAX_ORGANIZATION_NAME_LENGTH = 120;
/** 变更字段单值长度与数量上限。 */
const MAX_FIELD_NAME_LENGTH = 40;
const MAX_CHANGED_FIELDS = 20;
/** 阶段标识：大写字母开头的大写下划线标识，禁止任意文本。 */
const STAGE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
/** 字段名：字母开头的标识符。 */
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** 尝试序号的合理上界。 */
const MAX_ATTEMPT_NO = 1_000_000;

/**
 * 把 `detail` 原值投影为白名单摘要。
 *
 * @param raw `management_audit_event.detail` 原始值（可空）
 * @returns 结构化摘要；无可展示内容时返回 null
 */
export function projectManagementAuditDetail(raw: string | null): ManagementAuditDetailView | null {
  const record = parseDetailRecord(raw);
  if (record === null) {
    return null;
  }
  const projected = readAllowedDetailFields(record);
  const providerFields = readProviderChangedFields(record.changes);
  if (providerFields.length === 0) {
    return projected;
  }
  // 提供方既有形状（07 的 `changes: {字段: {from,to}}`）只投影字段名，
  // 前后值一律丢弃——ID 与状态值不需要在只读页展示，也避免自由文本混入。
  return {
    ...(projected ?? {}),
    changedFields: mergeChangedFields(projected?.changedFields ?? [], providerFields),
  };
}

/**
 * 写入侧：把提供方传入的结构化摘要规整成可入库的 JSON 文本。
 *
 * 与读侧共用同一套白名单、长度与字符集规则（`readAllowedDetailFields`），
 * 因此「写得进去的」必然「读得出来」，不会出现一端放宽、另一端丢字段的漂移。
 * 非法值静默丢弃；全部字段非法时返回 null（不写空 JSON）。
 */
export function serializeManagementAuditDetail(
  input: ManagementAuditDetailView | null | undefined,
): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const candidate: Record<string, unknown> = {
    reason: input.reason,
    stage: input.stage,
    changedFields: input.changedFields,
    attemptNo: input.attemptNo,
    beforeOrganizationName: input.beforeOrganizationName,
    afterOrganizationName: input.afterOrganizationName,
  };
  const projected = readAllowedDetailFields(candidate);
  return projected === null ? null : JSON.stringify(projected);
}

/** 解析 detail：只接受「长度合理、JSON 对象」的输入，其余一律视为不可展示。 */
function parseDetailRecord(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RAW_LENGTH) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 历史自由文本一律不展示：无法判定其中是否夹带正文
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/** 只读取白名单键；没有任何合法字段时返回 null。 */
function readAllowedDetailFields(
  record: Readonly<Record<string, unknown>>,
): ManagementAuditDetailView | null {
  const projected: {
    reason?: string;
    stage?: string;
    changedFields?: string[];
    attemptNo?: number;
    beforeOrganizationName?: string;
    afterOrganizationName?: string;
  } = {};

  const reason = readBoundedText(record.reason, MAX_REASON_LENGTH);
  if (reason !== null) {
    projected.reason = reason;
  }

  const stage = readBoundedText(record.stage, 32);
  if (stage !== null && STAGE_PATTERN.test(stage)) {
    projected.stage = stage;
  }

  const changedFields = readChangedFields(record.changedFields);
  if (changedFields.length > 0) {
    projected.changedFields = changedFields;
  }

  const attemptNo = readAttemptNo(record.attemptNo);
  if (attemptNo !== null) {
    projected.attemptNo = attemptNo;
  }

  const beforeOrganizationName = readBoundedText(
    record.beforeOrganizationName,
    MAX_ORGANIZATION_NAME_LENGTH,
  );
  if (beforeOrganizationName !== null) {
    projected.beforeOrganizationName = beforeOrganizationName;
  }

  const afterOrganizationName = readBoundedText(
    record.afterOrganizationName,
    MAX_ORGANIZATION_NAME_LENGTH,
  );
  if (afterOrganizationName !== null) {
    projected.afterOrganizationName = afterOrganizationName;
  }

  return Object.keys(projected).length === 0 ? null : projected;
}

/** 读取并截断文本键；非字符串、空白、纯符号文本不进入结果。 */
function readBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const codePoints = Array.from(trimmed);
  return codePoints.length > maxLength ? codePoints.slice(0, maxLength).join('') : trimmed;
}

/** 读取变更字段名数组；非法值逐个丢弃，保持首次出现顺序并去重。 */
function readChangedFields(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_FIELD_NAME_LENGTH ||
      !FIELD_NAME_PATTERN.test(trimmed) ||
      seen.has(trimmed)
    ) {
      continue;
    }
    seen.add(trimmed);
    fields.push(trimmed);
    if (fields.length >= MAX_CHANGED_FIELDS) {
      break;
    }
  }
  return fields;
}

/** 读取尝试序号；只接受非负整数。 */
function readAttemptNo(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value > MAX_ATTEMPT_NO ? null : value;
}

/**
 * 读取提供方的字段级变更摘要（任务 07 现有形状 `changes: {字段: {from, to}}`）。
 *
 * 只取字段名，不取 `from`／`to` 的值：字段名是受控标识符，值可能是账号 ID、
 * 公司 ID 或状态文本，不属于只读页需要展示的安全摘要。
 */
function readProviderChangedFields(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  const fields: string[] = [];
  for (const key of Object.keys(value)) {
    const trimmed = key.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_FIELD_NAME_LENGTH ||
      !FIELD_NAME_PATTERN.test(trimmed)
    ) {
      continue;
    }
    fields.push(trimmed);
    if (fields.length >= MAX_CHANGED_FIELDS) {
      break;
    }
  }
  return fields;
}

/** 合并两处来源的变更字段名：去重并保持上限。 */
function mergeChangedFields(primary: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const field of [...primary, ...extra]) {
    if (seen.has(field)) {
      continue;
    }
    seen.add(field);
    merged.push(field);
    if (merged.length >= MAX_CHANGED_FIELDS) {
      break;
    }
  }
  return merged;
}
