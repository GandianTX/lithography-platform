// src/pages/admin-operation-records/index.tsx

import { useCallback } from 'react';
import { Alert, Button, Card, Empty, Pagination, Skeleton } from 'antd';

import {
  fetchOperationRecords,
  type OperationRecordItem,
  OperationRecordsTable,
  useOperationRecordsList,
} from '@/features/admin-operation-records';
import { resolveAuthSessionAdminScope, useAuthSession } from '@/features/auth-session';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 关键操作记录页（任务 10 S3，页面 V6.5 §14.1，V44 页面细则 2026-11-20）。
 *
 * - 只读：仅消费 SUPER_ADMIN 专用 `managementAuditEvents` Query，无任何写入口；
 * - 路由治理复用 protectedRouteLoader 与 /admin/** 角色策略；页面入口按
 *   `resolveAuthSessionAdminScope` 过滤（scope==='NONE' 不取数）；
 * - 副标题按管理员等级分档（一级「查看全部公司的关键操作。」／二级「查看本公司的关键操作。」），
 *   与 V44 `V24page` 的等级文案一致；
 * - 单张白色「操作记录」卡片承载无权限／加载／错误／空态／列表多种形态，卡片结构在加载期保持不变；
 * - 会话或可信公司变化（reloadKey）触发回到第 1 页重载，旧响应由 requestSeq 隔离；
 * - 范围完全由后端裁决（一级全公司含 NULL 行，二级限可信公司），前端不传范围参数；
 * - `operation` 为 GraphQL 枚举：非三类数据无法被协议解析，前端不做兜底放行。
 */
export function AdminOperationRecordsPage() {
  const { t } = useI18n();
  const { session } = useAuthSession();
  const adminScope = session ? resolveAuthSessionAdminScope(session) : 'NONE';
  const enabled = adminScope !== 'NONE';
  // 一级含 GLOBAL（等级1且有可信组织）与 PLATFORM（等级1无组织）两种形态，二级为 ORGANIZATION。
  const isLevelOne = adminScope === 'GLOBAL' || adminScope === 'PLATFORM';
  // 会话尚未就绪时属于「权限尚未确认」：不显示任何既有账号的数据。
  const permissionConfirmed = session !== null;

  // 身份键必须覆盖「账号 + 等级 + 可信公司」三项：
  // 等级变化会改变服务端数据范围（同一公司下二级只看本公司、一级看全公司），
  // 只用账号+公司会让等级变化后的旧范围数据继续留在页面上。
  const reloadKey = [
    session?.accountId ?? 'anon',
    session?.adminLevel ?? 'na',
    session?.adminOrganizationId ?? 'global',
  ].join(':');

  const fetcher = useCallback(
    (page: number, pageSize: number) => fetchOperationRecords(page, pageSize),
    [],
  );

  const { state, goToPage, reload } = useOperationRecordsList<OperationRecordItem>(
    fetcher,
    reloadKey,
    {
      enabled,
      failureMessage: t('operationRecords.loadFailed'),
    },
  );

  // 失权（会话切换到无权账号、等级缺失）时一律不渲染既有数据，避免上一账号的内容外泄。
  const showForbidden = permissionConfirmed && !enabled;
  const showLoading = !showForbidden && (!enabled || state.status === 'loading');

  return (
    <div className="page-stack">
      <PageHeader
        description={
          // 无管理范围（未就绪或已失权）时不显示等级副标题：
          // 等级文案只描述一级/二级的可见范围，对无权账号会误导。
          !permissionConfirmed || !enabled
            ? undefined
            : t(
                isLevelOne
                  ? 'operationRecords.page.description.level1'
                  : 'operationRecords.page.description.level2',
              )
        }
        eyebrow="ADMIN AUDIT"
        title={t('admin.operationRecords.title')}
      />

      <Card title={t('operationRecords.card.title')}>
        {showForbidden ? (
          <Empty
            description={t('operationRecords.forbidden')}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : null}
        {showLoading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
        {enabled && state.status === 'failed' ? (
          <Alert
            action={
              <Button onClick={reload} size="small">
                {t('common.retry')}
              </Button>
            }
            showIcon
            title={state.message}
            type="error"
          />
        ) : null}
        {enabled && state.status === 'ready' && state.total === 0 ? (
          <Empty description={t('operationRecords.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : null}
        {enabled && state.status === 'ready' && state.total > 0 ? (
          <>
            {state.items.length === 0 ? (
              <Alert
                description={t('operationRecords.pageOutOfRange', {
                  page: state.page,
                  total: state.total,
                })}
                showIcon
                title={t('operationRecords.pageOutOfRangeTitle')}
                type="warning"
              />
            ) : null}
            <OperationRecordsTable items={state.items} />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                {t('operationRecords.totalCount', { total: state.total })}
              </span>
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
      </Card>
    </div>
  );
}
