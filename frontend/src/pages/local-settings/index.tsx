// src/pages/local-settings/index.tsx

import { useAuthSession } from '@/features/auth-session';
import { LocalRuntimeSettingsPanel } from '@/features/local-runtime';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 本地设置页（任务 09 R064）：导航最后一项、只读。
 *
 * 页面只负责页头与组合 feature 公开 UI：本机身份、服务/数据库/任务耐久来源、
 * 默认保存位置与可写状态、按范围过滤后的公司备份计划。
 * 不在此处发起任何写请求，也不提供公司/设备切换入口。
 *
 * 备份计划开关的可写性由**本页**按可信会话判定后传入面板：
 * 一级管理员（全局）与二级管理员（本公司）可写，工程师只读。
 * 会话事实属于 `auth-session` 特性，页面层读取后下传，`local-runtime` 特性
 * 不直接依赖其他特性（`features -> entities, shared`）。
 * 服务端仍会复核，前端判断只是少画一个不该画的开关，不作为权限依据。
 */
export function LocalSettingsPage() {
  const { t } = useI18n();
  const auth = useAuthSession();
  const adminLevel = auth.status === 'authenticated' ? auth.session.adminLevel : null;

  return (
    <div className="page-stack v44-panel-page">
      <PageHeader
        description={t('local-settings.description')}
        eyebrow="Local Settings"
        title={t('local-settings.title')}
      />
      <LocalRuntimeSettingsPanel writable={adminLevel !== null} />
    </div>
  );
}
