// src/features/registration/application/use-registration-organization-name-check.ts

/**
 * 手填公司名同名提示（独立精确查询）。
 *
 * - 只在手填分支启用（已选名单公司时立即清除提示）；
 * - 名称去首尾空白、连续空白合并为单个空格、统一小写后交给服务端精确比较，
 *   与后端归一化口径一致；
 * - 防抖后再请求，并用请求序号丢弃旧响应：清空、改名、改选名单或卸载后，
 *   晚到的旧响应不得覆盖当前提示，也不得恢复已清除的提示；
 * - 提示与「当前归一化名称」绑定：名称变化即视为未命中，不需要在 effect 内同步清状态；
 * - 查询失败按「未命中」处理，不影响手填注册提交。
 */

import { useEffect, useRef, useState } from 'react';

import { checkRegistrationOrganizationNameExists } from '../infrastructure/registration-organization-adapter';

/** 手填名称防抖时长：连续输入稳定后再发起一次精确查询 */
export const REGISTRATION_ORGANIZATION_NAME_CHECK_DEBOUNCE_MS = 300;

export type UseRegistrationOrganizationNameCheckParams = {
  /** 当前手填名称（未经归一化的原始输入） */
  name?: string | null;
  /** 是否处于手填分支；已选名单公司时为 false */
  enabled: boolean;
};

/** 与后端归一化同口径：去首尾空白、合并连续空白、统一小写 */
export function normalizeRegistrationOrganizationName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 查询结果与它对应的归一化名称（名称变化时旧结果自动失效） */
type NameCheckResult = {
  normalizedName: string;
  exists: boolean;
};

export function useRegistrationOrganizationNameCheck(
  params: UseRegistrationOrganizationNameCheckParams,
): boolean {
  const { enabled, name } = params;
  const [result, setResult] = useState<NameCheckResult | null>(null);
  const requestSeqRef = useRef(0);
  const normalizedName = normalizeRegistrationOrganizationName(name ?? '');

  useEffect(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    if (!enabled || normalizedName.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void checkRegistrationOrganizationNameExists(normalizedName)
        .then((exists) => {
          if (seq === requestSeqRef.current) {
            setResult({ exists, normalizedName });
          }
        })
        .catch(() => {
          if (seq === requestSeqRef.current) {
            setResult({ exists: false, normalizedName });
          }
        });
    }, REGISTRATION_ORGANIZATION_NAME_CHECK_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      // 作废本轮在途请求：改名、改选或卸载后，晚到的旧响应不得写回
      if (requestSeqRef.current === seq) {
        requestSeqRef.current = seq + 1;
      }
    };
  }, [enabled, normalizedName]);

  if (!enabled || normalizedName.length === 0 || result?.normalizedName !== normalizedName) {
    return false;
  }

  return result.exists;
}
