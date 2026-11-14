// src/pages/register-engineer/index.tsx

import { RegisterEngineerForm } from '@/features/registration';

import { DataCard } from '@/shared/ui/data-card';

/**
 * 工程师注册页（V44 布局）：与客户注册页、登录页共用壳层与居中单列。
 * 标题与说明在卡片上方，卡片标题「注册资料」，底部为提交与返回登录并排动作。
 */
export function RegisterEngineerPage() {
  return (
    <div className="register-layout">
      <header className="register-header">
        <h1 className="register-title">工程师注册</h1>
        <p className="register-subtitle">
          提交申请后由所属公司管理员审核开通；审核通过前账号不可使用工作台。
        </p>
      </header>

      <div className="register-panel">
        <DataCard title="注册资料">
          <RegisterEngineerForm />
        </DataCard>
      </div>
    </div>
  );
}
