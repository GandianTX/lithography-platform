// src/features/record-package/ui/record-package-export-panel.tsx

import { Alert, Button, Form, Input, InputNumber, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useI18n } from '@/shared/i18n';

import { useRecordPackageExport } from '../application/use-record-package-export';
import type {
  RecordPackageExportItem,
  RecordPackageResourceType,
} from '../infrastructure/record-package.types';

import {
  resolveRecordPackageOutcomeKey,
  resolveRecordPackageResourceTypeKey,
} from './record-package-labels';

const RESOURCE_TYPES: RecordPackageResourceType[] = [
  'REFERENCE_DOCUMENT',
  'REPAIR_REQUEST',
  'MAINTENANCE_REPORT',
];

/**
 * 记录包导出面板。
 *
 * 目标目录必须是**本机绝对路径**（U盘挂载点或空目录），服务端复核后才落盘；
 * 逐条结论由服务端给出，前端如实展示（不自行判断哪些记录可导出）。
 */
export function RecordPackageExportPanel() {
  const { t } = useI18n();
  const { state, run } = useRecordPackageExport();
  const [form] = Form.useForm();

  const columns: ColumnsType<RecordPackageExportItem> = [
    {
      dataIndex: 'recordId',
      key: 'recordId',
      title: t('recordPackage.column.recordId'),
    },
    {
      dataIndex: 'outcome',
      key: 'outcome',
      render: (value: string) => (
        <Tag color={value === 'EXPORTED' ? 'success' : 'error'}>
          {t(resolveRecordPackageOutcomeKey(value))}
        </Tag>
      ),
      title: t('recordPackage.column.outcome'),
    },
    {
      dataIndex: 'message',
      key: 'message',
      render: (value: string | null) => value ?? '-',
      title: t('recordPackage.column.message'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Form<{
        targetPath: string;
        organizationId: number;
        resourceType: RecordPackageResourceType;
        recordIds: number[];
      }>
        form={form}
        layout="vertical"
        onFinish={(values) =>
          void run({
            targetPath: values.targetPath,
            organizationId: values.organizationId,
            resourceType: values.resourceType,
            recordIds: values.recordIds,
          })
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Form.Item
            label={t('recordPackage.export.resourceType')}
            name="resourceType"
            rules={[{ required: true }]}
          >
            <Select
              options={RESOURCE_TYPES.map((value) => ({
                label: t(resolveRecordPackageResourceTypeKey(value)),
                value,
              }))}
            />
          </Form.Item>
          <Form.Item
            label={t('recordPackage.export.organizationId')}
            name="organizationId"
            rules={[{ required: true }]}
          >
            <div className="w-full">
              <InputNumber min={1} />
            </div>
          </Form.Item>
          <Form.Item
            label={t('recordPackage.export.recordIds')}
            name="recordIds"
            rules={[{ required: true }]}
          >
            <Select mode="tags" tokenSeparators={[',', ' ']} />
          </Form.Item>
          <Form.Item
            label={t('recordPackage.export.targetPath')}
            name="targetPath"
            rules={[{ required: true }]}
          >
            <Input placeholder="/media/usb/package" />
          </Form.Item>
        </div>
        <Button htmlType="submit" loading={state.status === 'running'} type="primary">
          {t('recordPackage.export.submit')}
        </Button>
      </Form>

      {state.status === 'failed' ? <Alert message={state.message} showIcon type="error" /> : null}

      {state.status === 'succeeded' ? (
        <section className="flex flex-col gap-2">
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
          <Table<RecordPackageExportItem>
            columns={columns}
            dataSource={state.result.items}
            pagination={false}
            rowKey="recordId"
            size="small"
          />
        </section>
      ) : null}
    </div>
  );
}
