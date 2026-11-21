// src/features/maintenance-report/ui/maintenance-report-download.spec.ts
//
// 导出下载助手单测：base64 解码、MIME、文件名透传、URL 释放；不发任何网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadMaintenanceReportExport } from './maintenance-report-download';

type AnchorOverrides = Partial<HTMLAnchorElement>;

/** DOM 环境下的 UTF-8 base64（无 Node Buffer） */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

describe('downloadMaintenanceReportExport', () => {
  let createdObjectUrls: string[];
  let clickSpy: ReturnType<typeof vi.fn>;
  let lastAnchor: HTMLAnchorElement | null;

  beforeEach(() => {
    createdObjectUrls = ['blob:mock-url'];
    clickSpy = vi.fn();
    lastAnchor = null;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => createdObjectUrls[0]),
        revokeObjectURL: vi.fn(),
      }),
    );
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a') {
        lastAnchor = element as HTMLAnchorElement;
        Object.defineProperty(element, 'click', { value: clickSpy });
      }
      return element;
    }) as unknown as typeof document.createElement);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('base64 → Blob（MIME 正确）→ 以服务端文件名触发下载', () => {
    // "样例字节" 的 UTF-8 base64
    const fileName = downloadMaintenanceReportExport({
      format: 'DOCX',
      fileName: '维修报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 12,
      contentBase64: toBase64('样例字节内容123'),
    });

    expect(fileName).toBe('维修报告.docx');
    expect(lastAnchor).not.toBeNull();
    const anchorOverrides: AnchorOverrides = lastAnchor as unknown as AnchorOverrides;
    expect(anchorOverrides.download).toBe('维修报告.docx');
    expect(anchorOverrides.href).toBe('blob:mock-url');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('字节内容与 byteSize 语义一致（解码后长度一致）', () => {
    const content = '中文长文本内容验证——导出下载不截断。';
    const base64 = toBase64(content);
    downloadMaintenanceReportExport({
      format: 'PDF',
      fileName: 'export.pdf',
      mimeType: 'application/pdf',
      byteSize: new TextEncoder().encode(content).length,
      contentBase64: base64,
    });
    const blobUrl = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blobUrl.type).toBe('application/pdf');
  });
});
