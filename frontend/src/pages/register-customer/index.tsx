// src/pages/register-customer/index.tsx

import { RegisterCustomerForm } from '@/features/registration';

import { useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';

/**
 * 客户注册页（V44 布局）：与登录页共用壳层（灰蓝底 + 左上角品牌）。
 * 主体为居中单列——标题与说明在卡片上方，卡片标题「注册资料」，
 * 底部为「注册并开通」与「返回登录」并排动作。
 */
export function RegisterCustomerPage() {
  const { t } = useI18n();

  return (
    <div className="register-layout">
      <header className="register-header">
        <h1 className="register-title">{t('register.customerTitle')}</h1>
        <p className="register-subtitle">{t('register.customerSubtitle')}</p>
      </header>

      <div className="register-panel">
        <DataCard title={t('register.cardTitle')}>
          <RegisterCustomerForm />
        </DataCard>
      </div>
    </div>
  );
}
