// src/shared/i18n/controlled-code.ts

import type { MessageKey } from './types';

/**
 * 受控码 → 文案键的**通用解析器**（唯一机制）。
 *
 * 为什么需要这一层：后端对外只给**受控码**（同步状态、备份原因、冲突类型等），
 * 界面不能把机器码或后端自由文本原样渲染给用户。
 *
 * 此前任务 09 里有四处"查表 + 未知回落"（同步状态原因码、备份原因码、冲突受控码、
 * 记录状态标签）——机制相同、写法不同。这里给出唯一一份解析器，
 * 各处只保留自己的**码表**（码表本身是业务事实，必须各域自己维护）。
 */

/** 解析受控码对应的文案键；未知码或空值回落到中性兜底键 */
export function resolveControlledCodeKey(
  table: Readonly<Record<string, MessageKey>>,
  value: string | null | undefined,
  fallback: MessageKey,
): MessageKey {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  return table[value] ?? fallback;
}

/** 解析受控码对应的文案键；未知码或空值返回 null（调用方自选兜底策略） */
export function resolveControlledCodeKeyOrNull(
  table: Readonly<Record<string, MessageKey>>,
  value: string | null | undefined,
): MessageKey | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return table[value] ?? null;
}
