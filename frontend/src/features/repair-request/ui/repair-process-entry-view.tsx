// src/features/repair-request/ui/repair-process-entry-view.tsx

/**
 * 内部维修过程条目的只读展示（当前过程列表与旧维修历史共用）。
 *
 * - 只负责展示操作、测试事实、时间、版本与已绑定原件，以及下载回调；
 * - 是否提供编辑入口由调用方通过 onEdit 与 disabled 决定：
 *   旧维修历史不传 onEdit，因此永远不出现编辑入口；
 * - 不承担任何写操作，也不解析服务端权限。
 */

import { Button, Tag } from 'antd';

import { formatDateTimeText } from '@/shared/ui/format-date-time';

import type { EngineerRepairProcessEntry } from '../infrastructure/engineer-repair-request.types';

export function RepairProcessEntryView({
  entry,
  onDownload,
  onEdit,
  disabled = false,
}: {
  entry: EngineerRepairProcessEntry;
  onDownload: (fileId: string) => void;
  onEdit?: (entry: EngineerRepairProcessEntry) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">
          {entry.occurredAt ? formatDateTimeText(entry.occurredAt) : '服务端记录时间'}
        </span>
        <Tag color={entry.timeSource === 'MANUAL' ? 'blue' : 'default'}>
          {entry.timeSource === 'MANUAL' ? '人工时间' : '系统时间'}
        </Tag>
        <span className="text-text-secondary text-xs">版本 {entry.versionNo}</span>
        {!disabled && onEdit ? (
          <Button onClick={() => onEdit(entry)} size="small" type="link">
            编辑
          </Button>
        ) : null}
      </div>
      <div className="text-sm whitespace-pre-wrap">{entry.operationText}</div>
      {entry.testResult ? (
        <div className="text-sm text-text-secondary whitespace-pre-wrap">
          测试事实：{entry.testResult}
        </div>
      ) : null}
      {entry.file ? (
        <div className="flex flex-wrap items-center gap-2">
          <Tag color="green">已保存绑定</Tag>
          <span className="text-sm">{entry.file.originalFilename}</span>
          <span className="text-text-secondary text-xs">
            {entry.file.byteSize} 字节 · SHA-256 {entry.file.checksumSha256.slice(0, 12)}…
          </span>
          <Button onClick={() => onDownload(entry.file!.fileId)} size="small">
            下载原件
          </Button>
        </div>
      ) : null}
      <div className="text-text-secondary text-xs">
        记录于 {formatDateTimeText(entry.createdAt)}
      </div>
    </div>
  );
}
