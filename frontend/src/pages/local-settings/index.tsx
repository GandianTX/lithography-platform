// src/pages/local-settings/index.tsx

import { LocalRuntimeSettingsPanel } from '@/features/local-runtime';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 本地设置页（任务 09 R064）：导航最后一项、只读。
 *
 * 页面只负责页头与组合 feature 公开 UI：本机身份、服务/数据库/任务耐久来源、
 * 默认保存位置与可写状态、按范围过滤后的公司备份计划。
 * 不在此处发起任何写请求，也不提供公司/设备切换入口。
 */
export function LocalSettingsPage() {
  const { t } = useI18n();

  return (
    <div className="page-stack">
      <PageHeader
        description={t('local-settings.description')}
        eyebrow="Local Settings"
        title={t('local-settings.title')}
      />
      <LocalRuntimeSettingsPanel />
    </div>
  );
}
