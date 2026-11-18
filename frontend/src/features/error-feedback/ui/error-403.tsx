// src/features/error-feedback/ui/error-403.tsx

import { StopOutlined } from '@ant-design/icons';

import { useI18n } from '@/shared/i18n';

import { ErrorBlock } from './error-block';

export function Error403() {
  const { t } = useI18n();

  return (
    <ErrorBlock
      actions={[{ label: t('error.backToWorkbench'), to: '/' }]}
      description={t('error.403.description')}
      icon={<StopOutlined />}
      statusCode={403}
      title={t('error.403.title')}
      tone="warning"
    />
  );
}
