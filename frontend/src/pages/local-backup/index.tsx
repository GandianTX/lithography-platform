// src/pages/local-backup/index.tsx

import { useAuthSession } from '@/features/auth-session';
import { LocalBackupPanel } from '@/features/local-backup';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 备份与恢复页（任务 09 S3／S4）。
 *
 * 页面只负责页头与组合 feature 公开 UI：自动备份设置、手动备份、备份记录与恢复预检。
 * 公司/设备范围由服务端按 Session 裁决，前端不传公司参数；恢复执行能力按服务端
 * 声明如实呈现，不可用时说明原因。
 *
 * 恢复预检是服务端的一级管理员动作：这里按会话角色决定**是否展示**该入口，
 * 只是展示性收敛——最终裁决仍在服务端（feature 之间不互相依赖，故角色在页面层解析）。
 */
export function LocalBackupPage() {
  const { t } = useI18n();
  const { session, status } = useAuthSession();
  const canPrecheck = status === 'authenticated' && session?.role === 'SUPER_ADMIN';

  return (
    <div className="page-stack v44-panel-page">
      <PageHeader
        description={t('local-backup.description')}
        eyebrow="Local Backup"
        title={t('local-backup.title')}
      />
      <LocalBackupPanel canPrecheck={canPrecheck} />
    </div>
  );
}
