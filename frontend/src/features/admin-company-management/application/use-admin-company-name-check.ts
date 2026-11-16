// src/features/admin-company-management/application/use-admin-company-name-check.ts

/**
 * 公司档案新增 / 编辑的精确同名提示（只读提示，不阻断提交）。
 *
 * - 名称按与后端共享的口径归一（去首尾空白、连续空白合并为单个空格、统一小写）；
 * - 防抖后再请求，并用请求序号丢弃旧响应：改名、清空、切换目标或卸载后，
 *   晚到的旧响应不得覆盖当前提示，也不得恢复已清除的提示；
 * - 提示与「当前归一化名称 + 排除主键」绑定：任一变化即视为未命中；
 * - 查询失败按「未命中」处理，不影响提交；结果只作提示，同名仍会新增独立档案。
 */

import { useEffect, useRef, useState } from 'react';

import { checkAdminCompanyNameExists } from '../infrastructure/admin-company-adapter';

/** 与主搜索防抖节奏保持一致 */
export const ADMIN_COMPANY_NAME_CHECK_DEBOUNCE_MS = 300;

export type UseAdminCompanyNameCheckParams = {
  /** 当前输入的公司全称（未经归一化的原始值） */
  name?: string | null;
  /** 编辑时排除的自身主键；新增不传 */
  excludeOrganizationId?: number | null;
  /** 弹窗处于打开状态时才查询 */
  enabled: boolean;
};

/** 与后端同名比较归一化同口径 */
export function normalizeAdminCompanyNameForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type NameCheckResult = {
  normalizedName: string;
  excludeOrganizationId: number | null;
  exists: boolean;
};

export function useAdminCompanyNameCheck(params: UseAdminCompanyNameCheckParams): boolean {
  const { enabled, name, excludeOrganizationId } = params;
  const [result, setResult] = useState<NameCheckResult | null>(null);
  const requestSeqRef = useRef(0);
  const normalizedName = normalizeAdminCompanyNameForComparison(name ?? '');
  const excludedId = excludeOrganizationId ?? null;

  useEffect(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    if (!enabled || normalizedName.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void checkAdminCompanyNameExists({ name: normalizedName, excludeOrganizationId: excludedId })
        .then((exists) => {
          if (seq === requestSeqRef.current) {
            setResult({ normalizedName, excludeOrganizationId: excludedId, exists });
          }
        })
        .catch(() => {
          if (seq === requestSeqRef.current) {
            setResult({ normalizedName, excludeOrganizationId: excludedId, exists: false });
          }
        });
    }, ADMIN_COMPANY_NAME_CHECK_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      // 作废本轮在途请求：改名、切换目标或卸载后，晚到的旧响应不得写回
      if (requestSeqRef.current === seq) {
        requestSeqRef.current = seq + 1;
      }
    };
  }, [enabled, excludedId, normalizedName]);

  if (
    !enabled ||
    normalizedName.length === 0 ||
    result?.normalizedName !== normalizedName ||
    result.excludeOrganizationId !== excludedId
  ) {
    return false;
  }

  return result.exists;
}
