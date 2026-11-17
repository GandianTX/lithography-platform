// src/features/admin-user-management/ui/admin-user-management-panel.tsx

/**
 * 管理员用户管理面板（任务 08.4）。
 *
 * 本期只开放 V6.4 允许的动作：查看范围内普通用户、启停、重置为系统默认密码。
 * 创建、资料编辑、删除、改角色/等级入口均不在页面上出现（后端遗留签名保留，
 * 但只对一级管理员开放，前端不再调用）。
 *
 * 两个写弹窗都恒定挂载在本组件中、只切换 `open` / `row`，因此弹窗归属判定集中在这一层：
 * 每个弹窗一条**会话代次**（`useDialogSessionSeq`），打开 / 关闭 / 切换目标时在事件处理器里
 * 同步推进，提交入口捕获代次与目标 accountId，成功续体回来后代次与 accountId 都仍一致才允许关闭。
 * 弹窗内部的错误区另由弹窗侧的 `useStaleSubmitGuard` 把守，两层互不代替。
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { CopyOutlined } from '@ant-design/icons';
import { Button, message, Select, Space, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { useDialogSessionSeq } from '@/shared/ui/dialog-session';
import { EmptyState } from '@/shared/ui/empty-state';
import { ErrorState } from '@/shared/ui/error-state';
import { FilterBar } from '@/shared/ui/filter-bar';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import { TableContainer } from '@/shared/ui/table-container';
import { ToolbarButton, ToolbarSearchField } from '@/shared/ui/toolbar-controls';

import {
  ADMIN_USER_CONTACT_LINES,
  buildAdminUserContactCopyText,
  normalizeAdminUserContactValue,
  writeAdminUserContactCopyText,
} from '../application/admin-user-contact-copy';
import type {
  AdminUserCommandResult,
  AdminUserFilterRole,
  AdminUserRole,
  AdminUserRow,
  AdminUserStatusFilter,
} from '../application/admin-user-management.types';
import {
  ADMIN_USER_ROLE_FILTER_OPTIONS,
  ADMIN_USER_ROLE_LABELS,
  ADMIN_USER_ROW_READ_ONLY_REASON,
  ADMIN_USER_STATUS_FILTER_OPTIONS,
  ADMIN_USER_STATUS_LABELS,
  canManageLevelTwoCredentials,
  canResetAdminUserPassword,
  canToggleAdminUserStatus,
  isAdminUserRowReadOnly,
  isAdminUserStatusWritable,
  resolveAdminUserScopeHint,
} from '../application/admin-user-management-policy';
import { useAdminLevelTwoCredential } from '../application/use-admin-level-two-credential';
import { useAdminUserCommands } from '../application/use-admin-user-commands';
import { useAdminUserList } from '../application/use-admin-user-list';

import {
  AdminLevelTwoCredentialModal,
  type AdminLevelTwoResetInput,
  type AdminLevelTwoResetOutcome,
} from './admin-level-two-credential-modal';
import { AdminUserResetPasswordModal, AdminUserStatusModal } from './admin-user-row-command-modals';

const ROLE_TAG_COLORS: Record<AdminUserRole, string> = {
  CUSTOMER: 'green',
  ENGINEER: 'blue',
  SUPER_ADMIN: 'gold',
};

/** 主搜索防抖节奏：与工程师维修申请列表保持一致（输入即时回显、防抖值才提交筛选） */
const SEARCH_DEBOUNCE_MS = 300;

/** 行级弹窗的会话标识：每个弹窗一条独立代次，以目标 accountId 为会话身份 */
type AdminUserDialogKey = 'status' | 'reset-password' | 'level-two-credential';

type AdminUserRowSetter = Dispatch<SetStateAction<AdminUserRow | null>>;

function renderOptionalText(value: string | null): string {
  return value ?? '—';
}

/**
 * 陈旧成功的反馈措辞：写入确实发生，因此仍然给成功提示，
 * 但必须点名**实际提交的目标**，否则在另一个弹窗正打开时会被误读成当前目标的结果。
 * 昵称不可得时退化为不含目标的通用准确表述（与新鲜成功同一句）。
 */
function toTargetedSuccessMessage(nickname: string | null, noun: string, verb: string): string {
  return nickname === null ? `${noun}${verb}。` : `「${nickname}」的${noun}${verb}。`;
}

/**
 * 「联系方式」区块。
 *
 * - 三行仍是列表已返回的既有字段，继续按现有列宽省略，不因本区块加宽表格；
 *   被省略的值悬停或键盘聚焦时用项目现有 Tooltip 展示完整值，空值只显示占位符、不挂提示。
 * - 整块（含区块内空白）就是复制区域：点击 / Enter / Space 复制本行非空基本信息。
 *   复制只读取行内既有字段，不发起任何请求，也不介入同行的启停 / 重置密码入口。
 */
function AdminUserContactCell({ row }: { row: AdminUserRow }) {
  const copyContact = () => {
    void writeAdminUserContactCopyText(buildAdminUserContactCopyText(row)).then((written) => {
      // 剪贴板不可用或写入失败时必须明确告知，不能静默当成功
      if (written) {
        message.success('用户信息已复制。');
      } else {
        message.error('用户信息复制失败，请手动选择文本复制。');
      }
    });
  };

  return (
    <div
      aria-label={`复制「${row.nickname}」的用户信息`}
      className="admin-user-contact flex min-w-0 flex-col gap-0.5"
      onClick={copyContact}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }

        // Space 默认滚动页面、Enter 默认会再触发一次按钮语义：截断以保证只复制一次
        event.preventDefault();
        copyContact();
      }}
      role="button"
      tabIndex={0}
    >
      {ADMIN_USER_CONTACT_LINES.map((line) => {
        const value = normalizeAdminUserContactValue(line.read(row));

        return (
          <span className="truncate text-text-secondary text-xs" key={line.label}>
            {line.label}：
            {value === null ? (
              renderOptionalText(value)
            ) : (
              <Tooltip title={value} trigger={['hover', 'focus']}>
                <span className="admin-user-contact-value" tabIndex={0}>
                  {value}
                </span>
              </Tooltip>
            )}
          </span>
        );
      })}
      {/* 悬停 / 聚焦时才出现的轻量复制提示图标，绝对定位，不参与列宽与换行计算 */}
      <CopyOutlined aria-hidden="true" className="admin-user-contact-copy-icon" />
    </div>
  );
}

export function AdminUserManagementPanel({ adminLevel }: { adminLevel: number | null }) {
  const list = useAdminUserList();
  const commands = useAdminUserCommands(list.reload);
  const dialogSession = useDialogSessionSeq<AdminUserDialogKey>();
  const [keywordDraft, setKeywordDraft] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  // 筛选条件默认收起：常驻行只保留主搜索与筛选开关（工程师维修申请列表同一模式）
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusRow, setStatusRow] = useState<AdminUserRow | null>(null);
  const [resetPasswordRow, setResetPasswordRow] = useState<AdminUserRow | null>(null);
  const levelTwoCredential = useAdminLevelTwoCredential();
  const [levelTwoCredentialOpen, setLevelTwoCredentialOpen] = useState(false);

  // 主搜索防抖：输入即时回显，防抖到期才把草稿交给下一步的应用 effect
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keywordDraft);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keywordDraft]);

  // 防抖到期后应用主搜索：trim 后提交，空串回到不筛选语义；值未变化时早退，
  // 不因引用变化重复发请求。角色 / 状态筛选走展开区控件自身的 applyFilters，互不覆盖。
  useEffect(() => {
    const trimmed = debouncedKeyword.trim();
    const nextKeyword = trimmed === '' ? null : trimmed;

    if (list.query.keyword !== nextKeyword) {
      list.applyFilters({ keyword: nextKeyword });
    }
  }, [debouncedKeyword, list]);

  const hasActiveFilter =
    list.query.keyword !== null || list.query.role !== null || list.query.status !== null;

  // 清除筛选：草稿与防抖值必须同时复位，否则防抖值里的旧关键字会被上面的应用 effect
  // 回填成一次多余请求（列表闪回筛选无结果态）
  const clearFilters = () => {
    setKeywordDraft('');
    setDebouncedKeyword('');
    list.applyFilters({ keyword: null, role: null, status: null });
  };

  const isStatusSubmitting = commands.isPending('status');
  const isResetPasswordSubmitting = commands.isPending('reset-password');

  /**
   * 打开 / 关闭 / 切换目标一律在事件处理器里**同步**推进会话代次。
   *
   * 代次若靠 effect 推进，关闭与立刻重开会落在同一个事件循环窗口内，
   * 旧请求的成功续体就能把新一代弹窗关掉。
   *
   * 边界说明：antd 6.4.3 的 `Modal.handleCancel` 在 `confirmLoading` 为真时直接 `return`，
   * 取消按钮、右上角 X、遮罩点击与 Esc 四条关闭路径共用它，而下面两个弹窗的
   * `submitting` 都接到了 `commands.isPending(key)`。也就是说当前接线下用户在提交期间
   * 关不掉弹窗，本层守卫拦的是「提交期间切换目标」以及宿主接线一旦放松后的
   * 「关闭 / 重开」，而不是一个当前可复现的用户操作序列。
   */
  const openRowDialog = (
    key: AdminUserDialogKey,
    currentRow: AdminUserRow | null,
    setRow: AdminUserRowSetter,
    row: AdminUserRow,
  ) => {
    // 目标 accountId 未变 = 同一次会话仍在继续：弹窗侧守卫以 accountId 为身份、不会推进，
    // 面板也不能推进，否则一次重入就会让在途提交被误判成陈旧。
    if (currentRow?.accountId !== row.accountId) {
      dialogSession.advance(key);
    }

    setRow(row);
  };

  const closeRowDialog = (key: AdminUserDialogKey, setRow: AdminUserRowSetter) => {
    dialogSession.advance(key);
    setRow(null);
  };

  /**
   * 行级弹窗成功收尾：会话代次 + 目标 accountId 双重核对，两步缺一不可。
   *
   * - 代次（ref，同步）识别「提交期间关闭 / 重开 / 切换目标」，其中关闭后重开同一个
   *   accountId 时两边 accountId 完全相同，只核对 accountId 一定会误关新弹窗；
   * - 函数式 updater 对**最新** state 复核 accountId，是关闭动作自身的最后一道闸。
   *
   * toast / reload / 改 ref 全部留在 updater 之外：updater 必须纯，且它要到下一次 render 才执行。
   * reload 由 `useAdminUserCommands` 在命令成功后统一触发，陈旧成功同样照常刷新列表。
   *
   * @returns 本次成功是否属于当前会话；false ⇒ 陈旧，调用方据此改用点名目标的反馈措辞
   */
  const closeRowDialogOnSuccess = (
    key: AdminUserDialogKey,
    sessionSeq: number,
    targetAccountId: number,
    setRow: AdminUserRowSetter,
  ): boolean => {
    if (!dialogSession.isCurrent(key, sessionSeq)) {
      return false;
    }

    setRow((current) =>
      current !== null && current.accountId === targetAccountId ? null : current,
    );
    dialogSession.advance(key);

    return true;
  };

  const submitStatusChange = async (input: {
    accountId: number;
    status: AdminUserStatusFilter;
  }): Promise<AdminUserCommandResult> => {
    const sessionSeq = dialogSession.capture('status');
    const targetNickname = statusRow?.accountId === input.accountId ? statusRow.nickname : null;

    const execution = await commands.setUserStatus(input);

    if (execution.kind === 'ok') {
      if (execution.result.ok) {
        if (closeRowDialogOnSuccess('status', sessionSeq, input.accountId, setStatusRow)) {
          message.success('状态已修改。');
        } else {
          message.success(toTargetedSuccessMessage(targetNickname, '状态', '已修改'));
        }
      }

      return execution.result;
    }

    if (execution.kind === 'unhandled-error') {
      return { ok: false, reason: 'update-failed', message: execution.message };
    }

    return { ok: false, reason: 'update-failed', message: '' };
  };

  const submitPasswordReset = async (input: {
    accountId: number;
  }): Promise<AdminUserCommandResult> => {
    const sessionSeq = dialogSession.capture('reset-password');
    const execution = await commands.resetPasswordToDefault(input);

    if (execution.kind === 'ok') {
      if (execution.result.ok) {
        // 陈旧成功同样不得关掉当前弹窗（可能已是另一个目标或重开后的同一目标）
        closeRowDialogOnSuccess('reset-password', sessionSeq, input.accountId, setResetPasswordRow);
        // 成功提示只展示后端固定安全提示 notice，密码不出现在任何反馈中；
        // notice 本身不含目标身份，因此陈旧成功也逐字沿用，不做追加改写
        message.success(execution.result.notice, 6);

        return { ok: true };
      }

      return execution.result;
    }

    if (execution.kind === 'unhandled-error') {
      return { ok: false, reason: 'reset-failed', message: execution.message };
    }

    return { ok: false, reason: 'reset-failed', message: '' };
  };

  const openLevelTwoCredential = () => {
    dialogSession.advance('level-two-credential');
    setLevelTwoCredentialOpen(true);
  };

  const closeLevelTwoCredential = () => {
    dialogSession.advance('level-two-credential');
    setLevelTwoCredentialOpen(false);
    // 口令的唯一存放点：关闭即销毁，不留任何页面级残留
    levelTwoCredential.clear();
  };

  /**
   * 二级管理员凭据重置：成功且仍属当前会话才把本次口令交给展示态；
   * 陈旧成功一律丢弃口令，只让弹窗回到选择步骤。
   */
  const submitLevelTwoReset = async (
    input: AdminLevelTwoResetInput,
  ): Promise<AdminLevelTwoResetOutcome> => {
    const sessionSeq = dialogSession.capture('level-two-credential');
    const execution = await commands.resetLevelTwoCredential({
      adminAccountId: input.adminAccountId,
      organizationId: input.organizationId,
      reason: input.reason,
    });

    if (execution.kind === 'in-flight') {
      return { ok: false, message: '' };
    }

    if (execution.kind === 'unhandled-error') {
      return dialogSession.isCurrent('level-two-credential', sessionSeq)
        ? { ok: false, message: execution.message }
        : { ok: false, message: '' };
    }

    if (!execution.result.ok) {
      return { ok: false, message: execution.result.message };
    }

    if (dialogSession.isCurrent('level-two-credential', sessionSeq)) {
      levelTwoCredential.show({
        ...execution.result.credential,
        companyName: input.companyName,
        reason: input.reason,
      });
      message.success('二级管理员临时密码已重置。');
    }

    return { ok: true };
  };

  const columns: ColumnsType<AdminUserRow> = [
    {
      dataIndex: 'nickname',
      ellipsis: true,
      render: (_, row) => (
        <div className="flex min-w-0 items-center gap-3">
          {/* 列表 DTO 无头像字段，不为显示效果伪造图片；沿用导航头像的首字母回退与方形（12px 圆角）配方 */}
          <span aria-hidden="true" className="user-avatar user-avatar--md">
            {row.nickname.trim().charAt(0).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-bold text-text">{row.nickname}</span>
            <span className="truncate text-text-secondary text-xs">
              {renderOptionalText(row.loginName)}
            </span>
            <span className="truncate text-text-tertiary text-xs">账号 ID：{row.accountId}</span>
          </div>
        </div>
      ),
      title: '用户信息',
    },
    {
      dataIndex: 'loginEmail',
      ellipsis: true,
      render: (_, row) => <AdminUserContactCell row={row} />,
      title: '联系方式',
    },
    {
      dataIndex: 'companyName',
      ellipsis: true,
      render: renderOptionalText,
      title: '所属公司',
    },
    {
      dataIndex: 'role',
      render: (role: AdminUserRole) => (
        <Tag color={ROLE_TAG_COLORS[role]}>{ADMIN_USER_ROLE_LABELS[role]}</Tag>
      ),
      title: '角色',
      width: 110,
    },
    {
      dataIndex: 'status',
      render: (status: string) => (
        <Tag color={status === 'ACTIVE' ? 'success' : 'default'}>
          {isAdminUserStatusWritable(status) ? ADMIN_USER_STATUS_LABELS[status] : status}
        </Tag>
      ),
      title: '账号状态',
      width: 110,
    },
    {
      dataIndex: 'createdAt',
      render: (_, row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-text-secondary text-xs">
            创建：{formatDateTimeText(row.createdAt)}
          </span>
          <span className="text-text-secondary text-xs">
            最近更新：{formatDateTimeText(row.updatedAt)}
          </span>
        </div>
      ),
      title: '创建时间 / 最近更新',
      width: 180,
    },
    {
      fixed: 'right',
      render: (_, row) => {
        const readOnly = isAdminUserRowReadOnly(row);
        const actionButtons = [
          {
            disabled: !canToggleAdminUserStatus(row),
            key: 'status',
            label: '启停',
            onClick: () => openRowDialog('status', statusRow, setStatusRow, row),
          },
          {
            disabled: !canResetAdminUserPassword(row),
            key: 'reset-password',
            label: '重置密码',
            onClick: () =>
              openRowDialog('reset-password', resetPasswordRow, setResetPasswordRow, row),
          },
        ];

        const buttons = (
          <Space size={0} wrap>
            {actionButtons.map((action) => (
              <Button
                disabled={action.disabled}
                key={action.key}
                size="small"
                type="link"
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </Space>
        );

        // SUPER_ADMIN 行只读：写入口禁用并给出可理解说明（后端仍是权限真源）
        return readOnly ? (
          <Tooltip title={ADMIN_USER_ROW_READ_ONLY_REASON}>{buttons}</Tooltip>
        ) : (
          buttons
        );
      },
      title: '操作',
      width: 160,
    },
  ];

  const state = list.state;

  return (
    <>
      <TableContainer>
        <div className="flex flex-col gap-4">
          <FilterBar>
            <ToolbarSearchField
              clearLabel="清除用户搜索"
              onChange={setKeywordDraft}
              placeholder="搜索登录名 / 登录邮箱 / 昵称"
              value={keywordDraft}
            />
            <ToolbarButton
              active={hasActiveFilter}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((previous) => !previous)}
            >
              筛选
            </ToolbarButton>

            {/* 一级专用入口：二级与等级缺失不渲染（服务端仍独立拒绝越权调用） */}
            {canManageLevelTwoCredentials(adminLevel) ? (
              <Button onClick={openLevelTwoCredential}>二级管理员凭据</Button>
            ) : null}

            {/* 展开区：主搜索之外的精确条件收在这里，收起时不渲染；
                角色筛选只开放普通用户值域，与管理端读面一致 */}
            {filterOpen ? (
              <div className="flex w-full flex-wrap items-center gap-3">
                <div className="w-44">
                  <Select<AdminUserFilterRole | undefined>
                    allowClear
                    placeholder="角色筛选"
                    style={{ width: '100%' }}
                    value={list.query.role ?? undefined}
                    onChange={(role) => list.applyFilters({ role: role ?? null })}
                    options={ADMIN_USER_ROLE_FILTER_OPTIONS.map((role) => ({
                      value: role,
                      label: ADMIN_USER_ROLE_LABELS[role],
                    }))}
                  />
                </div>

                <div className="w-36">
                  <Select<AdminUserStatusFilter | undefined>
                    allowClear
                    placeholder="状态筛选"
                    style={{ width: '100%' }}
                    value={list.query.status ?? undefined}
                    onChange={(status) => list.applyFilters({ status: status ?? null })}
                    options={ADMIN_USER_STATUS_FILTER_OPTIONS.map((status) => ({
                      value: status,
                      label: ADMIN_USER_STATUS_LABELS[status],
                    }))}
                  />
                </div>

                <ToolbarButton onClick={clearFilters}>清除筛选</ToolbarButton>
              </div>
            ) : null}
          </FilterBar>

          <p className="text-text-secondary text-sm">{resolveAdminUserScopeHint(adminLevel)}</p>

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
            <LoadingState label="正在加载用户…" />
          ) : null}

          {state.status === 'ready' && list.isCurrentQueryDomain && state.page.items.length > 0 ? (
            <Table<AdminUserRow>
              columns={columns}
              dataSource={state.page.items}
              pagination={{
                current: state.page.page,
                onChange: list.goToPage,
                pageSize: list.query.pageSize,
                showSizeChanger: false,
                showTotal: (total) => `共 ${total} 条`,
                total: state.page.total,
              }}
              rowKey="accountId"
              scroll={{ x: 1080 }}
              size="middle"
            />
          ) : null}

          {state.status === 'ready' &&
          list.isCurrentQueryDomain &&
          state.page.items.length === 0 ? (
            <EmptyState title="暂无用户数据。" />
          ) : null}
        </div>
      </TableContainer>

      <AdminUserStatusModal
        row={statusRow}
        submitting={isStatusSubmitting}
        onCancel={() => closeRowDialog('status', setStatusRow)}
        onSubmit={submitStatusChange}
      />

      <AdminUserResetPasswordModal
        row={resetPasswordRow}
        submitting={isResetPasswordSubmitting}
        onCancel={() => closeRowDialog('reset-password', setResetPasswordRow)}
        onSubmit={submitPasswordReset}
      />

      {canManageLevelTwoCredentials(adminLevel) ? (
        <AdminLevelTwoCredentialModal
          credential={levelTwoCredential.credential}
          open={levelTwoCredentialOpen}
          submitting={commands.isPending('reset-level-two-credential')}
          onClose={closeLevelTwoCredential}
          onSubmit={submitLevelTwoReset}
        />
      ) : null}
    </>
  );
}
