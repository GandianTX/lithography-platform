// src/features/record-package/ui/record-package-import-panel.tsx

import { useState } from 'react';
import { Alert, Button, Descriptions, Input, Popconfirm, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useI18n } from '@/shared/i18n';

import { useRecordPackageImport } from '../application/use-record-package-import';
import type { RecordPackageItem } from '../infrastructure/record-package.types';

import {
  resolveRecordPackageCheckResultKey,
  resolveRecordPackageCheckStatusKey,
  resolveRecordPackageItemResultKey,
  resolveRecordPackageStatusKey,
} from './record-package-labels';

/**
 * 记录包导入面板：安全预检 → 明确确认 → 受控逐项导入 → 逐条结果。
 *
 * - 预检不写正式业务；只有"预检通过"才出现确认入口；
 * - 确认按钮带**清单摘要**（服务端据此判断旧确认是否作废）；
 * - 逐条结果如实展示：成功／失败／跳过／冲突各有受控文案。
 */
export function RecordPackageImportPanel({ sessionKey }: { sessionKey?: number | null } = {}) {
  const { t } = useI18n();
  const { state, check, confirmImport, reset } = useRecordPackageImport(sessionKey);
  const [packagePath, setPackagePath] = useState('');

  const columns: ColumnsType<RecordPackageItem> = [
    {
      dataIndex: 'recordUuid',
      key: 'recordUuid',
      title: t('recordPackage.column.recordUuid'),
    },
    {
      dataIndex: 'resourceType',
      key: 'resourceType',
      title: t('recordPackage.column.resourceType'),
    },
    {
      dataIndex: 'checkResult',
      key: 'checkResult',
      render: (value: string | null) =>
        value === null ? '-' : <Tag>{t(resolveRecordPackageCheckResultKey(value))}</Tag>,
      title: t('recordPackage.column.checkResult'),
    },
    {
      dataIndex: 'result',
      key: 'result',
      render: (value: string | null, record: RecordPackageItem) => {
        if (value !== null) {
          return <Tag>{t(resolveRecordPackageItemResultKey(value))}</Tag>;
        }
        return record.checkResult === 'REJECTED' ? (
          <Tag>{t(resolveRecordPackageItemResultKey('NOT_EXECUTED'))}</Tag>
        ) : (
          '-'
        );
      },
      title: t('recordPackage.column.itemResult'),
    },
    {
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      render: (value: string | null) => value ?? '-',
      title: t('recordPackage.column.message'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="w-full">
        <Space.Compact>
          <Input
            onChange={(event) => {
              setPackagePath(event.target.value);
              // 换包即失效：清掉上一次的预检结论与确认入口
              // （旧结论不该覆盖当前选择，也不该让人确认一个屏幕上没显示的包）。
              reset();
            }}
            placeholder="/media/usb/package"
            value={packagePath}
          />
          <Button
            disabled={packagePath.trim().length === 0}
            loading={state.status === 'checking'}
            onClick={() => void check(packagePath.trim())}
            type="primary"
          >
            {t('recordPackage.import.check')}
          </Button>
        </Space.Compact>
      </div>

      {state.status === 'failed' ? (
        <Alert
          message={state.messageKey === undefined ? state.message : t(state.messageKey)}
          showIcon
          type="error"
        />
      ) : null}

      {state.status === 'checked' || state.status === 'importing' ? (
        <section className="flex flex-col gap-2">
          <Alert message={t('recordPackage.import.recheckHint')} showIcon type="info" />
          <Descriptions
            column={1}
            items={[
              {
                key: 'packageId',
                label: t('recordPackage.export.packageId'),
                children: state.check.import.packageId,
              },
              {
                key: 'packagePath',
                label: t('recordPackage.export.path'),
                children: state.packagePath,
              },
              {
                key: 'manifestChecksum',
                label: t('recordPackage.import.manifestChecksum'),
                children: state.check.import.manifestChecksum,
              },
              {
                key: 'checkStatus',
                label: t('recordPackage.import.checkStatus'),
                children: t(
                  resolveRecordPackageCheckStatusKey(state.check.import.checkStatus ?? 'PENDING'),
                ),
              },
            ]}
            size="small"
          />
          <Table<RecordPackageItem>
            columns={columns}
            dataSource={state.check.items}
            pagination={false}
            rowKey="itemId"
            size="small"
          />
          <Popconfirm
            cancelText={t('recordPackage.import.cancel')}
            description={t('recordPackage.import.confirmDescription')}
            okText={t('recordPackage.import.confirm')}
            onConfirm={() => confirmImport()}
            title={t('recordPackage.import.confirmTitle')}
          >
            <Button
              disabled={state.check.import.checkStatus !== 'PASSED' || state.status === 'importing'}
              loading={state.status === 'importing'}
              type="primary"
            >
              {t('recordPackage.import.confirm')}
            </Button>
          </Popconfirm>
        </section>
      ) : null}

      {state.status === 'imported' ? (
        <section className="flex flex-col gap-2">
          <Space wrap>
            <Tag>
              {t('recordPackage.import.status')}：
              {t(resolveRecordPackageStatusKey(state.result.import.status))}
            </Tag>
            <Tag>
              {t('recordPackage.import.summary')}：{state.result.import.itemSucceeded}/
              {state.result.import.itemTotal}
            </Tag>
          </Space>
          <Table<RecordPackageItem>
            columns={columns}
            dataSource={state.result.items}
            pagination={false}
            rowKey="itemId"
            size="small"
          />
        </section>
      ) : null}
    </div>
  );
}
