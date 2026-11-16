// src/features/admin-engineer-approval/ui/admin-engineer-approval-panel.tsx

/**
 * 工程师注册审批面板。
 *
 * - 队列范围由服务端按请求期会话等级裁决（一级全范围、二级仅本公司）；
 *   前端只用会话等级决定范围提示文案，不把它当授权依据；
 * - 列表只保留摘要与「详情」入口；批准 / 拒绝放在详情弹窗内，依据刚读取的
 *   同一申请详情与待审状态展示，终态一律只读；
 * - 拒绝原因必填（trim 非空），由弹窗内校验与服务端 BAD_USER_INPUT 双重保证；
 * - 并发第二人决定返回 CONFLICT 时提示「该申请已被处理」并重查队列/详情，
 *   不让本地快照继续冒充当前状态。
 */

import { useState } from 'react';
import { Button, message, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useDialogSessionSeq } from '@/shared/ui/dialog-session';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { FilterBar } from '@/shared/ui/filter-bar';
import { LoadingState } from '@/shared/ui/loading-state';
import { TableContainer } from '@/shared/ui/table-container';

import {
  ADMIN_ENGINEER_STATUS_COLORS,
  ADMIN_ENGINEER_STATUS_LABELS,
  ADMIN_ENGINEER_STATUS_OPTIONS,
  resolveAdminEngineerScopeHint,
} from '../application/admin-engineer-approval.policy';
import type {
  AdminEngineerRegistrationDetail,
  AdminEngineerRegistrationRow,
  AdminEngineerRegistrationStatus,
  AdminEngineerReviewResult,
} from '../application/admin-engineer-approval.types';
import { useAdminEngineerApprovalCommands } from '../application/use-admin-engineer-approval-commands';
import { useAdminEngineerRegistrationDetail } from '../application/use-admin-engineer-registration-detail';
import { useAdminEngineerRegistrationList } from '../application/use-admin-engineer-registration-list';

import { AdminEngineerRegistrationDetailModal } from './admin-engineer-registration-detail-modal';
import {
  AdminEngineerRejectModal,
  type AdminEngineerRejectTarget,
} from './admin-engineer-reject-modal';

type ApprovalDialogKey = 'reject';

function renderOptionalText(value: string | null): string {
  return value ?? '—';
}

function toPaginationProps(page: { page: number; pageSize: number; total: number }) {
  return {
    current: page.page,
    pageSize: page.pageSize,
    showSizeChanger: false,
    showTotal: (total: number) => `共 ${total} 条`,
    total: page.total,
  };
}

export function AdminEngineerApprovalPanel({ adminLevel }: { adminLevel: number | null }) {
  const list = useAdminEngineerRegistrationList();
  const detail = useAdminEngineerRegistrationDetail();
  const commands = useAdminEngineerApprovalCommands();
  const dialogSession = useDialogSessionSeq<ApprovalDialogKey>();
  const [rejectTarget, setRejectTarget] = useState<AdminEngineerRejectTarget | null>(null);

  /**
   * 命令发起时捕获当前详情打开会话；成功 / 冲突续体只在仍是同一会话时重查。
   * 判定读取 hook 的实时会话，不使用渲染时的目标 ID，避免晚到响应重开旧详情。
   */
  const handleConflict = (
    text: string,
    detailSession: ReturnType<typeof detail.captureCurrent>,
  ) => {
    message.warning(text);
    list.reload();
    detail.refreshIfCurrent(detailSession);
  };

  const runApprove = async (registration: AdminEngineerRegistrationDetail) => {
    const applicationId = registration.applicationId;
    const targetName = registration.applicant.nickname;
    const detailSession = detail.captureCurrent();
    const execution = await commands.approve(applicationId);

    if (execution.kind === 'in-flight') {
      return;
    }

    if (execution.kind === 'unhandled-error') {
      message.error(execution.message);
      return;
    }

    if (execution.result.ok) {
      if (detail.isCurrentSession(detailSession)) {
        message.success('该申请已通过审核。');
      } else {
        // 陈旧但写入确实发生：点名实际被批准的申请人，避免被误读成当前详情的结果
        message.success(`「${targetName}」的申请已通过审核。`);
      }

      list.reload();
      detail.refreshIfCurrent(detailSession);
      return;
    }

    if (execution.result.reason === 'state-conflict') {
      handleConflict(execution.result.message, detailSession);
      return;
    }

    message.error(execution.result.message);
  };

  const openRejectDialog = (target: AdminEngineerRejectTarget) => {
    if (rejectTarget?.applicationId !== target.applicationId) {
      dialogSession.advance('reject');
    }

    setRejectTarget(target);
  };

  const closeRejectDialog = () => {
    dialogSession.advance('reject');
    setRejectTarget(null);
  };

  const submitReject = async (reviewComment: string): Promise<AdminEngineerReviewResult> => {
    if (!rejectTarget) {
      return { ok: false, reason: 'save-failed', message: '' };
    }

    const sessionSeq = dialogSession.capture('reject');
    const applicationId = rejectTarget.applicationId;
    const targetName = rejectTarget.applicantNickname;
    const detailSession = detail.captureCurrent();
    const execution = await commands.reject(applicationId, reviewComment);

    if (execution.kind === 'ok') {
      if (execution.result.ok) {
        if (dialogSession.isCurrent('reject', sessionSeq)) {
          setRejectTarget(null);
          dialogSession.advance('reject');
          message.success('该申请已拒绝。');
        } else {
          // 陈旧但写入确实发生：点名实际提交的申请人，避免被误读成重开后那次的结果
          message.success(`「${targetName}」的申请已拒绝。`);
        }

        list.reload();
        detail.refreshIfCurrent(detailSession);
      } else if (execution.result.reason === 'state-conflict') {
        // 并发第二人决定：关闭弹窗并重查，避免本地快照继续冒充当前状态
        if (dialogSession.isCurrent('reject', sessionSeq)) {
          setRejectTarget(null);
          dialogSession.advance('reject');
        }

        handleConflict(execution.result.message, detailSession);
      }

      // 其它业务失败原样回传：是否写进弹窗错误区由弹窗侧代次守卫判定
      return execution.result;
    }

    if (execution.kind === 'unhandled-error') {
      return { ok: false, reason: 'save-failed', message: execution.message };
    }

    // in-flight：同类命令进行中，确认按钮已 loading，静默忽略不叠加任何提示
    return { ok: false, reason: 'save-failed', message: '' };
  };

  const columns: ColumnsType<AdminEngineerRegistrationRow> = [
    {
      dataIndex: 'applicant',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-bold text-text">{row.applicant.nickname}</span>
          <span className="truncate text-text-tertiary text-xs">
            {renderOptionalText(row.applicant.loginName)}
          </span>
        </div>
      ),
      title: '申请人',
      width: 160,
    },
    {
      dataIndex: 'organizationName',
      ellipsis: true,
      render: renderOptionalText,
      title: '公司',
      width: 180,
    },
    {
      dataIndex: 'applicationNote',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-text">{renderOptionalText(row.applicationNote)}</span>
          <span className="truncate text-text-tertiary text-xs">
            {renderOptionalText(row.applicant.phone)} ·{' '}
            {renderOptionalText(row.applicant.contactEmail)}
          </span>
        </div>
      ),
      title: '申请说明 · 联系方式',
    },
    {
      dataIndex: 'status',
      render: (status: AdminEngineerRegistrationStatus) => (
        <Tag color={ADMIN_ENGINEER_STATUS_COLORS[status]}>
          {ADMIN_ENGINEER_STATUS_LABELS[status]}
        </Tag>
      ),
      title: '状态',
      width: 100,
    },
    {
      fixed: 'right',
      render: (_, row) => (
        <Button size="small" type="link" onClick={() => void detail.open(row.applicationId)}>
          详情
        </Button>
      ),
      title: '操作',
      width: 100,
    },
  ];

  const state = list.state;

  return (
    <>
      <TableContainer>
        <div className="flex flex-col gap-4">
          <FilterBar>
            <div className="w-40">
              <Select<AdminEngineerRegistrationStatus | undefined>
                allowClear
                placeholder="申请状态"
                style={{ width: '100%' }}
                value={list.query.status ?? undefined}
                onChange={(status) => list.applyFilters({ status: status ?? null })}
                options={ADMIN_ENGINEER_STATUS_OPTIONS.map((status) => ({
                  label: ADMIN_ENGINEER_STATUS_LABELS[status],
                  value: status,
                }))}
              />
            </div>
          </FilterBar>

          <p className="text-text-secondary text-sm">{resolveAdminEngineerScopeHint(adminLevel)}</p>

          {state.status === 'failed' && list.isCurrentQueryDomain ? (
            <ErrorState
              action={
                <Button size="small" onClick={list.reload}>
                  重试
                </Button>
              }
              title={state.message}
            />
          ) : null}

          {state.status === 'loading' || !list.isCurrentQueryDomain ? (
            <LoadingState label="正在加载注册申请…" />
          ) : null}

          {state.status === 'ready' && list.isCurrentQueryDomain && state.page.items.length > 0 ? (
            <Table<AdminEngineerRegistrationRow>
              columns={columns}
              dataSource={state.page.items}
              pagination={{
                ...toPaginationProps(state.page),
                onChange: list.goToPage,
              }}
              rowKey="applicationId"
              scroll={{ x: 900 }}
              size="middle"
            />
          ) : null}

          {state.status === 'ready' &&
          list.isCurrentQueryDomain &&
          state.page.items.length === 0 ? (
            <EmptyState title="暂无工程师注册申请。" />
          ) : null}
        </div>
      </TableContainer>

      <AdminEngineerRegistrationDetailModal
        approving={commands.isPending('approve')}
        state={detail.state}
        onApprove={(registration) => void runApprove(registration)}
        onClose={detail.close}
        onReject={(registration) =>
          openRejectDialog({
            applicationId: registration.applicationId,
            applicantNickname: registration.applicant.nickname,
          })
        }
        onRetry={() => {
          if (detail.state.status === 'failed') {
            void detail.open(detail.state.applicationId);
          }
        }}
      />

      <AdminEngineerRejectModal
        submitting={commands.isPending('reject')}
        target={rejectTarget}
        onCancel={closeRejectDialog}
        onSubmit={submitReject}
      />
    </>
  );
}
