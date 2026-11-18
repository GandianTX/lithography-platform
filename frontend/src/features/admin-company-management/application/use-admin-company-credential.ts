// src/features/admin-company-management/application/use-admin-company-credential.ts

/**
 * 一次性凭据弹窗的数据持有者。
 *
 * `temporaryPassword` 只允许存在于本 hook 的组件 state：
 * - 不写入 sessionStorage / localStorage；
 * - 不写入 Apollo 缓存（mutation 由 shared/graphql 统一 no-cache）；
 * - 组件卸载（关闭页面、退路由、换身份重挂载）即销毁。
 *
 * 回放或响应不确定时口令为 null，弹窗只展示安全信息。
 */

import { useCallback, useState } from 'react';

import type { AdminCompanyCredentialView } from './admin-company-management.types';

export function useAdminCompanyCredential() {
  const [credential, setCredential] = useState<AdminCompanyCredentialView | null>(null);

  const show = useCallback((next: AdminCompanyCredentialView) => {
    setCredential(next);
  }, []);

  const clear = useCallback(() => {
    setCredential(null);
  }, []);

  return { clear, credential, show };
}
