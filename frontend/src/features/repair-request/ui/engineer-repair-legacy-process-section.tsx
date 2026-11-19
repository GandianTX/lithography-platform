// src/features/repair-request/ui/engineer-repair-legacy-process-section.tsx

/**
 * 旧内部维修历史（只读）展示（任务 04 P2 回归）。
 *
 * - 数据直接取详情响应已有的 processEntries（后端仅对接单工程师本人返回）；
 * - 只复用条目展示与既有授权下载入口，不重新挂载旧编辑组件：
 *   不提供新增、编辑、改绑或删除，草稿与写入口都不在此处；
 * - 结单前后都可查看；结单后由详情整体的只读事实保证不可写；
 * - 与页面底部「版本与修订历史」无关，两者不合并。
 */

import { useState } from 'react';
import { Alert, Timeline } from 'antd';

import { useI18n } from '@/shared/i18n';
import { triggerBrowserDownload } from '@/shared/ui/download-blob';

import { useRepairOriginalDownload } from '../application/use-repair-original-download';
import type { EngineerRepairProcessEntry } from '../infrastructure/engineer-repair-request.types';

import { RepairProcessEntryView } from './repair-process-entry-view';

export function EngineerRepairLegacyProcessSection({
  processEntries,
}: {
  processEntries: EngineerRepairProcessEntry[];
}) {
  const { t } = useI18n();
  const { error, download, clearError } = useRepairOriginalDownload();
  const [localError, setLocalError] = useState<string | null>(null);

  if (processEntries.length === 0) {
    return null;
  }

  // 下载走既有授权入口：服务端仍按接单人/工单归属裁决，前端不自行放行。
  const handleDownload = async (fileId: string) => {
    setLocalError(null);
    clearError();
    try {
      const result = await download(fileId);
      if (result?.ok) {
        triggerBrowserDownload(result.blob, result.filename);
      }
    } catch {
      setLocalError(t('engineerDetail.downloadFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-text-secondary">{t('engineerDetail.legacyProcessHint')}</div>
      <Timeline
        items={processEntries.map((entry) => ({
          content: (
            <RepairProcessEntryView
              entry={entry}
              onDownload={(fileId) => void handleDownload(fileId)}
            />
          ),
          key: entry.entryUuid,
        }))}
      />
      {(error ?? localError) ? (
        <Alert showIcon title={error ?? localError ?? ''} type="error" />
      ) : null}
    </div>
  );
}
