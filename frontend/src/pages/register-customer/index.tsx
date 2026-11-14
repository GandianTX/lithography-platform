// src/pages/register-customer/index.tsx

import { RegisterCustomerForm } from '@/features/registration';

import { DataCard } from '@/shared/ui/data-card';

/**
 * 客户注册页（V44 布局）：与登录页共用壳层（灰蓝底 + 左上角品牌）。
 * 主体为居中单列——标题与说明在卡片上方，卡片标题「注册资料」，
 * 底部为「注册并开通」与「返回登录」并排动作。
 */
export function RegisterCustomerPage() {
  return (
    <div className="register-layout">
      <header className="register-header">
        <h1 className="register-title">客户注册</h1>
        <p className="register-subtitle">
          注册即开通账号，并关联所属公司；名单中没有自家公司时可填写名称。
        </p>
      </header>

      <div className="register-panel">
        <DataCard title="注册资料">
          <RegisterCustomerForm />
        </DataCard>
      </div>
    </div>
  );
}
