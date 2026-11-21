// src/pages/engineer-work-order-summaries/index.tsx
//
// 工程师「工单维修总结」入口（任务 06，2026-11-20 需求调整）：
// 待核对列表 + 只读核对页；两个入口（已结单工单详情卡片、本人总结列表）
// 进入同一份只读核对页。入口资格（本人已接单且已结单）由服务端复核。
//
// 依赖规则：features 不得互相依赖——来源工单原件授权下载在此页面层
// 从 repair-request 公共 API 取得并注入 maintenance-report 的只读核对组件
// （2026-11-21 需求调整：预览与校验同源后，页面不再注入第二份详情读侧）。

import { Alert } from 'antd';
import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import { MaintenanceReportEditorPage, WorkOrderSummaryList } from '@/features/maintenance-report';
import {
  downloadRepairProcessFile,
  ENGINEER_REPAIR_REQUEST_DETAIL_PATH,
} from '@/features/repair-request';

import { useI18n } from '@/shared/i18n';

export function EngineerWorkOrderSummariesPage() {
  return (
    <WorkOrderSummaryList
      // 2026-11-21 需求调整：每行「来源工单」跳任务 04 工程师工单详情页。
      // 使用 repairRequestId（工单 ID）拼真实路由，不用报告 ID；页面/服务端
      // 权限由 /engineer/repair-requests/:requestId 的既有守卫与读侧复核。
      resolveSourceWorkOrderPath={(repairRequestId) =>
        `${ENGINEER_REPAIR_REQUEST_DETAIL_PATH}${repairRequestId}`
      }
    />
  );
}

export function EngineerWorkOrderSummaryEditorPage() {
  const { t } = useI18n();
  const { session } = useAuthSession();
  const { repairRequestId } = useParams<{ repairRequestId: string }>();
  const parsed = repairRequestId === undefined ? Number.NaN : Number(repairRequestId);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return <Alert showIcon title={t('maintenanceReport.invalidWorkOrderId')} type="error" />;
  }

  return (
    <MaintenanceReportEditorPage
      engineerName={session?.userInfo?.nickname ?? ''}
      mode="WORK_ORDER_SUMMARY"
      repairRequestId={parsed}
      workOrderSummarySource={{
        downloadSourceFile: async (fileId) => {
          const result = await downloadRepairProcessFile(fileId);
          if (!result.ok) {
            return { ok: false, message: result.message };
          }
          return { ok: true, blob: result.blob, filename: result.filename };
        },
      }}
    />
  );
}
