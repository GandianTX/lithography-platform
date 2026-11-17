// src/features/admin-user-management/application/use-admin-level-two-credential.ts

/**
 * 二级管理员凭据的唯一存放点。
 *
 * 口令只存在于组件 state：不写 sessionStorage / localStorage，不进 Apollo 缓存，
 * 不进入 URL 或日志。弹窗关闭、面板卸载（含页面 `key` 重挂载）即销毁。
 */

import { useCallback, useState } from 'react';

import type { AdminLevelTwoCredentialView } from './admin-user-management.types';

export function useAdminLevelTwoCredential() {
  const [credential, setCredential] = useState<AdminLevelTwoCredentialView | null>(null);

  const show = useCallback((view: AdminLevelTwoCredentialView) => {
    setCredential(view);
  }, []);

  const clear = useCallback(() => {
    setCredential(null);
  }, []);

  return { clear, credential, show };
}
