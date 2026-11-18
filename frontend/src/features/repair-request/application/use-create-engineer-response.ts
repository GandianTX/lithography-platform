// src/features/repair-request/application/use-create-engineer-response.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type {
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';
import { createEngineerResponse } from '../infrastructure/engineer-repair-request-adapter';

import { invalidateEngineerRepairLists } from './engineer-repair-list-refresh';

/**
 * 工程师追加处理回复流程（command 状态，收束在 feature application）。
 *
 * - 进行中防重复提交：按钮禁用之外，按「归属键（工单 + 会话）」记录 ref 锁，
 *   连点不会产生并行 Mutation；submit 返回 null 表示同一归属下上一次回复仍在进行中；
 *   不同归属（换会话后新会话）互不继承在飞锁，新会话可以正常提交；
 * - 只调用 feature infrastructure adapter，不触碰 shared/graphql 之外的任何入口；
 * - 异步边界后的副作用按调用方提供的归属判定：不再属于发起时的实例/工单/会话时，
 *   不写反馈、不宣告列表失效（请求本身可能已被服务端处理，前端只隔离自己的副作用）；
 * - 成功后宣告工程师两个范围的列表失效，使 MINE 列表中的
 *   latestResolutionStatus 可刷新（Mutation no-cache，Apollo 不会自动同步）；
 *   not-accepted / not-accessible / insufficient-permission / invalid-input 是
 *   确定的拒绝结果，申请数据未变，不宣告失效；
 * - response-failed（后端落库失败）与 transport 失败统一视为“结果可能不确定”
 *   （Mutation 可能已在服务端生效），同样宣告列表失效；
 *   是否已写入只能由编排层重查详情确认（见 use-engineer-repair-request-detail-flow），
 *   这里绝不自动重试 Mutation（Plan §7.1）；
 * - auth 错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

/**
 * 单次提交的归属上下文。
 * - key：标识提交属于哪个 (工单, 会话)，忙锁按 key 隔离；
 * - isCurrent：异步边界后仍属于发起时的实例/工单/会话；为 false 时不得写反馈或宣告列表失效。
 */
export type EngineerResponseOwnership = {
  key: string;
  isCurrent: () => boolean;
};

/** 独立使用（无编排层归属）时的默认上下文：保持原有防连点语义 */
const DEFAULT_OWNERSHIP: EngineerResponseOwnership = {
  key: 'default',
  isCurrent: () => true,
};

export function useCreateEngineerResponse() {
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [result, setResult] = useState<CreateEngineerResponseResult | null>(null);
  /** 忙令牌按归属键记录：旧请求的 finally 只删除自己的键与令牌 */
  const busyRef = useRef(new Map<string, number>());
  const tokenSeqRef = useRef(0);
  /** 实例是否仍挂载：卸载后的迟到结果不得再写反馈或宣告列表失效 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = useCallback(
    async (
      input: CreateEngineerResponseInput,
      ownership: EngineerResponseOwnership = DEFAULT_OWNERSHIP,
    ): Promise<CreateEngineerResponseResult | null> => {
      const { key, isCurrent } = ownership;
      if (!mountedRef.current || busyRef.current.has(key)) {
        return null;
      }

      const token = ++tokenSeqRef.current;
      busyRef.current.set(key, token);
      setSubmittingKey(key);
      setResult(null);

      try {
        const submitResult = await createEngineerResponse(input);

        // 实例已卸载或归属已切换：请求可能已在服务端生效，但客户端不再写反馈与失效通知
        if (!mountedRef.current || !isCurrent()) {
          return submitResult;
        }

        setResult(submitResult);

        // 成功或结果不确定（response-failed）时列表可能已变化；确定拒绝不宣告
        if (submitResult.ok || submitResult.reason === 'response-failed') {
          invalidateEngineerRepairLists();
        }

        return submitResult;
      } catch (error) {
        const message = isGraphQLIngressError(error)
          ? error.userMessage
          : translateNow('engineerDetail.replyFailed');
        const transportResult: CreateEngineerResponseResult = {
          ok: false,
          reason: 'response-failed',
          message,
        };
        if (mountedRef.current && isCurrent()) {
          setResult(transportResult);
          // transport 失败同样视为回复结果不确定（请求可能已在服务端生效），
          // 与显式 response-failed 结果一致宣告列表失效
          invalidateEngineerRepairLists();
        }
        return transportResult;
      } finally {
        // 只释放自己取得的令牌：新会话的忙状态不被旧请求的 finally 清掉
        if (busyRef.current.get(key) === token) {
          busyRef.current.delete(key);
          if (mountedRef.current) {
            setSubmittingKey((current) => (current === key ? null : current));
          }
        }
      }
    },
    [],
  );

  /**
   * response-failed 重查确认回复已写入后的反馈收敛（application 编排层专用）：
   * 以重查详情中匹配到的服务端新回复改写最近一次结果为成功。
   */
  const convergeToSubmitted = useCallback((response: EngineerRepairRequestResponseItem) => {
    setResult({ ok: true, response });
  }, []);

  return {
    submit,
    /**
     * 是否有任意归属的提交在飞（兼容独立使用）。
     * 编排层按 submittingKey 判断当前会话是否忙，避免旧会话在飞时误禁新会话。
     */
    submitting: submittingKey !== null,
    submittingKey,
    result,
    convergeToSubmitted,
  };
}
