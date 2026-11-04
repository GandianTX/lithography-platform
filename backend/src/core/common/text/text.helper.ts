// src/core/common/text/text.helper.ts

/** Protocol-compatible trim that preserves empty/null/undefined distinctions. */
export function trimTextPure(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}

/**
 * 文本转小写处理
 * @param value 待处理的值
 * @returns 如果是字符串则返回小写后的结果，否则返回原值
 */
export function toLowerCase(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return value as string | undefined;
}

/**
 * 判断文本是否为空白：null / undefined / 空串 / 仅空白字符。
 * 供不负责输入裁剪的读侧与快照构建处做完整性判定使用。
 */
export function isBlankText(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return value.trim().length === 0;
}

/**
 * 文本规范化处理
 * @param value 待处理的值
 * @returns 如果是字符串则返回规范化后的结果，否则返回原值
 */
export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return value as string | undefined;
  }

  return value
    .trim() // 去除首尾空格
    .replace(/[\uFF01-\uFF5E]/g, (char) => {
      // 全角转半角
      return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
    })
    .replace(/[\u3000]/g, ' ') // 全角空格转半角空格
    .replace(/\s+/g, ' ') // 多个空格归一
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
      '',
    ); // 过滤 Emoji
}
