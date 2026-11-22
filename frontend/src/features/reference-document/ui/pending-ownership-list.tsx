// src/features/reference-document/ui/pending-ownership-list.tsx

import type { TableColumnsType } from 'antd';
import { Alert, Button, Card, Empty, Pagination, Skeleton, Table } from 'antd';
import { useNavigate } from 'react-router';

import { formatDateTimeText } from '@/shared/ui/format-date-time';

import { usePendingOwnershipList } from '../application/use-pending-ownership-list';
import type { ReferenceDocumentListItem } from '../infrastructure/reference-document.types';
import { REFERENCE_DOCUMENT_TYPE_LABELS } from '../infrastructure/reference-document.types';

import { buildPendingOwnershipDetailPath } from './reference-document-paths';

/** 来源类型展示（与普通资料库列表同口径） */
const SOURCE_KIND_LABELS: Record<string, string> = {
  INDEPENDENT_REPORT: '独立报告',
  WORK_ORDER_SUMMARY: '工单总结',
  MATERIAL: '普通资料',
};

/**
 * 归属待核实清单列定义（任务 07 R061-01）：只展示后端真实字段；
 * 上传者与所属公司即「现有归属线索」（R061-01 显示待确认条目及现有线索），
 * 长文本列统一 AntD `ellipsis`（与普通资料库列表一致）。
 */
const columns: TableColumnsType<ReferenceDocumentListItem> = [
  { dataIndex: 'title', key: 'title', ellipsis: true, title: '文档标题', width: 260 },
  {
    dataIndex: 'documentType',
    key: 'documentType',
    render: (value: string) => REFERENCE_DOCUMENT_TYPE_LABELS[value] ?? value,
    title: '文档类型',
    width: 130,
  },
  {
    key: 'sourceKind',
    render: (_value, record) => SOURCE_KIND_LABELS[record.sourceKind] ?? record.sourceKind,
    title: '来源',
    width: 120,
  },
  { dataIndex: 'creatorNickname', key: 'creatorNickname', title: '现有上传者', width: 120 },
  {
    dataIndex: 'organizationName',
    key: 'organizationName',
    ellipsis: true,
    title: '现有所属公司',
    width: 180,
  },
  {
    dataIndex: 'originalFilename',
    key: 'originalFilename',
    ellipsis: true,
    render: (value: string | null) => value ?? '纯文本',
    title: '原始文件名',
    width: 160,
  },
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (value: string) => formatDateTimeText(value),
    title: '创建时间',
    width: 180,
  },
];

/**
 * 归属待核实列表面板（任务 07 R061-01，一级管理员专用入口）。
 *
 * - 与普通资料库分开：数据来自专用 pendingOwnershipReferenceDocuments 查询
 *   （仅 PENDING + 未软删的全公司条目），不混入普通列表；
 * - 现有上传者 / 所属公司为展示线索（昵称与展示名），更正时在详情提交明确核实的
 *   目标值，不预选任何示例值（页面 V6.5 §9.4）；
 * - 点击条目进入归属待核实详情，走已实现的归属更正；
 * - 组件不读取 Session、不判定角色；二级管理员 / 工程师 / 客户直调由服务端拒绝，
 *   这里按失败态展示。
 */
export function PendingOwnershipReferenceDocumentList() {
  const navigate = useNavigate();
  const { state, goToPage, reload } = usePendingOwnershipList();

  return (
    <Card>
      <div className="flex flex-col gap-3">
        {state.status === 'loading' ? <Skeleton active paragraph={{ rows: 6 }} /> : null}

        {state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={reload} size="small">
                重试
              </Button>
            }
            showIcon
            title={state.message}
            type="error"
          />
        ) : null}

        {state.status === 'ready' && state.total === 0 ? (
          <Empty description="暂无归属待核实资料。" />
        ) : null}

        {state.status === 'ready' && state.total > 0 ? (
          <>
            {state.items.length > 0 ? (
              <Table<ReferenceDocumentListItem>
                columns={columns}
                dataSource={state.items}
                onRow={(record) => ({
                  onClick: () => navigate(buildPendingOwnershipDetailPath(record.id)),
                  style: { cursor: 'pointer' },
                })}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1150 }}
                size="small"
              />
            ) : (
              <Empty description="当前页暂无数据，请翻页返回。" />
            )}
            <div className="flex items-center justify-between">
              <span className="text-text-secondary text-sm">共 {state.total} 条</span>
              <Pagination
                current={state.page}
                onChange={goToPage}
                pageSize={state.pageSize}
                showSizeChanger={false}
                size="small"
                total={state.total}
              />
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
