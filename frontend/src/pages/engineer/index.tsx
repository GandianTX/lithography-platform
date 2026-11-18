// src/pages/engineer/index.tsx

import { useState } from 'react';
import { SettingOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { useNavigate } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import {
  ENGINEER_REPAIR_REQUEST_LIST_PATH,
  EngineerRepairWorkbench,
  EngineerRepairWorkbenchProvider,
  EngineerWorkbenchHeaderStats,
} from '@/features/repair-request';

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { PageHeader } from '@/shared/ui/page-header';

// 工程师首页快捷入口的目标路由（全部为 app/router 注册的真实路由）：
// - 全部维修申请：列表路由默认 ALL；
// - 我的接单：同一列表路由以查询参数恢复 MINE 范围；
// - 参考资料库 / 账号设置：既有受保护路由。
// AI 故障诊断没有正式路由，不提供任何入口、按钮或占位。
const MY_REPAIR_REQUESTS_PATH = `${ENGINEER_REPAIR_REQUEST_LIST_PATH}?scope=MINE`;
const REFERENCE_DOCUMENTS_PATH = '/reference-documents';
const ACCOUNT_SETTINGS_PATH = '/account/settings';

const QUICK_ENTRIES: ReadonlyArray<{
  descriptionKey: MessageKey;
  labelKey: MessageKey;
  path: string;
}> = [
  {
    descriptionKey: 'engineer.quick.allDescription',
    labelKey: 'engineer.quick.all',
    path: ENGINEER_REPAIR_REQUEST_LIST_PATH,
  },
  {
    descriptionKey: 'engineer.quick.mineDescription',
    labelKey: 'engineer.quick.mine',
    path: MY_REPAIR_REQUESTS_PATH,
  },
  {
    descriptionKey: 'engineer.quick.referenceDescription',
    labelKey: 'engineer.quick.reference',
    path: REFERENCE_DOCUMENTS_PATH,
  },
  {
    descriptionKey: 'engineer.quick.accountDescription',
    labelKey: 'engineer.quick.account',
    path: ACCOUNT_SETTINGS_PATH,
  },
];

/**
 * 工程师首页工作台：
 * - Provider 持有唯一一份工作台读模型，页头真实统计胶囊与工作台主体共用同一次查询
 *   （页头不另开一套同口径读来源）；
 * - 上方左右联动的工作台数据全部来自真实列表读协议（feature 组件）；
 * - 快捷入口独立成区并只连接真实路由，不留死链接；
 * - 底部工程师信息条只展示 Auth Session 公开模型里真实存在的个人信息
 *   （头像 URL、昵称、角色、账号 ID），不建第二份会话/角色真源，
 *   不照搬原型虚构身份字段；卡片内只保留「账号设置」一个动作入口，
 *   不与快捷入口混排；
 * - 退出登录由公共侧栏承担，不在页内重复提供。
 */
export function EngineerPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session } = useAuthSession();
  // 记录加载失败的 URL 而不是布尔量：会话换头像后自动重试，不残留失败态
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);

  const nickname = session?.userInfo?.nickname ?? null;
  // 头像来自受保护的本人资料（登录结果已返回该字段）；无真实 URL 时回落昵称首字
  const avatarUrl = session?.userInfo?.avatarUrl ?? null;
  const avatarInitial = nickname ? nickname.charAt(0).toUpperCase() : null;
  const showAvatarImage = avatarUrl !== null && failedAvatarUrl !== avatarUrl;

  return (
    <EngineerRepairWorkbenchProvider>
      <div className="page-stack">
        <PageHeader
          description={t('engineer.workspaceDescription')}
          eyebrow="Engineer Workspace"
          extra={<EngineerWorkbenchHeaderStats />}
          title={t('engineer.workspaceTitle')}
        />

        <EngineerRepairWorkbench />

        {/* 快捷入口独立成区：只连接真实路由，与底部个人信息条职责分离 */}
        <DataCard title={t('engineer.quickEntries')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {QUICK_ENTRIES.map((entry) => (
              <button
                className="quick-entry flex min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left"
                key={entry.path}
                onClick={() => navigate(entry.path)}
                type="button"
              >
                <span className="font-bold text-sm text-text">{t(entry.labelKey)}</span>
                <span className="text-text-tertiary text-xs leading-snug">
                  {t(entry.descriptionKey)}
                </span>
              </button>
            ))}
          </div>
        </DataCard>

        {/* 底部工程师信息条（横向结构对照 gkj .engineer-strip）：
            左栏为身份（头像 + 昵称 + 角色），右侧按「标签 + 值」分栏展示会话里
            真实存在的字段，右上角是账号设置入口。原型右侧的 Position / Access Level /
            Region / Specialty 四项没有对应数据契约，故不出现，也不拿角色、所在地或
            通用标签改名冒充；栏目数少于原型属预期。退出登录由公共侧栏承担 */}
        <DataCard>
          <div className="relative flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3 pr-9">
            {/* 设置入口贴合卡片右上角（原型 28×28 / radius 8px，悬停取条目同组交互色） */}
            <button
              aria-label={t('engineer.quick.account')}
              className="absolute -top-1 right-0 flex size-7 items-center justify-center rounded-lg border border-(--panel-border) bg-(--activity-item-bg) text-(--text-muted) transition-colors hover:border-(--activity-item-hover-border) hover:bg-(--activity-item-hover-bg) hover:text-primary"
              onClick={() => navigate(ACCOUNT_SETTINGS_PATH)}
              type="button"
            >
              <SettingOutlined />
            </button>

            <div className="flex min-w-0 items-center gap-3">
              {/* 头像：有真实 avatarUrl 且未加载失败才显示图片，否则回落昵称首字；
                  视觉配方复用公共 .user-avatar（与侧栏头像同一变量），
                  尺寸按 gkj 工程师信息条取 40×40（--lg） */}
              {showAvatarImage ? (
                <img
                  alt=""
                  className="user-avatar user-avatar--lg"
                  src={avatarUrl ?? undefined}
                  onError={() => setFailedAvatarUrl(avatarUrl)}
                />
              ) : avatarInitial ? (
                <span aria-hidden="true" className="user-avatar user-avatar--lg">
                  {avatarInitial}
                </span>
              ) : null}
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-bold text-sm text-text">{nickname ?? '—'}</span>
                  {session ? <Tag color="blue">{session.role}</Tag> : null}
                </span>
              </div>
            </div>

            {/* 右栏：真实字段（会话公开模型），标签/值字级对照原型 .engineer-item-* */}
            {session ? (
              <dl className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3 sm:ml-auto">
                <div className="flex min-w-0 flex-col">
                  <dt className="text-[8px] font-extrabold tracking-[0.12em] text-(--empty-text)">
                    {t('engineer.accountId')}
                  </dt>
                  <dd className="mt-0.75 text-[11px] font-bold text-(--control-text-body)">
                    {session.accountId}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        </DataCard>
      </div>
    </EngineerRepairWorkbenchProvider>
  );
}
