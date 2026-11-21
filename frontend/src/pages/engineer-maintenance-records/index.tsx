// src/pages/engineer-maintenance-records/index.tsx
//
// 工程师「资料 → 记录历史故障经验」独立入口（任务 06）：
// 列表、新建空白分步表单、既有草稿续填共用同一套报告编辑界面。

import { Alert } from 'antd';
import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import { MaintenanceReportEditorPage, MaintenanceReportList } from '@/features/maintenance-report';

import { useI18n } from '@/shared/i18n';

export function EngineerMaintenanceRecordsPage() {
  return <MaintenanceReportList />;
}

export function EngineerMaintenanceRecordNewPage() {
  const { session } = useAuthSession();

  return (
    <MaintenanceReportEditorPage
      engineerName={session?.userInfo?.nickname ?? ''}
      mode="HISTORICAL_CASE"
    />
  );
}

export function EngineerMaintenanceRecordEditorPage() {
  const { t } = useI18n();
  const { session } = useAuthSession();
  const { reportId } = useParams<{ reportId: string }>();
  const parsed = reportId === undefined ? Number.NaN : Number(reportId);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return <Alert showIcon title={t('maintenanceReport.invalidReportId')} type="error" />;
  }

  return (
    <MaintenanceReportEditorPage
      engineerName={session?.userInfo?.nickname ?? ''}
      mode="HISTORICAL_CASE"
      reportId={parsed}
    />
  );
}
