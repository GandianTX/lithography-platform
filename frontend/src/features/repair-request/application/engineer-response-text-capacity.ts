// src/features/repair-request/application/engineer-response-text-capacity.ts

/**
 * 回复正文容量策略（收束在 feature application，UI 只调用，不复制实现）。
 *
 * - 与后端契约一致：MySQL `TEXT` 列最大 65,535 bytes，按 UTF-8 字节计量，
 *   而非 JavaScript 字符数（中文 3 bytes、多数 emoji 4 bytes）；
 * - 计量发生在 trim 之后，与后端 normalizeRequiredText → 字节校验的顺序一致；
 * - 前端校验只用于提交前提前反馈，后端 usecase 始终是最终权威校验。
 */

/** MySQL `TEXT` 列最大字节容量（UTF-8 计量），与后端 usecase 常量一致 */
export const ENGINEER_RESPONSE_TEXT_MAX_BYTES = 65535;

/** TextEncoder 输出即 UTF-8 字节序列，复用单例避免每次编码新建 */
const textEncoder = new TextEncoder();

/** 计算 trim 后字符串的 UTF-8 字节数 */
export function countEngineerResponseTextBytes(text: string): number {
  return textEncoder.encode(text.trim()).length;
}

/** 正文（trim 后）是否超出 MySQL TEXT 的 UTF-8 字节容量 */
export function isEngineerResponseTextOverCapacity(text: string): boolean {
  return countEngineerResponseTextBytes(text) > ENGINEER_RESPONSE_TEXT_MAX_BYTES;
}
