// src/core/local-runtime/policy/sync-conflict-diff.policy.ts

/**
 * 冲突差异计算（任务 09 S2.3）。
 *
 * 定位：冲突详情已经给出本地快照与云端快照原文；本策略把两份快照摊平成
 * **字段级差异列表**，让页面能直接展示"哪里不一样"，而不必在前端各自实现
 * 一套比较口径（前端比较口径与后端不一致会把"没差异"说成有差异）。
 *
 * 口径：
 * - 只比较**值**，不比较键顺序；
 * - 数组按下标展开（`files.0.name`），顺序不同即视为不同——原件顺序参与摘要；
 * - 快照无法解析时如实标记"无法比较"，**不猜内容**；
 * - 展示值统一截断，避免把长正文整段塞进列表。
 */

/** 差异条目 */
export type SyncConflictDiffEntry = {
  /** 字段路径（点分隔；数组按下标） */
  path: string;
  /** 差异类型 */
  kind: 'ONLY_LOCAL' | 'ONLY_CLOUD' | 'DIFFERENT';
  /** 本地值（展示文本；本机没有该字段时为 null） */
  localValue: string | null;
  /** 云端值（展示文本；云端没有该字段时为 null） */
  cloudValue: string | null;
};

/** 差异计算结果 */
export type SyncConflictDiffResult = {
  entries: SyncConflictDiffEntry[];
  /** 是否因条目上限被截断 */
  truncated: boolean;
  /** 快照无法解析（无法比较） */
  invalid: boolean;
};

/** 默认条目上限 */
export const SYNC_CONFLICT_DIFF_MAX_ENTRIES = 100;

/** 默认展示值长度上限 */
export const SYNC_CONFLICT_DIFF_MAX_VALUE_LENGTH = 500;

/**
 * 计算冲突差异（纯函数）。
 *
 * @param input.localSnapshot 本地快照 JSON 原文
 * @param input.cloudSnapshot 云端快照 JSON 原文
 */
export function computeSyncConflictDiff(input: {
  localSnapshot: string;
  cloudSnapshot: string;
  maxEntries?: number;
  maxValueLength?: number;
}): SyncConflictDiffResult {
  const maxEntries = input.maxEntries ?? SYNC_CONFLICT_DIFF_MAX_ENTRIES;
  const maxValueLength = input.maxValueLength ?? SYNC_CONFLICT_DIFF_MAX_VALUE_LENGTH;

  const local = parseSnapshot(input.localSnapshot);
  const cloud = parseSnapshot(input.cloudSnapshot);
  if (local === null || cloud === null) {
    return { entries: [], truncated: false, invalid: true };
  }

  const localFlat = flatten(local);
  const cloudFlat = flatten(cloud);
  const paths = [...new Set([...localFlat.keys(), ...cloudFlat.keys()])].sort();

  const entries: SyncConflictDiffEntry[] = [];
  let truncated = false;
  for (const path of paths) {
    const hasLocal = localFlat.has(path);
    const hasCloud = cloudFlat.has(path);
    const localRaw = hasLocal ? localFlat.get(path) : undefined;
    const cloudRaw = hasCloud ? cloudFlat.get(path) : undefined;
    if (hasLocal && hasCloud && Object.is(localRaw, cloudRaw)) {
      continue;
    }
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    entries.push({
      path,
      kind: !hasCloud ? 'ONLY_LOCAL' : !hasLocal ? 'ONLY_CLOUD' : 'DIFFERENT',
      localValue: hasLocal ? renderValue(localRaw, maxValueLength) : null,
      cloudValue: hasCloud ? renderValue(cloudRaw, maxValueLength) : null,
    });
  }

  return { entries, truncated, invalid: false };
}

/** 解析快照 JSON；解析失败返回 null（不猜测内容） */
function parseSnapshot(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 把对象／数组摊平成 路径 → 原始值 */
function flatten(
  value: unknown,
  prefix = '',
  output = new Map<string, unknown>(),
): Map<string, unknown> {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        flatten(item, prefix === '' ? String(index) : `${prefix}.${index}`, output);
      });
      return output;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, prefix === '' ? key : `${prefix}.${key}`, output);
    }
    return output;
  }
  output.set(prefix === '' ? '$' : prefix, value);
  return output;
}

/** 展示值：字符串原样，其余按 JSON 文本；统一截断 */
function renderValue(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
