// src/pages/my-record-detail/index.tsx

import { useParams } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import { MyRecordDetailPanel, parseMyRecordIdParam } from '@/features/my-records';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/** 本人记录只读详情页：非法路由参数不发请求，直接呈现 not-found */
export function MyRecordDetailPage() {
  const { t } = useI18n();
  const { session } = useAuthSession();
  const { recordId } = useParams();

  return (
    <div className="page-stack">
      <PageHeader
        description={t('myRecords.detail.description')}
        eyebrow={t('myRecords.detail.eyebrow')}
        title={t('myRecords.detail.title')}
      />
      <MyRecordDetailPanel activeRole={session?.role} recordId={parseMyRecordIdParam(recordId)} />
    </div>
  );
}
