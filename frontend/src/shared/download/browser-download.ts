// src/shared/download/browser-download.ts

/**
 * 浏览器文件保存（shared）。
 *
 * 归属理由：`URL.createObjectURL` + 临时 `<a download>` 属浏览器技术边界，
 * 多个 feature 都需要把服务端返回的字节落地成文件（任务 05 的会话 PDF 导出、
 * 既有文档下载），故收敛到 shared，避免各 feature 重复实现或跨 feature 引用。
 *
 * 约束（安全口径）：只用 blob + `a[download]`，不使用 `window.open` 或直链。
 * 生命周期：无论点击是否成功都立即 `remove()` 并从 URL 表撤销——`click()` 抛错时
 * 若不回收，会残留游离的 `<a>` 节点与永不释放的 blob URL。
 */

/** Base64 文本 → Blob（服务端以 Base64 返回文件字节时使用） */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

/** 把 Blob 交给浏览器保存 */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
