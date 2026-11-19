// src/shared/ui/download-blob.ts

/** 触发浏览器下载内存中的 Blob（不经过服务端 URL，不自建下载代理） */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
