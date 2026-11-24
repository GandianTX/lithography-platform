// src/features/record-package/ui/record-package-export-dialog.tsx

import { useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';

import { useRecordPackageExport } from '../application/use-record-package-export';
import type {
  RecordPackageExportEntry,
  RecordPackageResourceType,
} from '../infrastructure/record-package.types';

import { resolveRecordPackageResourceTypeKey } from './record-package-labels';

const RESOURCE_TYPES: RecordPackageResourceType[] = [
  'REFERENCE_DOCUMENT',
  'REPAIR_REQUEST',
  'MAINTENANCE_REPORT',
];

/**
 * 记录包导出对话框（任务 09 S3 补丁 P1：来源页导出入口）。
 *
 * - 目标目录必须是**本机绝对路径**（U盘挂载点或空目录），服务端复核后才落盘；
 * - **不要求用户手抄公司 ID**：省略公司时由服务端按可信 session 范围取本公司；
 * - 记录标识由调用方（来源记录页）给出，服务端逐条复核归属与版本，
 *   前端隐藏入口不代替后端授权；
 * - 导出结果按**逐条结论**展示（单条失败不拖垮整包）。
 *
 * **两种形态**（对齐服务端契约）：
 * - **单一类型**：调用方给 `resourceType` ＋ `recordIds`；对话框里**资源类型可选**
 *   （默认取调用方给的值），来源页不必硬编码类型；
 * - **混合形态**：调用方给 `entries`（逐条自带资源类型）⇒ 一个包里可同时有
 *   工单、报告与资料，服务端以 `entries` 为准逐条复核。
 */
export function RecordPackageExportDialog({
  open,
  resourceType,
  recordIds,
  entries,
  sessionKey,
  onClose,
}: {
  open: boolean;
  /** 单一形态的默认资源类型（对话框里可改） */
  resourceType?: RecordPackageResourceType;
  /** 单一形态的记录 ID 列表 */
  recordIds?: number[];
  /** 混合形态条目（逐条自带资源类型）；给出时优先于单一形态 */
  entries?: RecordPackageExportEntry[];
  /** 当前会话的账号标识：切账号时作废在途响应 */
  sessionKey?: number | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { state, run, reset } = useRecordPackageExport(sessionKey);
  const [targetPath, setTargetPath] = useState('');
  const [selectedType, setSelectedType] = useState<RecordPackageResourceType>(
    resourceType ?? 'REPAIR_REQUEST',
  );

  const mixedEntries = entries ?? [];
  const isMixed = mixedEntries.length > 0;
  const singleRecordIds = recordIds ?? [];

  const close = () => {
    reset();
    setTargetPath('');
    onClose();
  };

  const submitDisabled =
    targetPath.trim().length === 0 || (isMixed ? false : singleRecordIds.length === 0);

  return (
    <Modal
      cancelText={t('recordPackage.export.cancel')}
      footer={null}
      onCancel={close}
      open={open}
      title={t('recordPackage.export.dialogTitle')}
    >
      <div className="flex flex-col gap-3">
        <Input
          onChange={(event) => setTargetPath(event.target.value)}
          placeholder="/media/usb/package"
          value={targetPath}
        />

        {isMixed ? (
          <div className="flex flex-col gap-1">
            <span>{t('recordPackage.export.mode.mixed')}</span>
            <Space wrap>
              {mixedEntries.map((entry) => (
                <Tag key={`${entry.resourceType}-${entry.recordId}`}>
                  {t(resolveRecordPackageResourceTypeKey(entry.resourceType))} ·{' '}
                  {t('recordPackage.export.entry.recordId')} {entry.recordId}
                </Tag>
              ))}
            </Space>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <span>{t('recordPackage.export.resourceType')}</span>
            <Select
              onChange={(value: RecordPackageResourceType) => setSelectedType(value)}
              options={RESOURCE_TYPES.map((value) => ({
                label: t(resolveRecordPackageResourceTypeKey(value)),
                value,
              }))}
              value={selectedType}
            />
            <Space wrap>
              {singleRecordIds.map((recordId) => (
                <Tag key={recordId}>
                  {t('recordPackage.export.entry.recordId')} {recordId}
                </Tag>
              ))}
            </Space>
          </div>
        )}

        <Space>
          <Button
            disabled={submitDisabled}
            loading={state.status === 'running'}
            onClick={() => {
              if (isMixed) {
                void run({
                  targetPath: targetPath.trim(),
                  // 混合形态下 resourceType 仅为契约占位，服务端以 entries 为准
                  resourceType: 'REPAIR_REQUEST',
                  recordIds: [],
                  entries: mixedEntries,
                });
                return;
              }
              void run({
                targetPath: targetPath.trim(),
                resourceType: selectedType,
                recordIds: singleRecordIds,
              });
            }}
            type="primary"
          >
            {t('recordPackage.export.submit')}
          </Button>
        </Space>

        {state.status === 'failed' ? <Alert message={state.message} showIcon type="error" /> : null}

        {state.status === 'succeeded' ? (
          <div className="flex flex-col gap-2">
            <Space wrap>
              <Tag>
                {t('recordPackage.export.packageId')}：{state.result.packageId}
              </Tag>
              <Tag>
                {t('recordPackage.export.path')}：{state.result.packagePath}
              </Tag>
              <Tag>
                {t('recordPackage.export.summary')}：{state.result.itemExported}/
                {state.result.itemTotal}
              </Tag>
            </Space>
            {state.result.items
              .filter((item) => item.outcome === 'REJECTED')
              .map((item) => (
                <Alert
                  key={`${item.resourceType}-${item.recordId}`}
                  description={item.message ?? undefined}
                  message={`${t('recordPackage.column.recordId')} ${item.recordId}`}
                  showIcon
                  type="warning"
                />
              ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
