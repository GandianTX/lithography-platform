// src/features/maintenance-report/ui/maintenance-report-download.ts
//
// 导出结果落浏览器：base64 → Blob → 临时 <a download> 触发保存。
// 纯客户端行为，不产生任何 GraphQL/REST 请求。

import type { MaintenanceReportExportResult } from '../infrastructure/maintenance-report.types';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 触发浏览器下载；返回生成文件名便于调用方展示 */
export function downloadMaintenanceReportExport(result: MaintenanceReportExportResult): string {
  const bytes = base64ToBytes(result.contentBase64);
  const blob = new Blob([bytes as BlobPart], { type: result.mimeType });
  downloadBlobAsFile(blob, result.fileName);
  return result.fileName;
}

/** 通用 Blob 落浏览器：临时 <a download> 触发保存并释放对象 URL */
export function downloadBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 释放对象 URL：下载触发后立即回收
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
