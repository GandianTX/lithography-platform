// src/features/repair-request/application/use-customer-repair-original-download.ts

import { useCallback, useRef, useState } from 'react';

import type { NotifyFeedback } from '@/shared/feedback';
import { translateNow } from '@/shared/i18n';
import { triggerBrowserDownload } from '@/shared/ui/download-blob';

import { downloadMyRepairRequestFile } from '../infrastructure/repair-request-adapter';

/**
 * 客户报修原件下载编排（任务 03 第三段，命令收束在 feature application）。
 *
 * - 授权与归属完全由服务端裁决（真实绑定到本人原稿才可下载），前端不做本地判断；
 * - 在途 ref 锁按 fileId 拦截连点；下载失败给明确反馈，不触发浏览器自动保存；
 * - 反馈经注入的窄 port（NotifyFeedback）上报，由 ui 层决定呈现方式——本层不得依赖
 *   具体 UI 组件实现（docs/stable-clean/architecture.md 最小落地规则第 6 条）；
 * - blob 不缓存，浏览器保存由本 hook 经 triggerBrowserDownload 完成。
 */
export function useCustomerRepairOriginalDownload(notify: NotifyFeedback) {
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const inFlightFileIdRef = useRef<string | null>(null);

  const download = useCallback(
    async (fileId: string): Promise<boolean> => {
      if (inFlightFileIdRef.current !== null) {
        return false;
      }

      inFlightFileIdRef.current = fileId;
      setDownloadingFileId(fileId);

      try {
        const result = await downloadMyRepairRequestFile(fileId);

        if (!result.ok) {
          notify({ type: 'error', text: result.message });
          return false;
        }

        triggerBrowserDownload(result.blob, result.filename);
        return true;
      } catch {
        // transport / auth 类失败无稳定领域文案：与共享错误兜底口径一致
        notify({
          type: 'error',
          text: translateNow('customer.downloadError.downloadFailed'),
        });
        return false;
      } finally {
        inFlightFileIdRef.current = null;
        setDownloadingFileId(null);
      }
    },
    [notify],
  );

  return { downloadingFileId, download };
}
