// src/features/error-feedback/ui/error-500.tsx

import { ThunderboltOutlined } from '@ant-design/icons';

import { useI18n } from '@/shared/i18n';

import { ErrorBlock } from './error-block';

export function Error500() {
  const { t } = useI18n();

  return (
    <ErrorBlock
      actions={[{ label: t('error.backToWorkbench'), to: '/' }]}
      description={t('error.500.description')}
      icon={<ThunderboltOutlined />}
      statusCode={500}
      title={t('error.500.title')}
      tone="error"
    />
  );
}
