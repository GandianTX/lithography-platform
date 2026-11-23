// src/features/record-package/ui/record-package-export-panel.tsx

import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Radio, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useI18n } from '@/shared/i18n';

import { useRecordPackageExport } from '../application/use-record-package-export';
import type {
  RecordPackageExportEntry,
  RecordPackageExportItem,
  RecordPackageResourceType,
} from '../infrastructure/record-package.types';
import { normalizeRecordIds } from '../infrastructure/record-package-adapter';

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
 *
 * 两种导出方式（R070 的正式入口）：
 * - **单一类型**：一种记录类型 ＋ 多个记录 ID（来源页入口同此口径）；
 * - **混合导出**：逐条自带记录类型，一次导出可同时包含工单、报告与资料；
 *   服务端逐条复核归属、版本与权限，单条失败不拖垮整包。
 */
export function RecordPackageExportPanel() {
  const { t } = useI18n();
  const { state, run } = useRecordPackageExport();
  const [form] = Form.useForm();
  const [mode, setMode] = useState<'SINGLE' | 'MIXED'>('SINGLE');
  // 混合形态的条目条数：由增删入口显式维护（Form.List 的变化不触发 useWatch），
  // 用于"至少一条"的失败关闭（不允许提交空混合包）
  const [mixedEntryCount, setMixedEntryCount] = useState(0);

  const columns: ColumnsType<RecordPackageExportItem> = [
    {
      dataIndex: 'recordId',
      key: 'recordId',
      title: t('recordPackage.column.recordId'),
    },
    {
      dataIndex: 'resourceType',
      key: 'resourceType',
      render: (value: string) => t(resolveRecordPackageResourceTypeKey(value)),
      title: t('recordPackage.export.resourceType'),
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
        recordIds: Array<number | string>;
        entries: Array<{ resourceType: RecordPackageResourceType; recordId: number }>;
      }>
        form={form}
        layout="vertical"
        onFinish={(values) => {
          if (mode === 'MIXED') {
            // 混合形态：逐条自带资源类型；空条目直接失败关闭（不发出空包请求）
            const entries = (values.entries ?? []).filter(
              (entry) =>
                entry?.resourceType &&
                Number.isInteger(entry.recordId) &&
                (entry.recordId ?? 0) > 0,
            ) as RecordPackageExportEntry[];
            if (entries.length === 0) {
              return;
            }
            void run({
              targetPath: values.targetPath,
              organizationId: values.organizationId,
              // resourceType 在混合形态下仅为契约占位，服务端以 entries 为准
              resourceType: 'REPAIR_REQUEST',
              recordIds: [],
              entries,
            });
            return;
          }
          const rawRecordIds = values.recordIds ?? [];
          const recordIds = normalizeRecordIds(rawRecordIds);
          // 失败关闭：填了记录 ID 但全都不是正整数时，不发请求
          if (rawRecordIds.length > 0 && recordIds.length === 0) {
            return;
          }
          void run({
            targetPath: values.targetPath,
            organizationId: values.organizationId,
            resourceType: values.resourceType ?? 'REPAIR_REQUEST',
            recordIds,
          });
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Form.Item label={t('recordPackage.export.mode')}>
            <Radio.Group
              buttonStyle="solid"
              onChange={(event) => {
                const value = event.target.value as 'SINGLE' | 'MIXED';
                setMode(value);
                // 切换形态时清掉另一形态的残留，避免提交出与形态不符的字段
                if (value === 'MIXED') {
                  form.setFieldValue('resourceType', 'REPAIR_REQUEST');
                  form.setFieldValue('recordIds', []);
                } else {
                  form.setFieldValue('entries', []);
                }
                setMixedEntryCount(0);
              }}
              optionType="button"
              value={mode}
            >
              <Radio.Button value="SINGLE">{t('recordPackage.export.mode.single')}</Radio.Button>
              <Radio.Button value="MIXED">{t('recordPackage.export.mode.mixed')}</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            label={t('recordPackage.export.organizationId')}
            name="organizationId"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label={t('recordPackage.export.targetPath')}
            name="targetPath"
            rules={[{ required: true }]}
          >
            <Input placeholder="/media/usb/package" />
          </Form.Item>
        </div>

        {mode === 'SINGLE' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Form.Item
              initialValue="REPAIR_REQUEST"
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
              label={t('recordPackage.export.recordIds')}
              name="recordIds"
              rules={[{ required: true }]}
            >
              <Select mode="tags" tokenSeparators={[',', ' ']} />
            </Form.Item>
          </div>
        ) : (
          <Form.List name="entries">
            {(fields, { add, remove }) => (
              <div className="flex flex-col gap-2">
                {fields.map((field) => (
                  <div className="grid gap-2 md:grid-cols-3" key={field.key}>
                    <Form.Item
                      label={t('recordPackage.export.entry.resourceType')}
                      name={[field.name, 'resourceType']}
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
                      label={t('recordPackage.export.entry.recordId')}
                      name={[field.name, 'recordId']}
                      rules={[{ required: true }]}
                    >
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                    <Button
                      danger
                      onClick={() => {
                        remove(field.name);
                        setMixedEntryCount((count) => Math.max(0, count - 1));
                      }}
                      size="small"
                      type="text"
                    >
                      {t('recordPackage.export.entry.remove')}
                    </Button>
                  </div>
                ))}
                <Button
                  block
                  onClick={() => {
                    add({ resourceType: 'REPAIR_REQUEST', recordId: 1 });
                    setMixedEntryCount((count) => count + 1);
                  }}
                  size="small"
                  type="dashed"
                >
                  {t('recordPackage.export.entry.add')}
                </Button>
              </div>
            )}
          </Form.List>
        )}

        <Button
          disabled={mode === 'MIXED' && mixedEntryCount === 0}
          htmlType="submit"
          loading={state.status === 'running'}
          type="primary"
        >
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
            rowKey={(item) => `${item.resourceType}-${item.recordId}`}
            size="small"
          />
        </section>
      ) : null}
    </div>
  );
}
