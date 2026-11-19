// src/features/repair-request/application/use-repair-original-download.ts

import { useCallback, useRef, useState } from 'react';

import type { DownloadRepairProcessFileResult } from '../infrastructure/engineer-repair-request.types';
import { downloadRepairProcessFile } from '../infrastructure/engineer-repair-request-adapter';

/**
 * 原件下载编排（客户原始报修附件、内部维修原件共用）。
 * 返回 adapter 结果，由 UI 决定是否触发浏览器下载与如何展示失败；不缓存文件。
 */
export function useRepairOriginalDownload() {
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<string | null>(null);

  const download = useCallback(
    async (fileId: string): Promise<DownloadRepairProcessFileResult | null> => {
      if (inFlightRef.current !== null) {
        return null;
      }
      inFlightRef.current = fileId;
      setDownloadingFileId(fileId);
      setError(null);
      try {
        const result = await downloadRepairProcessFile(fileId);
        if (!result.ok) {
          setError(result.message);
        }
        return result;
      } catch {
        setError(null);
        throw new Error('download-failed');
      } finally {
        inFlightRef.current = null;
        setDownloadingFileId(null);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { downloadingFileId, error, download, clearError };
}
