// src/pages/register-customer/index.tsx

import { RegisterCustomerForm } from '@/features/registration';

import { DataCard } from '@/shared/ui/data-card';

/**
 * 客户注册页：与登录页共用壳层（灰蓝底 + 左上角品牌），
 * 左栏说明注册口径，右栏为注册表单卡；窄屏由 CSS 改为纵向堆叠。
 */
export function RegisterCustomerPage() {
  return (
    <div className="register-layout">
      <div className="login-intro">
        <h1 className="login-intro-title">客户注册</h1>
        <p className="login-intro-subtitle">注册即开通账号，并关联所属公司</p>
        <span aria-hidden="true" className="login-intro-rule" />
        <p className="login-intro-note">
          可从名单选择所属公司；名单中没有时填写自家公司名称，注册完成后即可使用工作台。
        </p>
      </div>

      <div className="register-panel">
        <DataCard>
          <RegisterCustomerForm />
        </DataCard>
      </div>
    </div>
  );
}
