// src/features/error-feedback/ui/error-route-crash.tsx

import { BugOutlined } from '@ant-design/icons';

import { useI18n } from '@/shared/i18n';

import { ErrorBlock } from './error-block';

export function ErrorRouteCrash() {
  const { t } = useI18n();

  return (
    <ErrorBlock
      actions={[{ label: t('error.backToWorkbench'), to: '/' }]}
      description={t('error.routeCrash.description')}
      icon={<BugOutlined />}
      statusCode="ERR"
      title={t('error.routeCrash.title')}
      tone="error"
    />
  );
}
