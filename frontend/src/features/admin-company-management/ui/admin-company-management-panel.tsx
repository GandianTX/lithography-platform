// src/features/admin-company-management/ui/admin-company-management-panel.tsx

/**
 * 公司档案管理面板。
 *
 * 读入口按请求期会话等级分层：一级管理员看到完整列表、详情与新增/编辑入口；
 * 二级（或等级缺失）只看到最小名称名单与检索，没有任何写入口。
 * 前端分层只决定呈现，服务端始终以请求期查库结果独立裁决。
 *
 * 新增 / 编辑两个写弹窗恒定挂载、只切换 `open` / `target`，因此弹窗归属判定集中在这一层：
 * 每个弹窗一条会话代次（`useDialogSessionSeq`），打开 / 关闭 / 切换目标时在事件处理器里
 * 同步推进，提交入口捕获代次与目标主键，成功续体回来后代次与目标都仍一致才允许关闭。
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, message, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useDialogSessionSeq } from '@/shared/ui/dialog-session';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { FilterBar } from '@/shared/ui/filter-bar';
import { LoadingState } from '@/shared/ui/loading-state';
import { TableContainer } from '@/shared/ui/table-container';
import { ToolbarButton, ToolbarSearchField } from '@/shared/ui/toolbar-controls';

import {
  ADMIN_COMPANY_BINDING_STATUS_COLORS,
  ADMIN_COMPANY_BINDING_STATUS_LABELS,
  ADMIN_COMPANY_STATUS_LABELS,
  ADMIN_COMPANY_STATUS_OPTIONS,
  resolveAdminCompanyListMode,
} from '../application/admin-company-management.policy';
import type {
  AdminCompanyCommandFailureReason,
  AdminCompanyCreateDraft,
  AdminCompanyListPage,
  AdminCompanyNameOption,
  AdminCompanyProvisionResult,
  AdminCompanyRecordResult,
  AdminCompanyRow,
  AdminCompanyUpdateDraft,
  AdminOrganizationStatus,
} from '../application/admin-company-management.types';
import {
  clearSubmissionKey,
  loadOrCreateSubmissionKey,
} from '../application/admin-company-submission-key';
import { useAdminCompanyAdminBindings } from '../application/use-admin-company-admin-bindings';
import { useAdminCompanyCommands } from '../application/use-admin-company-commands';
import { useAdminCompanyCredential } from '../application/use-admin-company-credential';
import { useAdminCompanyDetail } from '../application/use-admin-company-detail';
import { useAdminCompanyList } from '../application/use-admin-company-list';

import {
  AdminCompanyCredentialConfirmModal,
  AdminCompanyCredentialModal,
  type AdminCompanyReissueTarget,
} from './admin-company-credential-modal';
import { AdminCompanyDetailModal } from './admin-company-detail-modal';
import { AdminCompanyCreateModal, AdminCompanyEditModal } from './admin-company-form-modal';

/** 主搜索防抖节奏：与管理员用户列表保持一致 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 服务端已明确拒绝且**零提交**的失败原因：此时提交标识无复用价值，必须清除。
 *
 * `save-failed`（含网络不确定与 `in-flight`）不在此列：先保留标识，重试仍落在
 * 同一次提交上，避免超时重试产生第二家公司与第二个管理员。
 */
const CREATE_CONFIRMED_ZERO_SUBMIT_REASONS: ReadonlySet<AdminCompanyCommandFailureReason> =
  new Set<AdminCompanyCommandFailureReason>([
    'invalid-input',
    'forbidden',
    'not-found',
    'duplicate-code',
    'submission-conflict',
  ]);

// antd Select 的选项值只接受字符串/数字：维修资格用 'true' / 'false' 承载，
// 在 onChange 处转回布尔，避免伪造字符串进查询模型。
const SERVICE_PROVIDER_FILTER_OPTIONS: { label: string; value: 'true' | 'false' }[] = [
  { label: '提供维修服务', value: 'true' },
  { label: '不提供维修服务', value: 'false' },
];

type AdminCompanyDialogKey = 'create' | 'edit' | 'credential-confirm';

function renderOptionalText(value: string | null): string {
  return value ?? '—';
}

/**
 * 陈旧成功的反馈措辞：写入确实发生，仍然给成功提示，
 * 但必须点名**实际提交的目标**，否则在另一个弹窗正打开时会被误读成当前目标的结果。
 */
function toTargetedSuccessMessage(name: string | null, verb: string): string {
  return name === null ? `公司档案${verb}。` : `「${name}」${verb}。`;
}

function toPaginationProps(page: AdminCompanyListPage) {
  return {
    current: page.page,
    pageSize: page.pageSize,
    showSizeChanger: false,
    showTotal: (total: number) => `共 ${total} 条`,
    total: page.total,
  };
}

export function AdminCompanyManagementPanel({ adminLevel }: { adminLevel: number | null }) {
  const mode = resolveAdminCompanyListMode(adminLevel);
  const list = useAdminCompanyList(mode);
  const commands = useAdminCompanyCommands(list.reload);
  const detail = useAdminCompanyDetail();
  const dialogSession = useDialogSessionSeq<AdminCompanyDialogKey>();
  const credential = useAdminCompanyCredential();
  const [keywordDraft, setKeywordDraft] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminCompanyRow | null>(null);
  const [reissueTarget, setReissueTarget] = useState<AdminCompanyReissueTarget | null>(null);
  const [reissueError, setReissueError] = useState<string | null>(null);

  // 当前页公司主键：绑定状态只按可见行逐条读取，不额外拉取全量受管公司
  const pageOrganizationIds = useMemo(() => {
    const state = list.state;

    return state.status === 'ready' && state.page.kind === 'full'
      ? state.page.items.map((item) => item.organizationId)
      : [];
  }, [list.state]);

  const bindings = useAdminCompanyAdminBindings({
    enabled: mode === 'full',
    organizationIds: pageOrganizationIds,
    // 列表每次重新加载都会推进请求序号：写入成功后统一回读当前页绑定状态
    revision: list.state.requestSeq,
  });

  // 主搜索防抖：输入即时回显，防抖到期才把草稿交给下一步的应用 effect
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keywordDraft);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keywordDraft]);

  // 防抖到期后应用主搜索：trim 后提交，空串回到不筛选语义；值未变化时早退
  useEffect(() => {
    const trimmed = debouncedKeyword.trim();
    const nextKeyword = trimmed === '' ? null : trimmed;

    if (list.query.keyword !== nextKeyword) {
      list.applyFilters({ keyword: nextKeyword });
    }
  }, [debouncedKeyword, list]);

  const hasActiveFilter =
    list.query.keyword !== null ||
    (mode === 'full' && (list.query.status !== null || list.query.isServiceProvider !== null));

  // 清除筛选：草稿与防抖值必须同时复位，否则防抖值里的旧关键字会被上面的应用 effect
  // 回填成一次多余请求
  const clearFilters = () => {
    setKeywordDraft('');
    setDebouncedKeyword('');
    list.applyFilters({ isServiceProvider: null, keyword: null, status: null });
  };

  const openCreateDialog = () => {
    // 只在 closed → open 的真实翻转上推进：弹窗侧守卫以 `open` 为会话身份，
    // 面板若在一次无效的重入上也推进，两层就会对「是否新会话」给出相反答案
    if (!createOpen) {
      dialogSession.advance('create');
    }

    setCreateOpen(true);
  };

  const closeCreateDialog = () => {
    dialogSession.advance('create');
    setCreateOpen(false);
  };

  const openEditDialog = (row: AdminCompanyRow) => {
    // 目标主键未变 = 同一次会话仍在继续：面板与弹窗侧都不推进，避免在途提交被误判成陈旧
    if (editTarget?.organizationId !== row.organizationId) {
      dialogSession.advance('edit');
    }

    setEditTarget(row);
  };

  const closeEditDialog = () => {
    dialogSession.advance('edit');
    setEditTarget(null);
  };

  const submitCreate = async (
    draft: AdminCompanyCreateDraft,
  ): Promise<AdminCompanyProvisionResult> => {
    const sessionSeq = dialogSession.capture('create');
    // 提交标识在发送前读取（缺失/过期则生成）：双击、超时重试、刷新恢复都复用同一标识
    const submissionKey = loadOrCreateSubmissionKey(Date.now(), window.sessionStorage);
    const execution = await commands.createCompany(draft, submissionKey);

    if (execution.kind === 'ok') {
      const result = execution.result;

      if (result.ok) {
        // 成功即本次提交已定案，下一位新增必须换新标识
        clearSubmissionKey(window.sessionStorage);

        if (dialogSession.isCurrent('create', sessionSeq)) {
          setCreateOpen(false);
          dialogSession.advance('create');
          // 业务字段与凭据全部来自同一创建结果；口令只进组件 state 的短生命周期弹窗
          credential.show({
            organizationId: result.organization.organizationId,
            organizationName: result.organization.name,
            loginName: result.provisionedAdmin.loginName,
            nickname: result.provisionedAdmin.nickname || null,
            temporaryPassword: result.temporaryPassword,
            mustChangePassword: result.provisionedAdmin.mustChangePassword,
            replayed: result.submission.replayed,
          });
          message.success('公司档案已创建。');
        } else {
          // 陈旧但写入确实发生：点名实际提交的公司，且不展示已失效会话的口令
          message.success(`「${result.organization.name}」已创建。`);
        }
      } else if (CREATE_CONFIRMED_ZERO_SUBMIT_REASONS.has(result.reason)) {
        // 服务端已明确拒绝且零提交：标识无复用价值，清除避免下次新增被误判为回放
        clearSubmissionKey(window.sessionStorage);
      }
      // save-failed（含网络不确定）保留标识：重试仍落在同一次提交上

      return result;
    }

    if (execution.kind === 'unhandled-error') {
      return { ok: false, reason: 'save-failed', message: execution.message };
    }

    // in-flight：同类命令进行中，OK 按钮已 loading，静默忽略不叠加任何提示
    return { ok: false, reason: 'save-failed', message: '' };
  };

  const submitEdit = async (draft: AdminCompanyUpdateDraft): Promise<AdminCompanyRecordResult> => {
    const sessionSeq = dialogSession.capture('edit');
    const targetId = draft.organizationId;
    // 提交时刻的行快照：陈旧成功的反馈需要点名实际提交的目标
    const targetName = editTarget?.organizationId === targetId ? editTarget.name : null;

    const execution = await commands.updateCompany(draft);

    if (execution.kind === 'ok') {
      if (execution.result.ok) {
        if (dialogSession.isCurrent('edit', sessionSeq)) {
          setEditTarget((current) =>
            current !== null && current.organizationId === targetId ? null : current,
          );
          dialogSession.advance('edit');
          message.success('公司档案已更新。');
        } else {
          message.success(toTargetedSuccessMessage(targetName, '已更新'));
        }
      }

      // 业务失败原样回传：是否写进弹窗错误区由弹窗侧代次守卫判定
      return execution.result;
    }

    if (execution.kind === 'unhandled-error') {
      return { ok: false, reason: 'save-failed', message: execution.message };
    }

    return { ok: false, reason: 'save-failed', message: '' };
  };

  const openReissueConfirm = (target: AdminCompanyReissueTarget) => {
    // 详情与确认是两个独立会话：先关详情，再为确认弹窗新建代次
    detail.close();
    setReissueError(null);
    setReissueTarget(target);
    dialogSession.advance('credential-confirm');
  };

  const closeReissueConfirm = () => {
    dialogSession.advance('credential-confirm');
    setReissueTarget(null);
    setReissueError(null);
  };

  const confirmReissue = async () => {
    const target = reissueTarget;

    if (target === null) {
      return;
    }

    const sessionSeq = dialogSession.capture('credential-confirm');
    setReissueError(null);

    const execution = await commands.reissueCredential(target.organizationId);

    if (execution.kind === 'unhandled-error') {
      if (dialogSession.isCurrent('credential-confirm', sessionSeq)) {
        setReissueError(execution.message);
      }

      return;
    }

    if (execution.kind === 'in-flight') {
      return;
    }

    const result = execution.result;

    if (!result.ok) {
      if (dialogSession.isCurrent('credential-confirm', sessionSeq)) {
        setReissueError(result.message);
      }

      return;
    }

    if (!dialogSession.isCurrent('credential-confirm', sessionSeq)) {
      // 成功但确认弹窗已被关闭/重开：口令不再展示（它随本次会话失效）
      return;
    }

    if (result.organizationId !== target.organizationId) {
      // 响应归属与确认目标不一致：口令一律丢弃，避免把 A 公司换出的口令挂在 B 名下
      setReissueError('补发结果与目标公司不一致，口令已丢弃，请刷新后重试。');
      return;
    }

    setReissueTarget(null);
    dialogSession.advance('credential-confirm');
    credential.show({
      organizationId: result.organizationId,
      organizationName: target.companyName,
      loginName: result.loginName,
      nickname: result.nickname,
      temporaryPassword: result.temporaryPassword,
      mustChangePassword: result.mustChangePassword,
      replayed: false,
    });
    message.success('临时密码已补发。');
  };

  const fullColumns: ColumnsType<AdminCompanyRow> = [
    {
      dataIndex: 'name',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-bold text-text">{row.name}</span>
          <span className="truncate text-text-tertiary text-xs">
            {renderOptionalText(row.shortName)} · {row.organizationCode}
          </span>
        </div>
      ),
      title: '公司',
    },
    {
      dataIndex: 'contactName',
      ellipsis: true,
      render: renderOptionalText,
      title: '联系人',
      width: 130,
    },
    {
      dataIndex: 'contactPhone',
      ellipsis: true,
      render: renderOptionalText,
      title: '电话',
      width: 150,
    },
    {
      dataIndex: 'contactEmail',
      ellipsis: true,
      render: renderOptionalText,
      title: '邮箱',
    },
    {
      dataIndex: 'status',
      render: (status: AdminOrganizationStatus) => (
        <Tag color={status === 'ACTIVE' ? 'success' : 'default'}>
          {ADMIN_COMPANY_STATUS_LABELS[status]}
        </Tag>
      ),
      title: '启用',
      width: 90,
    },
    {
      dataIndex: 'isServiceProvider',
      render: (isServiceProvider: boolean) => (
        <Tag color={isServiceProvider ? 'blue' : 'default'}>{isServiceProvider ? '是' : '否'}</Tag>
      ),
      title: '维修服务',
      width: 100,
    },
    {
      key: 'adminBinding',
      render: (_, row) => {
        // 未受管公司不进入绑定判定，直接说明「不适用」，避免与「未配置」混淆
        if (!row.isManagedCompany) {
          return <span className="text-text-tertiary">不受管</span>;
        }

        const entry = bindings.bindingOf(row.organizationId);

        if (!entry || entry.status === 'loading') {
          return <span className="text-text-tertiary">读取中…</span>;
        }

        if (entry.status === 'failed') {
          return (
            <Space size={4}>
              <span className="text-text-tertiary text-xs">{entry.message}</span>
              <Button size="small" type="link" onClick={bindings.retry}>
                重试
              </Button>
            </Space>
          );
        }

        const fact = entry.binding;

        return (
          <div className="flex flex-wrap items-center gap-1">
            <Tag color={ADMIN_COMPANY_BINDING_STATUS_COLORS[fact.status]}>
              {ADMIN_COMPANY_BINDING_STATUS_LABELS[fact.status]}
            </Tag>
            <span className="text-text-secondary text-xs">
              {renderOptionalText(fact.boundLoginNameMasked)}
            </span>
            {fact.accountDisabled ? <Tag color="default">账号停用</Tag> : null}
          </div>
        );
      },
      title: '二级管理员账号',
      width: 170,
    },
    {
      fixed: 'right',
      render: (_, row) => (
        <Space size={0} wrap>
          <Button size="small" type="link" onClick={() => void detail.open(row.organizationId)}>
            详情
          </Button>
          <Button size="small" type="link" onClick={() => openEditDialog(row)}>
            编辑
          </Button>
        </Space>
      ),
      title: '操作',
      width: 130,
    },
  ];

  const nameColumns: ColumnsType<AdminCompanyNameOption> = [
    { dataIndex: 'name', ellipsis: true, title: '公司名称' },
  ];

  const state = list.state;

  return (
    <>
      <TableContainer>
        <div className="flex flex-col gap-4">
          <FilterBar>
            <ToolbarSearchField
              clearLabel="清除公司搜索"
              onChange={setKeywordDraft}
              placeholder={mode === 'full' ? '搜索公司全称 / 编号 / 简称' : '搜索公司名称'}
              value={keywordDraft}
            />

            {mode === 'full' ? (
              <ToolbarButton
                active={hasActiveFilter}
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((previous) => !previous)}
              >
                筛选
              </ToolbarButton>
            ) : null}

            <div className="flex-1" />

            {mode === 'full' ? (
              <Button type="primary" onClick={openCreateDialog}>
                新增公司
              </Button>
            ) : null}

            {mode === 'full' && filterOpen ? (
              <div className="flex w-full flex-wrap items-center gap-3">
                <div className="w-36">
                  <Select<AdminOrganizationStatus | undefined>
                    allowClear
                    placeholder="启用状态"
                    style={{ width: '100%' }}
                    value={list.query.status ?? undefined}
                    onChange={(status) => list.applyFilters({ status: status ?? null })}
                    options={ADMIN_COMPANY_STATUS_OPTIONS.map((status) => ({
                      value: status,
                      label: ADMIN_COMPANY_STATUS_LABELS[status],
                    }))}
                  />
                </div>

                <div className="w-44">
                  <Select<'true' | 'false' | undefined>
                    allowClear
                    placeholder="维修资格"
                    style={{ width: '100%' }}
                    value={
                      list.query.isServiceProvider === null
                        ? undefined
                        : list.query.isServiceProvider
                          ? 'true'
                          : 'false'
                    }
                    onChange={(value) =>
                      list.applyFilters({
                        isServiceProvider: value === undefined ? null : value === 'true',
                      })
                    }
                    options={SERVICE_PROVIDER_FILTER_OPTIONS}
                  />
                </div>

                <ToolbarButton onClick={clearFilters}>清除筛选</ToolbarButton>
              </div>
            ) : null}
          </FilterBar>

          {/* 二级管理员没有写入口与精确筛选，明确说明当前可见范围，避免误以为数据缺失 */}
          {mode === 'name-only' ? (
            <p className="text-text-secondary text-sm">当前账号仅可查看公司名称名单。</p>
          ) : null}

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
            <LoadingState label="正在加载公司档案…" />
          ) : null}

          {state.status === 'ready' &&
          list.isCurrentQueryDomain &&
          state.page.items.length > 0 &&
          state.page.kind === 'full' ? (
            <Table<AdminCompanyRow>
              columns={fullColumns}
              dataSource={state.page.items}
              pagination={{
                ...toPaginationProps(state.page),
                onChange: list.goToPage,
              }}
              rowKey="organizationId"
              scroll={{ x: 1280 }}
              size="middle"
            />
          ) : null}

          {state.status === 'ready' &&
          list.isCurrentQueryDomain &&
          state.page.items.length > 0 &&
          state.page.kind === 'name' ? (
            <Table<AdminCompanyNameOption>
              columns={nameColumns}
              dataSource={state.page.items}
              pagination={{
                ...toPaginationProps(state.page),
                onChange: list.goToPage,
              }}
              rowKey="id"
              size="middle"
            />
          ) : null}

          {state.status === 'ready' &&
          list.isCurrentQueryDomain &&
          state.page.items.length === 0 ? (
            <EmptyState title={mode === 'full' ? '暂无公司档案。' : '暂无可查看的公司。'} />
          ) : null}
        </div>
      </TableContainer>

      {mode === 'full' ? (
        <>
          <AdminCompanyCreateModal
            open={createOpen}
            submitting={commands.isPending('create')}
            onCancel={closeCreateDialog}
            onSubmit={submitCreate}
          />

          <AdminCompanyEditModal
            company={editTarget}
            submitting={commands.isPending('update')}
            onCancel={closeEditDialog}
            onSubmit={submitEdit}
          />

          <AdminCompanyDetailModal
            binding={
              detail.state.status === 'ready'
                ? (bindings.bindingOf(detail.state.organization.organizationId) ?? null)
                : null
            }
            state={detail.state}
            onClose={detail.close}
            onReissue={() => {
              if (detail.state.status !== 'ready') {
                return;
              }

              const company = detail.state.organization;
              const entry = bindings.bindingOf(company.organizationId);
              const fact = entry?.status === 'ready' ? entry.binding : null;

              openReissueConfirm({
                companyName: company.name,
                loginNameMasked: fact?.boundLoginNameMasked ?? null,
                organizationId: company.organizationId,
              });
            }}
            onRetry={() => {
              if (detail.state.status === 'failed') {
                void detail.open(detail.state.organizationId);
              }
            }}
          />

          <AdminCompanyCredentialConfirmModal
            errorMessage={reissueError}
            submitting={commands.isPending('reissue-credential')}
            target={reissueTarget}
            onCancel={closeReissueConfirm}
            onConfirm={() => void confirmReissue()}
          />

          <AdminCompanyCredentialModal
            credential={credential.credential}
            onClose={credential.clear}
          />
        </>
      ) : null}
    </>
  );
}
