// src/pages/local-backup/index.tsx

import { LocalBackupPanel } from '@/features/local-backup';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 备份与恢复页（任务 09 S3／S4）。
 *
 * 页面只负责页头与组合 feature 公开 UI：自动备份设置、手动备份、备份记录与恢复预检。
 * 公司/设备范围由服务端按 Session 裁决，前端不传公司参数；恢复执行能力按服务端
 * 声明如实呈现，不可用时说明原因。
 */
export function LocalBackupPage() {
  const { t } = useI18n();

  return (
    <div className="page-stack">
      <PageHeader
        description={t('local-backup.description')}
        eyebrow="Local Backup"
        title={t('local-backup.title')}
      />
      <LocalBackupPanel />
    </div>
  );
}
