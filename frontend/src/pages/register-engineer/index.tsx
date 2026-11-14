// src/pages/register-engineer/index.tsx

import { RegisterEngineerForm } from '@/features/registration';

import { DataCard } from '@/shared/ui/data-card';

/**
 * 工程师注册页：与登录页、客户注册页共用壳层与双栏布局。
 * 左栏说明待审口径，右栏为注册表单卡；窄屏由 CSS 改为纵向堆叠。
 */
export function RegisterEngineerPage() {
  return (
    <div className="register-layout">
      <div className="login-intro">
        <h1 className="login-intro-title">工程师注册</h1>
        <p className="login-intro-subtitle">提交申请后，由所属公司管理员审核开通</p>
        <span aria-hidden="true" className="login-intro-rule" />
        <p className="login-intro-note">
          请填写真实姓名与联系电话，并从名单中选择所属公司。审核通过前账号不可使用工作台。
        </p>
      </div>

      <div className="register-panel">
        <DataCard>
          <RegisterEngineerForm />
        </DataCard>
      </div>
    </div>
  );
}
