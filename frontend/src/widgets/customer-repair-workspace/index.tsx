// src/widgets/customer-repair-workspace/index.tsx

import { useLayoutEffect, useRef } from 'react';
import { Alert, Button } from 'antd';
import { useNavigate } from 'react-router';

import { isAuthSessionRoleAllowedAt, useAuthSession } from '@/features/auth-session';
import {
  CustomerRepairRequestDetailPanel,
  CustomerRepairRequestListPanel,
  type CustomerRepairRequestListView,
  RepairRequestForm,
  type RepairRequestRecord,
  useCustomerRepairRequestDetailFlow,
  useCustomerRepairRequestList,
} from '@/features/repair-request';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { LoadingState } from '@/shared/ui/loading-state';
import { useMessageFeedback } from '@/shared/ui/message-feedback';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 客户维修工作台（PR5 整合工作台，负责人 2026-09-29 裁定）。
 *
 * 四个客户 URL（/customer、/customer/repair-requests/new、/customer/repair-requests、
 * /customer/repair-requests/:requestId）复用同一工作台与同一固定页头（title="客户页面"）：
 * - 首页默认 create 态：左侧保留「我的维修申请」列表上下文，右侧显示创建表单；
 * - 点击左侧「我的维修申请」入口或申请项进入 history-list / history-detail 态；
 * - 页头「发起维修申请」按钮始终保留：历史态点击恢复默认创建态，
 *   create 态重复点击 no-op（不重复挂载、不清空未提交输入）；
 * - 窄屏（<960px）单面板：create 显示表单、history-list 显示列表、history-detail 显示详情
 *   （显隐由 index.css `.customer-workspace-grid[data-mode]` 控制），标题始终保持「客户页面」。
 *
 * 边界（计划 S1）：本组件只做页面组合、选中 ID 与导航意图；列表/详情/创建/删除的
 * 请求状态机继续由 repair-request feature 的 application hook 持有，不直调 adapter、
 * 不复制 DTO / 错误映射 / 权限判断。
 *
 * 选中项真值（计划 S0-6）：URL 的 requestId 是详情目标唯一真值；列表态以当前页第一项
 * 作为默认详情；create 态不派生任何历史详情；仅当目标存在于当前已加载分页时才显示
 * active；深链目标不在本页时不误选、不伪造。
 *
 * 非法详情 URL（2026-10-02 复审 P2）：history-detail 且 requestId 为 null（路由边界
 * parseRepairRequestIdParam 把非规范 / 越界 ID 归一为 null）与「列表暂无默认目标」
 * 是两种语义——前者直显统一 not-found 外观与「返回历史列表」入口（不挂载详情 hook、
 * 不发详情 Query、不暴露删除入口）；后者仍走列表占位（加载中 / 失败 / 空库 / 越界空页）。
 */

const CUSTOMER_CREATE_PATH = '/customer';
// 创建兼容入口：与角色放行判断（SUPER_ADMIN 例外）共用同一路径常量
const REPAIR_REQUEST_CREATE_ENTRY_PATH = '/customer/repair-requests/new';
const REPAIR_REQUESTS_LIST_PATH = '/customer/repair-requests';
// 缺公司归属的补录入口（S4）：服务端门禁拒绝创建，前端只做引导，不隐藏表单
const ACCOUNT_SETTINGS_PATH = '/account/settings';
const repairRequestDetailPath = (id: number) => `${REPAIR_REQUESTS_LIST_PATH}/${id}`;

export type CustomerRepairWorkspaceMode = 'create' | 'history-list' | 'history-detail';

type CustomerRepairWorkspaceProps = {
  mode: CustomerRepairWorkspaceMode;
  /**
   * history-detail 的目标申请 ID：只接收路由边界（parseRepairRequestIdParam）解析出的
   * 有效正整数；非法 / 缺失 URL 参数由路由层归一为 null，工作台据此直显 not-found，
   * 不把非法值下传详情 hook（hook 保持「只接收已验证 ID」的窄契约）。
   */
  requestId?: number | null;
};

/**
 * 详情容器：详情 hook 只在具备详情目标时挂载（create 态不发起详情查询）。
 * 删除命令按模式编排（计划 S0-6）：
 * - history-list：走列表 hook 删除（内建分页回退与回刷），右栏随回刷结果更新为新第一项；
 * - history-detail：优先走详情 hook 删除（目标代次守卫）；从左栏删除当前 URL 目标时经
 *   工作台路由实例代次守卫（CustomerRepairWorkspace 的 deleteNavigationGenerationRef），
 *   仅当成功返回时仍停留于发起删除时的同一申请详情页才进入列表路由，
 *   列表刷新完成后选择当前页第一项。
 */
function WorkspaceDetailPane({
  deleteViaDetailFlow,
  deletingFromList,
  detailId,
  onBackToList,
  onDeleteFromList,
  onNavigateToList,
}: {
  deleteViaDetailFlow: boolean;
  deletingFromList: boolean;
  detailId: number;
  onBackToList?: () => void;
  onDeleteFromList: (id: number) => void;
  onNavigateToList: () => void;
}) {
  const notify = useMessageFeedback();
  const { state, deleting, deleteRequest } = useCustomerRepairRequestDetailFlow(detailId, notify);

  const handleDelete = () => {
    if (deleteViaDetailFlow) {
      void deleteRequest().then((deleted) => {
        if (deleted) {
          onNavigateToList();
        }
      });

      return;
    }

    onDeleteFromList(detailId);
  };

  return (
    <CustomerRepairRequestDetailPanel
      deleting={deleteViaDetailFlow ? deleting : deletingFromList}
      onBackToList={onBackToList}
      onDelete={handleDelete}
      state={state}
    />
  );
}

/** 历史态但暂无详情目标时（列表加载中 / 失败 / 空库 / 越界空页）的右栏占位。 */
function ListPlaceholderPane({
  onCreateRequest,
  onRetry,
  state,
}: {
  onCreateRequest: () => void;
  onRetry: () => void;
  state: CustomerRepairRequestListView;
}) {
  const { t } = useI18n();

  return (
    <DataCard title={t('customer.detailCardTitle')}>
      {state.status === 'loading' ? <LoadingState label={t('customer.loadingRequests')} /> : null}

      {state.status === 'failed' ? (
        <ErrorState
          action={
            <Button onClick={onRetry} size="small">
              {t('common.retry')}
            </Button>
          }
          title={t('customer.listLoadFailed')}
        />
      ) : null}

      {state.status === 'ready' && state.data.total === 0 ? (
        <EmptyState
          action={
            <Button onClick={onCreateRequest} type="primary">
              {t('customer.createButton')}
            </Button>
          }
          description={t('customer.emptyDescription')}
          title={t('customer.emptyTitle')}
        />
      ) : null}

      {state.status === 'ready' && state.data.total > 0 ? (
        <EmptyState title={t('customer.pageEmpty')} />
      ) : null}
    </DataCard>
  );
}

/**
 * 非法详情 URL 右栏（2026-10-02 复审 P2）：history-detail 且目标为 null 时直显统一
 * not-found 外观（与后端防探测一致，复用详情面板 failed 态；该态不渲染删除入口，
 * onDelete 不可达）。不挂载 WorkspaceDetailPane 即不创建详情 hook、不发详情 Query、
 * 不暴露删除命令；左栏列表不受影响，仍由其自身 hook 正常加载。
 */
function InvalidDetailPane({ onBackToList }: { onBackToList: () => void }) {
  const { t } = useI18n();

  return (
    <CustomerRepairRequestDetailPanel
      deleting={false}
      onBackToList={onBackToList}
      onDelete={() => undefined}
      state={{ message: t('customer.detailNotFound'), notFound: true, status: 'failed' }}
    />
  );
}

/**
 * create 态右栏：RepairRequestForm 作为卡片完整单列主体（2026-09-30 复审移除独立
 * 「填写提示」侧栏；字段级短提示就近挂在对应 Form.Item 小标题旁，整体业务规则放操作行，
 * 均见 RepairRequestForm，不在本层复制业务文案）。
 * 被拒角色（SUPER_ADMIN 创建页例外）不渲染表单也不发起型号查询，展示明确说明。
 */
function CreatePane({
  canCreateRepairRequest,
  needsCompanySupplement,
  onCreated,
  onOpenMyRequests,
  onOpenSettings,
  onViewCreated,
}: {
  canCreateRepairRequest: boolean;
  needsCompanySupplement: boolean;
  onCreated: (record: RepairRequestRecord) => void;
  onOpenMyRequests: () => void;
  onOpenSettings: () => void;
  onViewCreated: (record: RepairRequestRecord) => void;
}) {
  const { t } = useI18n();

  if (!canCreateRepairRequest) {
    return (
      <DataCard title={t('customer.createCardTitle')}>
        <EmptyState
          description={t('customer.createDeniedDescription')}
          title={t('customer.createDeniedTitle')}
        />
      </DataCard>
    );
  }

  return (
    <DataCard title={t('customer.createCardTitle')}>
      <div className="flex flex-col gap-4">
        {/* S4：缺公司归属时服务端会拒绝创建；只做引导，不隐藏表单（以服务端判定为准） */}
        {needsCompanySupplement ? (
          <Alert
            action={
              <Button onClick={onOpenSettings} size="small" type="primary">
                {t('common.goAccountSettings')}
              </Button>
            }
            description={t('customer.supplementDescription')}
            showIcon
            title={t('customer.supplementTitle')}
            type="warning"
          />
        ) : null}

        {/* 窄屏单面板下左栏被收起，此处提供进入「我的维修申请」的明确入口 */}
        <div className="customer-workspace-narrow-entry">
          <Button block onClick={onOpenMyRequests}>
            {t('customer.openMyRequests')}
          </Button>
        </div>

        <RepairRequestForm onCreated={onCreated} onViewCreated={onViewCreated} />
      </div>
    </DataCard>
  );
}

export function CustomerRepairWorkspace({ mode, requestId }: CustomerRepairWorkspaceProps) {
  const navigate = useNavigate();
  const notify = useMessageFeedback();
  const { t } = useI18n();
  const { session, status } = useAuthSession();
  const { state, deletingId, deleteRequest, goToPage, retry } =
    useCustomerRepairRequestList(notify);

  // 与路由层同一判断函数对齐（2026-08-29 裁定：拒绝清单禁止超管进创建页）：
  // 被拒角色的页头按钮置灰并附文字说明，右栏 create 态不渲染可用表单。
  const canCreateRepairRequest =
    status !== 'authenticated' ||
    isAuthSessionRoleAllowedAt(session.role, REPAIR_REQUEST_CREATE_ENTRY_PATH);

  // S4 归属门禁的会话侧提示：客户角色且归属为空时引导补录（服务端仍会拒绝创建）
  const needsCompanySupplement =
    status === 'authenticated' &&
    session.role === 'CUSTOMER' &&
    session.customerOrganizationId === null;

  const listItems = state.status === 'ready' ? state.data.items : [];

  // 详情目标：create 态不派生（计划 S0-6 第一条）；列表态在 ready 且非空时以当前页
  // 第一项作为右栏默认详情；详情态以 URL requestId 为唯一真值——路由层已把非法 /
  // 缺失参数归一为 null，null 在此表示「非法详情 URL」，与列表态「暂无默认目标」区分。
  const detailTargetId: number | null =
    mode === 'history-detail'
      ? (requestId ?? null)
      : mode === 'history-list'
        ? (listItems[0]?.id ?? null)
        : null;

  // active 高亮只在目标真实存在于当前已加载分页时显示（深链不在本页时不误选、不伪造）。
  const selectedRequestId =
    detailTargetId !== null && listItems.some((item) => item.id === detailTargetId)
      ? detailTargetId
      : null;

  // 左栏删除的导航守卫（2026-09-30 复审要求，与右栏详情删除的目标代次守卫等价）：
  // 发起删除时记录当时的「路由实例代次」——mode / requestId 任一变化（切到创建页、
  // 申请 B、列表页，或离开后重新进入申请 A）以及组件卸载都会推进代次。
  // 只比较申请 ID 不够：离开 A 再回到 A 时 ID 相同，但已不是当初发起删除的页面实例。
  const deleteNavigationGenerationRef = useRef(0);

  useLayoutEffect(() => {
    // 代次在 layout effect 内同步推进（幂等）：react-hooks/refs 禁止 render 期间读写
    // ref，且 render 可能被并发特性重放而自增不幂等（与详情 flow 的目标代次同口径）。
    deleteNavigationGenerationRef.current += 1;

    const generation = deleteNavigationGenerationRef.current;

    return () => {
      if (deleteNavigationGenerationRef.current === generation) {
        deleteNavigationGenerationRef.current += 1;
      }
    };
  }, [mode, requestId]);

  const navigateToCreate = () => navigate(CUSTOMER_CREATE_PATH);
  const navigateToList = () => navigate(REPAIR_REQUESTS_LIST_PATH);

  const handleCreateButton = () => {
    if (mode === 'create') {
      return; // 已处于创建态：不重复挂载、不清空未提交输入
    }

    navigateToCreate();
  };

  const handleOpenMyRequests = () => {
    if (mode !== 'history-list') {
      navigateToList();
    }
  };

  const handleSelect = (id: number) => {
    navigate(repairRequestDetailPath(id));
  };

  const handleDeleteFromList = (id: number) => {
    // 详情态从左栏删除当前 URL 目标：删除成功后进入列表路由（列表刷新后选第一项）；
    // 其余情况（列表态、或删除非当前目标）保持在列表路由并沿用列表 hook 的回刷规则。
    if (mode === 'history-detail' && detailTargetId === id) {
      const generation = deleteNavigationGenerationRef.current;

      void deleteRequest(id).then((deleted) => {
        // 仅当删除成功且仍停留在发起删除时的同一详情页实例（未卸载、未切页 / 切目标）
        // 才导航；已离开时旧请求只完成数据删除，不把用户强制带回列表；
        // 删除失败保持现场，反馈由列表 hook 的错误提示承担。
        if (deleted && deleteNavigationGenerationRef.current === generation) {
          navigateToList();
        }
      });

      return;
    }

    void deleteRequest(id);
  };

  return (
    <div className="page-stack">
      <PageHeader
        description={t('customer.headerDescription')}
        eyebrow="Customer Workspace"
        extra={
          <div className="flex flex-col items-end gap-1">
            <Button disabled={!canCreateRepairRequest} onClick={handleCreateButton} type="primary">
              {t('customer.createButton')}
            </Button>
            {canCreateRepairRequest ? null : (
              <div className="text-xs text-text-secondary">{t('customer.adminCannotCreate')}</div>
            )}
          </div>
        }
        title={t('customer.headerTitle')}
      />

      <div className="customer-workspace-grid" data-mode={mode}>
        <div className="customer-workspace-list-pane min-w-0">
          <CustomerRepairRequestListPanel
            deletingId={deletingId}
            onCreateRequest={navigateToCreate}
            onDelete={handleDeleteFromList}
            onGoToPage={goToPage}
            onOpenMyRequests={handleOpenMyRequests}
            onRetry={retry}
            onSelect={handleSelect}
            selectedRequestId={selectedRequestId}
            state={state}
          />
        </div>

        <div className="customer-workspace-detail-pane min-w-0">
          {mode === 'create' ? (
            <CreatePane
              canCreateRepairRequest={canCreateRepairRequest}
              needsCompanySupplement={needsCompanySupplement}
              onCreated={() => retry()}
              onOpenMyRequests={handleOpenMyRequests}
              onOpenSettings={() => navigate(ACCOUNT_SETTINGS_PATH)}
              onViewCreated={(record) => navigate(repairRequestDetailPath(record.id))}
            />
          ) : mode === 'history-detail' && detailTargetId === null ? (
            <InvalidDetailPane onBackToList={navigateToList} />
          ) : detailTargetId !== null ? (
            <WorkspaceDetailPane
              deleteViaDetailFlow={mode === 'history-detail'}
              deletingFromList={deletingId === detailTargetId}
              detailId={detailTargetId}
              onBackToList={mode === 'history-detail' ? navigateToList : undefined}
              onDeleteFromList={handleDeleteFromList}
              onNavigateToList={navigateToList}
            />
          ) : (
            <ListPlaceholderPane onCreateRequest={navigateToCreate} onRetry={retry} state={state} />
          )}
        </div>
      </div>
    </div>
  );
}
