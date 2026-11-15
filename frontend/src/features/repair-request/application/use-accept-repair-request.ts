// src/features/repair-request/application/use-accept-repair-request.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type {
  AcceptRepairRequestResult,
  EngineerRepairRequestDetail,
} from '../infrastructure/engineer-repair-request.types';
import { acceptRepairRequest } from '../infrastructure/engineer-repair-request-adapter';

import { invalidateEngineerRepairLists } from './engineer-repair-list-refresh';

/**
 * 工程师接单流程（command 状态，收束在 feature application）。
 *
 * - 进行中防重复提交：按钮禁用之外，按「归属键（工单 + 会话）」记录 ref 锁，
 *   连点不会产生并行 Mutation；accept 返回 null 表示同一归属下上一次接单仍在进行中；
 *   不同归属（换会话后新会话）互不继承在飞锁；
 * - 业务拒绝（已被接单 / 不可访问 / 无权限 / 系统失败）以显式结果返回，
 *   大类 CONFLICT 是稳定运行时分支，提示文案不依赖生产可能隐藏的细节码；
 * - 异步边界后的副作用按调用方提供的归属判定：不再属于发起时的实例/工单/会话时，
 *   不写反馈、不宣告列表失效（只隔离客户端副作用，不宣称请求被取消或服务端未写入）；
 * - 接单成功、冲突（申请已被接单）与 accept-failed（接单结果不确定：
 *   事务可能已提交但事务外详情读取或传输失败）后宣告工程师两个范围的列表失效，
 *   挂载中的列表自动刷新，不保留“仍可接单”的过期假象
 *   （Mutation no-cache，Apollo 不会自动同步）；
 *   无权限 / 不可访问属于确定的拒绝结果，申请数据未变，不宣告失效；
 * - transport 失败转为共享错误模型的用户文案；
 * - accept-failed 后由编排层重查确认（见 use-engineer-repair-request-detail-flow）：
 *   确认已接单时用 convergeToAccepted 将展示反馈收敛为成功，
 *   不保留与「已接单」状态矛盾的失败提示；
 * - auth 错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

/** 单次接单的归属上下文；语义与回复 command 的归属上下文一致 */
export type AcceptRepairRequestOwnership = {
  key: string;
  isCurrent: () => boolean;
};

const DEFAULT_OWNERSHIP: AcceptRepairRequestOwnership = {
  key: 'default',
  isCurrent: () => true,
};

export function useAcceptRepairRequest() {
  const [acceptingKey, setAcceptingKey] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptRepairRequestResult | null>(null);
  /** 忙令牌按归属键记录：旧请求的 finally 只删除自己的键与令牌 */
  const busyRef = useRef(new Map<string, number>());
  const tokenSeqRef = useRef(0);
  /** 实例是否仍挂载：卸载后的迟到接单结果不得再写反馈或宣告列表失效 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const accept = useCallback(
    async (
      requestId: number,
      ownership: AcceptRepairRequestOwnership = DEFAULT_OWNERSHIP,
    ): Promise<AcceptRepairRequestResult | null> => {
      const { key, isCurrent } = ownership;
      if (!mountedRef.current || busyRef.current.has(key)) {
        return null;
      }

      const token = ++tokenSeqRef.current;
      busyRef.current.set(key, token);
      setAcceptingKey(key);
      setResult(null);

      try {
        const acceptResult = await acceptRepairRequest(requestId);
        if (!mountedRef.current || !isCurrent()) {
          return acceptResult;
        }
        setResult(acceptResult);

        // 成功 / 已被接单（冲突）/ 接单结果不确定（accept-failed）时，
        // 两个范围的列表数据都可能已变化；无权限 / 不可访问是确定的拒绝，申请数据未变
        if (
          acceptResult.ok ||
          acceptResult.reason === 'already-accepted' ||
          acceptResult.reason === 'accept-failed'
        ) {
          invalidateEngineerRepairLists();
        }

        return acceptResult;
      } catch (error) {
        const message = isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('engineerDetail.acceptFailed');
        const transportResult: AcceptRepairRequestResult = {
          ok: false,
          reason: 'accept-failed',
          message,
        };
        if (mountedRef.current && isCurrent()) {
          setResult(transportResult);
          // transport 失败同样视为接单结果不确定（请求可能已在服务端生效），
          // 与显式 accept-failed 结果一致宣告列表失效
          invalidateEngineerRepairLists();
        }
        return transportResult;
      } finally {
        // 只释放自己取得的令牌：新会话的忙状态不被旧请求的 finally 清掉
        if (busyRef.current.get(key) === token) {
          busyRef.current.delete(key);
          if (mountedRef.current) {
            setAcceptingKey((current) => (current === key ? null : current));
          }
        }
      }
    },
    [],
  );

  /**
   * accept-failed 重查确认已接单后的反馈收敛（application 编排层专用）：
   * 重查结果与查询状态机同一数据源，确认已接单后把最近一次结果改写为成功。
   */
  const convergeToAccepted = useCallback((detail: EngineerRepairRequestDetail) => {
    if (!mountedRef.current) {
      return;
    }
    setResult({ ok: true, detail });
  }, []);

  return {
    accept,
    /** 是否有任意归属的接单在飞（兼容独立使用）；编排层按 acceptingKey 判断当前会话 */
    accepting: acceptingKey !== null,
    acceptingKey,
    result,
    convergeToAccepted,
  };
}
