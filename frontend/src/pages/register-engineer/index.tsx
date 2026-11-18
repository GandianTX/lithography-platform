// src/pages/register-engineer/index.tsx

import { RegisterEngineerForm } from '@/features/registration';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';

/**
 * 工程师注册页（V44 布局）：与客户注册页、登录页共用壳层与居中单列。
 * 标题与说明在卡片上方，卡片标题「注册资料」，底部为提交与返回登录并排动作。
 */
export function RegisterEngineerPage() {
  const { t } = useI18n();

  return (
    <div className="register-layout">
      <header className="register-header">
        <h1 className="register-title">{t('register.engineerTitle')}</h1>
        <p className="register-subtitle">{t('register.engineerSubtitle')}</p>
      </header>

      <div className="register-panel">
        <DataCard title={t('register.cardTitle')}>
          <RegisterEngineerForm />
        </DataCard>
      </div>
    </div>
  );
}
