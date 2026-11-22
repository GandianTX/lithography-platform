// src/pages/record-packages/index.tsx

import { Tabs } from 'antd';

import { RecordPackageExportPanel, RecordPackageImportPanel } from '@/features/record-package';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 记录包页（任务 09 S3.1）：导出与导入两个标签。
 *
 * - 导出：选择有权记录 → 指定本机目标目录（U盘挂载点）→ 逐条导出结论；
 * - 导入：指定包路径 → 安全预检（不写正式业务）→ 明确确认 → 受控逐项导入 → 逐条结果；
 * - 公司范围与是否可导入由服务端按 Session 裁决，前端不自行判定。
 */
export function RecordPackagesPage() {
  const { t } = useI18n();

  return (
    <div className="page-stack">
      <PageHeader
        description={t('recordPackage.description')}
        eyebrow={t('recordPackage.eyebrow')}
        title={t('recordPackage.title')}
      />
      <Tabs
        items={[
          {
            children: <RecordPackageExportPanel />,
            key: 'export',
            label: t('recordPackage.tab.export'),
          },
          {
            children: <RecordPackageImportPanel />,
            key: 'import',
            label: t('recordPackage.tab.import'),
          },
        ]}
      />
    </div>
  );
}
