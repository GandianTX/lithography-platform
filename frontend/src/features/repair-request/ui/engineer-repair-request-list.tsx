// src/features/repair-request/ui/engineer-repair-request-list.tsx

/**
 * 工程师维修申请列表面板。
 *
 * - 四态视图（ALL / AVAILABLE / MINE / TAKEN_BY_OTHER）取值即 GraphQL 参数，
 *   默认 ALL，不创建第三套前端状态值；
 * - 筛选（设备型号 / 客户昵称关键词）与四态组合，值只来自后端真实查询，
 *   不在前端对当前页做二次假过滤；筛选或范围变化都回到第 1 页；
 * - 工具区沿用历史维修记录库的「主搜索 + 筛选按钮 + 展开区」交互：四态与主搜索常驻，
 *   设备型号与清除筛选收进展开区；主搜索复用跨页共享中性原语 `ToolbarSearchField` /
 *   `ToolbarButton`（不复制近似实现，也不消费知识库页专属的 .kb-* 类），
 *   输入即时回显、防抖后自动应用，trim 后空串回到不筛选语义；
 * - 九个业务字段归为「申请 / 客户 / 设备 / 处理进度」四组，组内主次两行，
 *   长文本可换行或截断并保留完整可见途径（Tooltip），字段一个都不删；
 *   表格最小宽度固定为四组实际所需值，1440×900 的主内容宽度内不产生横向滚动，
 *   窄屏时横向滚动只发生在表格内部；
 * - 加载 / 失败（含重试）/ 全局空态 / 筛选无结果 / 当前页空态分别处理，
 *   一律复用 PR1 公共状态组件与容器；
 * - 点击列表项进入工程师详情路由；
 * - 页面与 UI 不解析 Apollo 原始错误：流程状态来自 feature application，
 *   transport 文案已由共享错误模型归一。
 */

import { useCallback, useEffect, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Button, Pagination, Segmented, Select, Table, Tooltip } from 'antd';
import { useNavigate } from 'react-router';

import { isGraphQLIngressError } from '@/shared/graphql';
import type { Translate } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { FilterBar } from '@/shared/ui/filter-bar';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import {
  REPAIR_HANDLING_RESULT_LABELS,
  REPAIR_HANDLING_STATUS_LABELS,
  resolveRepairClosureState,
} from '@/shared/ui/repair-request-status-labels';
import { TableContainer } from '@/shared/ui/table-container';
import { ToolbarButton, ToolbarSearchField } from '@/shared/ui/toolbar-controls';

import { useEngineerRepairRequestList } from '../application/use-engineer-repair-request-list';
import type {
  EngineerRepairListScope,
  EngineerRepairRequestListItem,
} from '../infrastructure/engineer-repair-request.types';
import type { EquipmentModelOption } from '../infrastructure/repair-request.types';
import { fetchEquipmentModels } from '../infrastructure/repair-request-adapter';

import { ENGINEER_REPAIR_REQUEST_DETAIL_PATH } from './engineer-repair-request-paths';
import {
  AcceptanceViewStatusTag,
  ClosureStatusTag,
  ResolutionTag,
} from './repair-request-status-tags';

const SCOPE_VALUES: EngineerRepairListScope[] = ['ALL', 'AVAILABLE', 'MINE', 'TAKEN_BY_OTHER'];

/** 主搜索防抖：输入即时回显，防抖到期后才提交筛选（与历史维修记录库标题搜索同一口径） */
export const SEARCH_DEBOUNCE_MS = 300;

/** 四组列宽合计 860：1440×900 主内容宽度内无需横向滚动，窄屏只在表格内部滚动 */
const COLUMNS_MIN_WIDTH = 880;

type ModelOptionsState =
  | { status: 'loading' }
  // 失败态保留原始 error，文案在渲染期按当前语言翻译：
  // 若在拉取时把 t 写进状态与 useCallback 依赖，切语言会连带重发 EquipmentModels。
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; models: EquipmentModelOption[] };

function WorkOrderProgressCell({ record }: { record: EngineerRepairRequestListItem }) {
  const closureState = resolveRepairClosureState(record.closureStatus, record.closedAt);
  const closed = closureState === 'CLOSED';
  const resultLabel = record.handlingResult
    ? REPAIR_HANDLING_RESULT_LABELS[record.handlingResult]
    : null;
  const statusLabel = record.handlingStatus
    ? REPAIR_HANDLING_STATUS_LABELS[record.handlingStatus]
    : null;
  const showResultText =
    resultLabel !== null && !(closed && record.handlingResult === 'INTERRUPTED');

  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1">
        <AcceptanceViewStatusTag viewStatus={record.acceptanceViewStatus} />
        <ClosureStatusTag
          closureStatus={record.closureStatus}
          closedAt={record.closedAt}
          handlingResult={record.handlingResult}
        />
        {showResultText ? <span className="text-text-secondary text-xs">{resultLabel}</span> : null}
      </span>
      <span className="text-text-secondary text-xs">
        {closed
          ? record.closedAt
            ? `结单于 ${formatDateTimeText(record.closedAt)}`
            : '已结单'
          : closureState === 'UNKNOWN'
            ? `结单状态未知 · 处理状态：${statusLabel ?? '未记录'}`
            : `处理状态：${statusLabel ?? '未记录'}`}
      </span>
      {record.latestResolutionStatus ? (
        <span className="flex flex-wrap items-center gap-1 text-text-tertiary text-xs">
          <span>最后回复</span>
          <ResolutionTag status={record.latestResolutionStatus} />
        </span>
      ) : null}
      {record.acceptedEngineerNickname || record.acceptedAt ? (
        <span className="flex flex-wrap items-center gap-1 text-xs">
          <span className="font-bold text-text">{record.acceptedEngineerNickname ?? '—'}</span>
          <span aria-hidden className="text-text-tertiary">
            ·
          </span>
          <span className="text-text-tertiary">
            {record.acceptedAt ? formatDateTimeText(record.acceptedAt) : '尚未接单'}
          </span>
        </span>
      ) : (
        <span className="text-text-tertiary text-xs">尚未接单</span>
      )}
    </span>
  );
}

function toModelOptionsUserMessage(error: unknown, t: Translate): string {
  return isGraphQLIngressError(error) ? error.userMessage : t('common.modelsLoadFailed');
}

/** 纯拉取：只产出下一状态，不直接写 state（与创建表单同一模式），供初始加载与重试共用 */
async function loadModelOptionsState(): Promise<ModelOptionsState> {
  try {
    const models = await fetchEquipmentModels();
    return { status: 'ready', models };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/** 组内主行：字号与字重统一，长内容按需截断（完整值走 Tooltip） */
function GroupPrimary({ children, truncate = false }: { children: string; truncate?: boolean }) {
  return truncate ? (
    <Tooltip title={children}>
      <span className="truncate font-bold text-text text-xs">{children}</span>
    </Tooltip>
  ) : (
    <span className="wrap-break-word font-bold text-text text-xs">{children}</span>
  );
}

function createColumns(t: Translate): TableColumnsType<EngineerRepairRequestListItem> {
  return [
    {
      key: 'application',
      render: (_value, record) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-bold font-mono text-primary text-xs">{record.requestNo}</span>
          <span className="text-text-tertiary text-xs">{formatDateTimeText(record.createdAt)}</span>
        </span>
      ),
      title: t('repairList.col.application'),
      width: 210,
    },
    {
      key: 'customer',
      render: (_value, record) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <GroupPrimary>{record.customerNickname}</GroupPrimary>
          <span className="text-text-secondary text-xs">{record.customerCompanyName ?? '—'}</span>
        </span>
      ),
      title: t('repairList.col.customer'),
      width: 170,
    },
    {
      key: 'equipment',
      render: (_value, record) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <GroupPrimary
            truncate
          >{`${record.equipmentModel.modelName}（${record.equipmentModel.modelCode}）`}</GroupPrimary>
          <span className="text-text-secondary text-xs">{record.errorCode}</span>
        </span>
      ),
      title: t('repairList.col.equipment'),
      width: 240,
    },
    {
      key: 'progress',
      render: (_value, record) => <WorkOrderProgressCell record={record} />,
      title: t('repairList.col.progress'),
      width: 240,
    },
  ];
}

export function EngineerRepairRequestList({
  initialScope = 'ALL',
}: {
  /** 初始范围（缺省 ALL）：供列表路由以状态参数恢复「我的接单」等入口 */
  initialScope?: EngineerRepairListScope;
}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { state, scope, filter, setScope, setFilter, goToPage, reload } =
    useEngineerRepairRequestList(initialScope);

  // 设备型号筛选选项来自后端真实查询（与创建表单同一数据源与加载状态口径）
  const [modelsState, setModelsState] = useState<ModelOptionsState>({ status: 'loading' });
  const loadModels = useCallback(() => {
    void loadModelOptionsState().then(setModelsState);
  }, []);

  // 重试：先显式回到 loading——失败态立即消失（重试按钮随之卸载，天然防连点）、
  // Select 转为禁用 loading 态；初始挂载本就是 loading，不走此路径（避免 effect 内同步 setState）
  const retryModels = useCallback(() => {
    setModelsState({ status: 'loading' });
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // 主搜索（客户昵称）草稿：输入即时回显，防抖值才提交筛选，不逐字符发查询
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [debouncedNickname, setDebouncedNickname] = useState('');
  // 筛选展开区：设备型号与清除筛选收进展开区，常驻行只留四态与主搜索
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedNickname(nicknameDraft);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [nicknameDraft]);

  // 防抖到期后应用主搜索：trim 后提交，空串回到不筛选语义（页码由状态机统一回第 1 页）。
  // 这里读最新的 filter（含展开区已选的设备型号），不把型号覆盖回 null；
  // 值未变化时状态机自身早退，不会因 filter 引用变化重复发请求。
  useEffect(() => {
    const trimmed = debouncedNickname.trim();
    setFilter({ ...filter, customerNickname: trimmed === '' ? null : trimmed });
  }, [debouncedNickname, filter, setFilter]);

  const hasActiveFilter = filter.equipmentModelId !== null || filter.customerNickname !== null;

  // 清除筛选：草稿与防抖值必须同时复位，否则防抖值里仍留着旧昵称，
  // 应用 effect 会立刻把旧昵称回填成一次多余请求（列表闪回筛选无结果态）
  const clearFilters = () => {
    setNicknameDraft('');
    setDebouncedNickname('');
    setFilter({ equipmentModelId: null, customerNickname: null });
  };

  return (
    <TableContainer title={t('repairList.title')}>
      <div className="flex flex-col gap-4">
        <FilterBar>
          {/* 四态选项宽度不可压缩：容器按可用宽度收缩，超出部分由本控件自身滚动，
              保证窄屏整页与导航不横向溢出（计划 V2.3） */}
          <div className="max-w-full min-w-0 overflow-x-auto">
            <Segmented
              onChange={(value) => setScope(value as EngineerRepairListScope)}
              options={SCOPE_VALUES.map((value) => ({
                label: t(`repairList.scope.${value}`),
                value,
              }))}
              value={scope}
            />
          </div>
          <ToolbarSearchField
            clearLabel={t('repairList.searchClear')}
            onChange={setNicknameDraft}
            placeholder={t('repairList.searchPlaceholder')}
            value={nicknameDraft}
          />
          <ToolbarButton
            active={hasActiveFilter}
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((previous) => !previous)}
          >
            {t('repairList.filter')}
          </ToolbarButton>

          {/* 展开区：主搜索之外的精确条件；原型无展开态，属业务扩展 */}
          {filterOpen ? (
            <>
              <Select<number | null>
                allowClear
                disabled={modelsState.status !== 'ready'}
                loading={modelsState.status === 'loading'}
                onChange={(value) => setFilter({ ...filter, equipmentModelId: value ?? null })}
                options={
                  modelsState.status === 'ready'
                    ? modelsState.models.map((model) => ({
                        label: `${model.modelName}（${model.modelCode}）`,
                        value: model.id,
                      }))
                    : []
                }
                placeholder={
                  modelsState.status === 'failed'
                    ? t('repairList.modelUnavailable')
                    : t('repairList.filterByModel')
                }
                style={{ minWidth: 220 }}
                value={filter.equipmentModelId}
              />
              <ToolbarButton onClick={clearFilters}>{t('repairList.clearFilter')}</ToolbarButton>
            </>
          ) : null}
        </FilterBar>

        {modelsState.status === 'failed' ? (
          <ErrorState
            action={
              <Button onClick={retryModels} size="small">
                {t('common.retry')}
              </Button>
            }
            title={toModelOptionsUserMessage(modelsState.error, t)}
          />
        ) : null}

        {state.status === 'loading' ? <LoadingState label={t('repairList.loading')} /> : null}

        {state.status === 'failed' ? (
          <ErrorState
            action={
              <Button onClick={reload} size="small">
                {t('common.retry')}
              </Button>
            }
            title={state.message}
          />
        ) : null}

        {state.status === 'ready' && state.total === 0 ? (
          hasActiveFilter ? (
            <EmptyState
              action={
                <Button onClick={clearFilters} size="small">
                  {t('repairList.clearFilter')}
                </Button>
              }
              title={t('repairList.noFilterResult')}
            />
          ) : (
            <EmptyState title={t(`repairList.empty.${scope}`)} />
          )
        ) : null}

        {state.status === 'ready' && state.total > 0 ? (
          <div className="flex flex-col gap-4">
            {state.items.length > 0 ? (
              <Table<EngineerRepairRequestListItem>
                columns={createColumns(t)}
                dataSource={state.items}
                onRow={(record) => ({
                  onClick: () => navigate(`${ENGINEER_REPAIR_REQUEST_DETAIL_PATH}${record.id}`),
                  style: { cursor: 'pointer' },
                })}
                pagination={false}
                rowKey="id"
                scroll={{ x: COLUMNS_MIN_WIDTH }}
              />
            ) : (
              <EmptyState title={t('repairList.pageEmpty')} />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-text-secondary text-xs">
                {t('repairList.total', { count: state.total })}
              </span>
              <Pagination
                current={state.page}
                onChange={goToPage}
                pageSize={state.pageSize}
                showSizeChanger={false}
                total={state.total}
              />
            </div>
          </div>
        ) : null}
      </div>
    </TableContainer>
  );
}
