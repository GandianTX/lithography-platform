// src/features/repair-request/application/use-engineer-repair-request-detail.ts

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import type {
  EngineerRepairRequestDetail,
  EngineerRepairRequestDetailFailureReason,
  EngineerRepairRequestResponseItem,
} from '../infrastructure/engineer-repair-request.types';
import {
  ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY,
  fetchEngineerRepairRequestDetail,
} from '../infrastructure/engineer-repair-request-adapter';

/**
 * 工程师维修申请详情流程（query 状态机，收束在 feature application）。
 *
 * - 加载中 / 就绪 / 失败（含重试）；统一读取版本防竞态；
 * - 无效/非法申请 ID（如路由参数不是正整数）不发请求，
 *   静态落入统一不可访问反馈，文案与 adapter 兜底共用单一真源；
 * - 业务拒绝（不存在 / 已删除 / 越权）走显式失败原因：
 *   not-accessible 为统一不可访问反馈，不泄露申请归属；
 * - transport 失败转为共享错误模型的用户文案；
 * - auth 错误不在这里特殊处理，仍由共享 GraphQL + auth-session 全局链路负责；
 * - 支持编排层原子注入写后数据（不发起查询、不产生骨架屏闪现）：
 *   applyDetail 注入接单返回的最新整份详情，
 *   applyResponse 按服务端回复 ID 去重后注入回复 Mutation 返回的新回复。
 *
 * 所有会写共享详情的读取（首载/重试、回复不确定重查、保存/结单写后回读）
 * 与写后注入共用同一套提交规则，而不是普通/静默各自维护序号：
 *
 * 1. 每次读取发出、普通加载开始、Mutation 成功注入各取得一个单调递增的读取代次；
 * 2. 读取结果只有同时满足以下条件才能写入共享详情：
 *    - 仍属于当前工单；
 *    - 代次晚于最近一次已提交结果；
 *    - 读取期间没有新的 Mutation 注入（Mutation 代表已确认的较新事实）；
 *    - 不早于最近一次普通加载（普通加载是视图重置）；
 *    - 调用方 shouldApply 仍然成立（编辑实例未失效）；
 * 3. 后发请求「开始」本身不会作废先发请求；只有成功提交、Mutation 注入、
 *    普通加载重置与切工单才建立屏障，因此后发失败/失去归属不会连带丢弃
 *    仍有效的先发结果；
 * 4. 普通加载失败只在仍是当前有效读取时落入失败态；静默读取失败不伪装成
 *    操作失败，也不清空当前详情与用户输入；
 * 5. 保存/结单等写后回读若被期间发生的 Mutation 注入作废，最多补一次静默回读，
 *    避免已确认的过程/结单事实被回复注入挤出页面；
 * 6. 切工单会重置全部代次、屏障与保留详情，旧工单迟到结果只丢弃、不污染新页面。
 *
 * 详情没有服务端版本字段，因此这里只保证客户端请求顺序，
 * 不能证明响应一定是数据库最新快照；不引入新的数据库版本机制。
 */

/**
 * 详情加载/重查的完整结果（含 transport 失败 reason=null 的形态）。
 * reload 返回该结果，供编排层在接单结果不确定（accept-failed）场景做反馈收敛决策。
 */
export type EngineerRepairRequestDetailLoadOutcome =
  | { ok: true; detail: EngineerRepairRequestDetail }
  | { ok: false; reason: EngineerRepairRequestDetailFailureReason | null; message: string };

/**
 * 详情重查选项。
 * - shouldApply：每次异步边界后重新确认归属；为 false 时本次结果不得写入共享详情；
 * - silent：写后回读/回复重查使用，不切换 loading、不卸载当前详情/表单；
 * - mutation：本次读取是写操作（保存/结单）后的正式回读，读取开始时建立
 *   Mutation 屏障；若读取期间又有更新 Mutation 注入，允许补一次静默回读。
 */
export type EngineerDetailReloadOptions = {
  shouldApply?: () => boolean;
  silent?: boolean;
  mutation?: boolean;
  /** 本次读取结果实际写入共享详情时同步通知；写后确认据此判断“已被采用” */
  onApplied?: (detail: EngineerRepairRequestDetail) => void;
};

export type EngineerRepairRequestDetailState =
  | { status: 'loading'; requestSeq: number }
  | { status: 'ready'; requestSeq: number; detail: EngineerRepairRequestDetail }
  | {
      status: 'failed';
      requestSeq: number;
      reason: EngineerRepairRequestDetailFailureReason | null;
      message: string;
    };

type EngineerRepairRequestDetailAction =
  | { type: 'load-start'; requestSeq: number }
  | { type: 'commit-detail'; requestSeq: number; detail: EngineerRepairRequestDetail }
  | {
      type: 'load-failed';
      requestSeq: number;
      reason: EngineerRepairRequestDetailFailureReason | null;
      message: string;
    };

/**
 * 回复按 createdAt ASC + id ASC 排序（公共读模型契约）。
 * 新回复的服务端 createdAt 晚于既有回复，但并发下其他工程师可能刚追加过回复，
 * 排序后取末条与后端 QueryService「createdAt DESC + id DESC 取末条」完全同口径。
 */
function mergeEngineerResponseSorted(
  responses: EngineerRepairRequestResponseItem[],
  incoming: EngineerRepairRequestResponseItem[],
): EngineerRepairRequestResponseItem[] {
  const byId = new Map<number, EngineerRepairRequestResponseItem>();
  for (const item of [...responses, ...incoming]) {
    byId.set(item.id, item);
  }

  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id - b.id;
  });
}

function mergeDetailWithResponses(
  detail: EngineerRepairRequestDetail,
  incoming: EngineerRepairRequestResponseItem[],
): EngineerRepairRequestDetail {
  if (incoming.length === 0) {
    return detail;
  }

  const responses = mergeEngineerResponseSorted(detail.responses, incoming);
  return {
    ...detail,
    responses,
    latestResolutionStatus: responses[responses.length - 1].resolutionStatus,
  };
}

function toDetailUserMessage(error: unknown): string {
  return isGraphQLIngressError(error)
    ? error.userMessage
    : translateNow('engineerDetail.loadFailed');
}

function engineerRepairRequestDetailReducer(
  state: EngineerRepairRequestDetailState,
  action: EngineerRepairRequestDetailAction,
): EngineerRepairRequestDetailState {
  switch (action.type) {
    case 'load-start':
      return { status: 'loading', requestSeq: action.requestSeq };
    case 'commit-detail':
      // 提交准入由 hook 的代次/归属判定统一完成；这里允许从 loading/failed
      // 直接进入 ready，避免有效结果因 reducer 正处于 loading 而被静默丢弃。
      return { status: 'ready', requestSeq: action.requestSeq, detail: action.detail };
    case 'load-failed':
      if (action.requestSeq !== state.requestSeq) {
        return state;
      }
      return {
        status: 'failed',
        requestSeq: action.requestSeq,
        reason: action.reason,
        message: action.message,
      };
  }
}

/**
 * requestId 为 null 表示路由参数无效；不发请求，直接静态落入统一不可访问反馈。
 *
 * scopeKey 为「账号 + 会话代次」的窄身份：同一工单在同一 hook 实例内切换会话时，
 * 旧详情立即失效并重新读取；旧会话在途读取的迟到成功/失败一律丢弃。
 */
export function useEngineerRepairRequestDetail(requestId: number | null, scopeKey = 'default') {
  const [state, dispatch] = useReducer(engineerRepairRequestDetailReducer, {
    status: 'loading',
    requestSeq: 0,
  });
  /** reducer 状态的最新快照：异步回调只通过它读取当前详情，不依赖渲染闭包 */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** 普通加载（loading 状态机）序号 */
  const sequenceRef = useRef(0);
  /** 全局读取代次：读取发出、普通加载开始、Mutation 注入共用 */
  const revisionRef = useRef(0);
  /** 最近一次成功写入共享详情的代次 */
  const lastCommittedRevRef = useRef(0);
  /** 最近一次 Mutation 注入的代次（读取期间变化即代表被更新事实取代） */
  const lastMutationRevRef = useRef(0);
  /** 最近一次普通加载开始的代次（视图重置屏障） */
  const lastNormalStartRevRef = useRef(0);
  /** 当前工单归属：异步边界后与 targetId 比较，旧工单结果不得写入新工单 */
  const requestIdRef = useRef(requestId);
  /** 当前会话代次：同工单换会话同样作废旧详情与在途读取 */
  const scopeKeyRef = useRef(scopeKey);
  /** 实例是否仍挂载：卸载后所有迟到成功/失败都不得再提交 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 最近一次已提交详情：Mutation 注入与 loading 期间的读取结果都以它为基底 */
  const lastReadyDetailRef = useRef<EngineerRepairRequestDetail | null>(null);
  /**
   * 最近一次被共享详情状态实际采用的 (工单, 会话) 身份。
   * 提交渲染只证明“数据存在”，不证明它属于当前渲染的会话：同一渲染内切换
   * scopeKey 时旧 ready 详情仍在 state 中。屏障撤销等下游事实必须按“采用时”
   * 的身份判断，不能用当前 scopeKey 给旧数据重新归属。
   */
  const adoptedIdentityRef = useRef<{ requestId: number | null; scopeKey: string } | null>(null);
  /** 尚无详情基底时暂存的回复：等下一次详情提交时合并，避免回复事实丢失 */
  const pendingResponsesRef = useRef<EngineerRepairRequestResponseItem[]>([]);
  /** 静默重查防并发令牌：只允许一个在飞，旧令牌的 finally 不清新请求的标记 */
  const recheckBusyTokenRef = useRef<number | null>(null);
  const recheckTokenSeqRef = useRef(0);

  const absorbPendingResponses = useCallback((detail: EngineerRepairRequestDetail) => {
    if (pendingResponsesRef.current.length === 0) {
      return detail;
    }

    const merged = mergeDetailWithResponses(detail, pendingResponsesRef.current);
    pendingResponsesRef.current = [];
    return merged;
  }, []);

  const commitDetail = useCallback(
    (detail: EngineerRepairRequestDetail, requestSeq: number) => {
      const next = absorbPendingResponses(detail);
      lastReadyDetailRef.current = next;
      // 采用身份与数据同步登记：此后任何异步边界都按此身份判断归属，
      // 而不是按调用方当前渲染闭包里的 requestId/scopeKey 重新认领。
      adoptedIdentityRef.current = {
        requestId: requestIdRef.current,
        scopeKey: scopeKeyRef.current,
      };
      dispatch({ type: 'commit-detail', requestSeq, detail: next });
      return next;
    },
    [absorbPendingResponses],
  );

  const loadDetail = useCallback(
    async (
      targetId: number,
      options?: EngineerDetailReloadOptions,
    ): Promise<EngineerRepairRequestDetailLoadOutcome> => {
      const shouldApply = options?.shouldApply;
      const silent = options?.silent === true;
      const mutation = options?.mutation === true;
      const onApplied = options?.onApplied;
      // 会话代次在读取发出时固定：期间换会话，结果一律不得写入
      const targetScopeKey = scopeKeyRef.current;

      // 调用时即确认归属：已切走的实例不再发起共享详情写入
      if (targetId !== requestIdRef.current || targetScopeKey !== scopeKeyRef.current) {
        return { ok: false, reason: null, message: '已切换工单或会话，放弃本次详情回读。' };
      }
      if (shouldApply && !shouldApply()) {
        return { ok: false, reason: null, message: '已切换编辑对象，放弃本次详情回读。' };
      }

      if (mutation) {
        // 写后回读代表一次已确认的写事实：立即建立 Mutation 屏障，
        // 使此前发出、尚未返回的读取不能在其后覆盖；同时结束被取代的 loading。
        const mutationRev = ++revisionRef.current;
        lastMutationRevRef.current = mutationRev;
        const retained =
          lastReadyDetailRef.current ??
          (stateRef.current.status === 'ready' ? stateRef.current.detail : null);
        if (retained !== null) {
          lastCommittedRevRef.current = mutationRev;
          if (stateRef.current.status !== 'ready') {
            commitDetail(retained, sequenceRef.current);
          }
        }
      }

      let sequence: number;
      let rev: number;
      if (silent) {
        // 写后回读：不进入 loading，避免卸载当前编辑表单；不推进普通加载序号。
        sequence = sequenceRef.current;
        rev = ++revisionRef.current;
      } else {
        // 普通加载是视图重置：推进序号并进入 loading，早于它的读取不得在其后提交。
        sequenceRef.current += 1;
        sequence = sequenceRef.current;
        rev = ++revisionRef.current;
        lastNormalStartRevRef.current = rev;
        dispatch({ type: 'load-start', requestSeq: sequence });
      }

      const mutationRevAtStart = lastMutationRevRef.current;

      /** 异步边界后的统一提交准入：挂载、工单、会话、代次、Mutation 与编辑实例全部仍有效 */
      const canCommit = () =>
        mountedRef.current &&
        targetId === requestIdRef.current &&
        targetScopeKey === scopeKeyRef.current &&
        rev > lastCommittedRevRef.current &&
        rev >= lastNormalStartRevRef.current &&
        mutationRevAtStart === lastMutationRevRef.current &&
        (!shouldApply || shouldApply());

      const commitRead = (detail: EngineerRepairRequestDetail) => {
        lastCommittedRevRef.current = rev;
        commitDetail(detail, sequence);
        onApplied?.(detail);
      };

      /**
       * 写后回读被期间发生的 Mutation 注入取代时，最多补一次静默回读：
       * 已确认的过程/结单事实不能因为一次回复注入而丢失。
       */
      const readAfterMutation = async (): Promise<EngineerRepairRequestDetailLoadOutcome> => {
        const retryRev = ++revisionRef.current;
        const retryMutationRev = lastMutationRevRef.current;
        try {
          const retried = await fetchEngineerRepairRequestDetail(targetId);
          if (
            retried.ok &&
            mountedRef.current &&
            targetId === requestIdRef.current &&
            targetScopeKey === scopeKeyRef.current &&
            retryRev > lastCommittedRevRef.current &&
            retryRev >= lastNormalStartRevRef.current &&
            retryMutationRev === lastMutationRevRef.current &&
            (!shouldApply || shouldApply())
          ) {
            lastCommittedRevRef.current = retryRev;
            commitDetail(retried.detail, sequenceRef.current);
            onApplied?.(retried.detail);
          }
          return retried;
        } catch (error) {
          return { ok: false, reason: null, message: toDetailUserMessage(error) };
        }
      };

      try {
        const result = await fetchEngineerRepairRequestDetail(targetId);

        if (!canCommit()) {
          // 后发请求失败/失去归属不会建立屏障；只有被 Mutation 取代的写后回读
          // 允许补读一次，且不抢在更新的普通加载之前。
          if (
            silent &&
            mutation &&
            result.ok &&
            mountedRef.current &&
            targetId === requestIdRef.current &&
            targetScopeKey === scopeKeyRef.current &&
            rev >= lastNormalStartRevRef.current &&
            mutationRevAtStart !== lastMutationRevRef.current &&
            (!shouldApply || shouldApply())
          ) {
            return await readAfterMutation();
          }

          return result;
        }

        if (canCommit()) {
          if (silent) {
            // 静默读取失败不写共享失败态：保留当前快照，返回结果由调用方收敛业务反馈
            if (result.ok) {
              commitRead(result.detail);
            }
          } else if (result.ok) {
            commitRead(result.detail);
          } else {
            dispatch({
              type: 'load-failed',
              requestSeq: sequence,
              reason: result.reason,
              message: result.message,
            });
          }
        }

        return result;
      } catch (error) {
        const message = toDetailUserMessage(error);
        if (!silent && canCommit()) {
          dispatch({
            type: 'load-failed',
            requestSeq: sequence,
            reason: null,
            message,
          });
        }

        return { ok: false, reason: null, message };
      }
    },
    [commitDetail],
  );

  // 布局阶段同步工单与会话归属：提交完成后、任何后续微任务（可能在途请求返回）之前
  // 更新归属，旧工单/旧会话结果不会因渲染与 effect 之间的空档写入新页面。
  useLayoutEffect(() => {
    requestIdRef.current = requestId;
    scopeKeyRef.current = scopeKey;

    // 切工单或切会话：重置全部代次与屏障，旧实例迟到的成功/失败都不得污染新页面。
    const resetRev = ++revisionRef.current;
    lastCommittedRevRef.current = resetRev;
    lastMutationRevRef.current = resetRev;
    lastNormalStartRevRef.current = resetRev;
    lastReadyDetailRef.current = null;
    adoptedIdentityRef.current = null;
    pendingResponsesRef.current = [];
    recheckBusyTokenRef.current = null;

    if (requestId === null) {
      // 先推进序号再落静态失败：reducer 的竞态守卫只接受与当前序号一致的 action，
      // 缺少 load-start 会让下面的 load-failed 被守卫丢弃、状态永久停在骨架屏。
      // load-start 在此只表达「作废此前所有在飞请求并进入新序号」，不发起查询；
      // 两次 dispatch 在同一 effect 内被 React 批处理，不会产生 loading 闪现。
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      dispatch({ type: 'load-start', requestSeq: sequence });
      dispatch({
        type: 'load-failed',
        requestSeq: sequence,
        reason: 'not-accessible',
        message: translateNow(ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY),
      });
      return;
    }

    void loadDetail(requestId);
  }, [requestId, scopeKey, loadDetail]);

  /**
   * 重查当前详情（沿用查询状态机推进：重查失败落入既有加载失败/重试状态）。
   * 返回本次重查结果供编排层决策（requestId 为 null 时不发请求，返回 null）。
   */
  const reload = useCallback(
    (
      options?: EngineerDetailReloadOptions,
    ): Promise<EngineerRepairRequestDetailLoadOutcome | null> => {
      if (requestId === null) {
        return Promise.resolve(null);
      }

      return loadDetail(requestId, options);
    },
    [requestId, loadDetail],
  );

  /**
   * 静默重查当前详情：不把查询状态机切回 loading（不卸载已渲染的详情与表单），
   * 供回复结果不确定（response-failed）的收敛重查使用，避免表单草稿丢失。
   *
   * 与保存/结单回读共用 loadDetail 的统一提交规则：
   * - 后发静默读取开始不再作废先发仍有效的静默结果；只有成功提交建立屏障；
   * - 工单切换、Mutation 注入、普通加载重置都会使旧读取过期；
   * - 过期只丢弃详情快照，本次调用的结果仍原样返回，
   *   回复不确定状态由编排层按当前实例收敛（不会卡在 loading）；
   * - 失败（业务拒绝或 transport）不改动查询状态机，保留当前详情与既有反馈；
   * - 防并发：同一时间只允许一个静默重查在飞，重入时直接返回 null
   *   （调用方按未确认处理），不叠加并行请求。
   */
  const recheckSilently =
    useCallback((): Promise<EngineerRepairRequestDetailLoadOutcome | null> => {
      if (requestId === null || recheckBusyTokenRef.current !== null) {
        return Promise.resolve(null);
      }

      const token = ++recheckTokenSeqRef.current;
      recheckBusyTokenRef.current = token;

      return loadDetail(requestId, { silent: true }).finally(() => {
        // 切工单会清空令牌；旧请求的 finally 不得清掉新工单的重查标记
        if (recheckBusyTokenRef.current === token) {
          recheckBusyTokenRef.current = null;
        }
      });
    }, [requestId, loadDetail]);

  /**
   * 用接单 Mutation 返回的最新详情原子更新当前展示（不发起查询）。
   * 这是已确认的较新写事实：即使当前正在 loading，也直接结束 loading 并建立屏障，
   * 使此前发出的旧详情读取无法在其后覆盖。
   */
  const applyDetail = useCallback(
    (detail: EngineerRepairRequestDetail, sourceRequestId?: number) => {
      if (!mountedRef.current) {
        return;
      }
      if (sourceRequestId !== undefined && sourceRequestId !== requestIdRef.current) {
        return;
      }
      // 失败态（如不可访问）不因注入复活；查询流程自行推进状态。
      if (stateRef.current.status === 'failed') {
        return;
      }

      const mutationRev = ++revisionRef.current;
      lastMutationRevRef.current = mutationRev;
      lastCommittedRevRef.current = mutationRev;
      commitDetail(detail, sequenceRef.current);
    },
    [commitDetail],
  );

  /**
   * 用回复 Mutation 返回的新回复原子更新当前展示（不发起查询）。
   * 按服务端回复 ID 去重，同一事件内同步 responses 与 latestResolutionStatus
   * （编排层用，UI 不手工拼装）。
   *
   * 注入即已确认的较新写事实：推进 Mutation 屏障，使此前发出、尚在飞行中的
   * 旧详情读取返回时被丢弃，不得用旧快照覆盖新回复或使 latestResolutionStatus 倒退。
   * 若当前尚无详情基底（首载未完成），先暂存回复，等下一次详情提交时合并，
   * 不因缺少基底而丢失回复事实。
   */
  const applyResponse = useCallback(
    (response: EngineerRepairRequestResponseItem, sourceRequestId?: number) => {
      if (!mountedRef.current) {
        return;
      }
      if (sourceRequestId !== undefined && sourceRequestId !== requestIdRef.current) {
        return;
      }

      const base =
        stateRef.current.status === 'ready' ? stateRef.current.detail : lastReadyDetailRef.current;
      if (base === null) {
        if (!pendingResponsesRef.current.some((item) => item.id === response.id)) {
          pendingResponsesRef.current = [...pendingResponsesRef.current, response];
        }
        return;
      }

      const mutationRev = ++revisionRef.current;
      lastMutationRevRef.current = mutationRev;
      lastCommittedRevRef.current = mutationRev;
      // 保持既有语义：回复注入推进普通查询版本，旧查询（携带旧版本）被守卫丢弃。
      sequenceRef.current += 1;
      commitDetail(mergeDetailWithResponses(base, [response]), sequenceRef.current);
    },
    [commitDetail],
  );

  /**
   * 当前共享状态中的详情是否确实来自给定 (工单, 会话) 的采用事实。
   * 只读 adoptedIdentityRef，不把当前渲染的 scopeKey 当作旧数据的归属依据。
   */
  const isAdoptedIdentity = useCallback(
    (targetId: number | null, targetScopeKey: string): boolean =>
      targetId !== null &&
      adoptedIdentityRef.current?.requestId === targetId &&
      adoptedIdentityRef.current?.scopeKey === targetScopeKey,
    [],
  );

  return { state, reload, recheckSilently, applyDetail, applyResponse, isAdoptedIdentity };
}
