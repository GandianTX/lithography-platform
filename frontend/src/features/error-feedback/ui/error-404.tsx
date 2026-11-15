// src/features/error-feedback/ui/error-404.tsx

import { CompassOutlined } from '@ant-design/icons';

import { useI18n } from '@/shared/i18n';

import { ErrorBlock } from './error-block';

export function Error404() {
  const { t } = useI18n();

  return (
    <ErrorBlock
      actions={[{ label: t('error.backToWorkbench'), to: '/' }]}
      description={t('error.404.description')}
      icon={<CompassOutlined />}
      statusCode={404}
      title={t('error.404.title')}
      tone="neutral"
    />
  );
}
