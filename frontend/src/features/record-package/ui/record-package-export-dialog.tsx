// src/features/record-package/ui/record-package-export-dialog.tsx

import { useState } from 'react';
import { Alert, Button, Input, Modal, Space, Tag } from 'antd';

import { useI18n } from '@/shared/i18n';

import { useRecordPackageExport } from '../application/use-record-package-export';
import type { RecordPackageResourceType } from '../infrastructure/record-package.types';

/**
 * 记录包导出对话框（任务 09 S3 补丁 P1：来源页导出入口）。
 *
 * - 目标目录必须是**本机绝对路径**（U盘挂载点或空目录），服务端复核后才落盘；
 * - **不要求用户手抄公司 ID**：省略公司时由服务端按可信 session 范围取本公司；
 * - 记录标识由调用方（来源记录页）给出，服务端逐条复核归属与版本，
 *   前端隐藏入口不代替后端授权；
 * - 导出结果按**逐条结论**展示（单条失败不拖垮整包）。
 */
export function RecordPackageExportDialog({
  open,
  resourceType,
  recordIds,
  onClose,
}: {
  open: boolean;
  resourceType: RecordPackageResourceType;
  recordIds: number[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { state, run, reset } = useRecordPackageExport();
  const [targetPath, setTargetPath] = useState('');

  const close = () => {
    reset();
    setTargetPath('');
    onClose();
  };

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
        <Space>
          <Button
            disabled={targetPath.trim().length === 0 || recordIds.length === 0}
            loading={state.status === 'running'}
            onClick={() =>
              void run({
                targetPath: targetPath.trim(),
                resourceType,
                recordIds,
              })
            }
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
                  key={item.recordId}
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
