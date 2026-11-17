// src/features/repair-request/application/use-engineer-repair-request-detail-flow.ts

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import type {
  AcceptRepairRequestResult,
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
} from '../infrastructure/engineer-repair-request.types';

import {
  clearRepairRequestClosureSucceeded,
  hasRepairRequestClosureSucceeded,
  markRepairRequestClosureSucceeded,
} from './repair-request-closure-barrier';
import { isEngineerRepairRequestEnded } from './repair-request-ended';
import { isRepairRequestWritableNow } from './repair-request-write-eligibility';
import { useAcceptRepairRequest } from './use-accept-repair-request';
import { useCreateEngineerResponse } from './use-create-engineer-response';
import {
  type EngineerRepairRequestDetailLoadOutcome,
  useEngineerRepairRequestDetail,
} from './use-engineer-repair-request-detail';

/**
 * 工程师详情 + 接单/回复编排（详情页唯一业务入口，收束在 feature application）。
 *
 * - 组合详情 query 状态机与接单/回复 command 状态，页面不直接触碰任何 adapter；
 * - 接单成功后用 Mutation 返回的最新详情原子更新当前展示（Plan P0-6 首选项，
 *   同一数据源的写后读，不发起额外查询，不产生骨架屏闪现）；
 * - 回复成功后用 Mutation 返回的新回复经 apply-response 事件原子注入当前详情，
 *   同一事件内同步 responses 与 latestResolutionStatus，不重查、不闪现；
 * - 接单冲突（申请已被接单）或 not-accessible（后端视角申请已不存在/
 *   无权）后重新查询详情：冲突 → 展示最新接单状态，按钮随之消失；
 *   not-accessible → 收敛到统一不可访问反馈，不保留可继续接单的过期按钮；
 * - accept-failed（接单结果不确定：事务可能已提交但事务外详情读取/传输失败）
 *   只重新查询当前详情确认最新状态，绝不自动重发接单 Mutation：
 *   重查发现已接单 → 展示已接单状态，按钮随 isAccepted 消失，
 *   反馈同步收敛为成功，不保留矛盾的失败提示；
 *   重查仍未接单 → 保留失败反馈，允许用户手动重试；
 *   重查失败 → 进入既有加载失败/重试状态；
 *   两个范围的列表失效宣告已由 useAcceptRepairRequest 内部完成，不重复宣告；
 * - response-failed（回复结果不确定：Mutation 可能已在服务端生效）只静默重查详情
 *   （不切 loading，详情与表单不卸载，草稿保留），绝不自动重发回复 Mutation；
 *   重查由 reconciling 状态标记进行中：表单与提交按钮禁用，
 *   提交锁覆盖「Mutation + 收敛重查」全过程，无重复提交窗口（无幂等键）；
 *   重查只能更新详情，不能仅凭「出现相同正文/状态的新回复」断言本次提交成功：
 *   回读里有相同文本也可能来自并发中的其他提交，因此保留不确定反馈与草稿，
 *   由用户检查时间线后决定是否手动重试（不丢失输入、不作虚假成功断言）；
 *   确定拒绝（not-accepted/not-accessible/insufficient-permission/invalid-input）
 *   保留当前详情，仅展示对应反馈；
 *   两个范围的列表失效宣告已由 useCreateEngineerResponse 内部完成，不重复宣告；
 * - 工单身份守卫：接单/回复的异步结果只写回发起时的工单；切换工单后旧结果
 *   不注入新详情、不重查、不展示旧反馈，也不清除新工单的编辑/输入状态；
 * - 结单本地只读屏障按「身份/会话 scopeKey + 工单 ID」登记在会话级存储中，
 *   不随详情页面以 key 重挂载而丢失：A 结单成功但服务端仍未确认结束时，
 *   切到 B 再返回 A 仍保持只读，B 不受影响；不同身份/会话互不复用；
 *   只有当前工单的已结束详情被共享详情状态实际采用后，才由服务端事实接管并撤销；
 * - 重查后若详情因权限收紧落入 not-accessible，状态照常返回，
 *   由 UI 引导返回工程师列表，不泄露申请归属；
 * - requestId 为 null（路由参数无效）时接单/回复调用直接拒绝，不产生请求；
 * - auth 错误不在这里重复处理，仍由共享 GraphQL + auth-session 全局链路负责。
 */

export function useEngineerRepairRequestDetailFlow(requestId: number | null, scopeKey = 'default') {
  const { state, reload, recheckSilently, applyDetail, applyResponse, isAdoptedIdentity } =
    useEngineerRepairRequestDetail(requestId, scopeKey);
  const {
    accept,
    acceptingKey,
    result: acceptCommandResult,
    convergeToAccepted,
  } = useAcceptRepairRequest();
  const {
    submit,
    submittingKey,
    result: createResponseCommandResult,
  } = useCreateEngineerResponse();

  /**
   * 忙状态按「工单 + 会话」归属：旧会话在飞的提交不再把新会话的按钮置为禁用。
   * 底层 command 同样按归属键记录在飞令牌，两层都只认自己的键。
   */
  const commandIdentityKey = `${requestId}:${scopeKey}`;
  const accepting = acceptingKey === commandIdentityKey;
  const submitting = submittingKey === commandIdentityKey;

  /**
   * 回复收敛中：response-failed 后的静默重查进行中（表单禁用态）。
   * 记录收敛所属工单：切换工单后自动视为不在收敛，不把旧工单的收敛态带到新工单。
   * 提交锁（busy token）覆盖「Mutation + 不确定结果收敛重查」全过程，
   * 收敛期间不会出现可再次提交的窗口。
   */
  const [reconcilingTarget, setReconcilingTarget] = useState<{
    requestId: number;
    scopeKey: string;
  } | null>(null);
  const reconciling =
    reconcilingTarget !== null &&
    reconcilingTarget.requestId === requestId &&
    reconcilingTarget.scopeKey === scopeKey;
  /** 只清除本归属的收敛态：旧会话/旧工单的 finally 不得清掉新归属的收敛标记 */
  const clearReconcilingTargetFor = useCallback(
    (targetRequestId: number, targetScopeKey: string) => {
      setReconcilingTarget((current) =>
        current !== null &&
        current.requestId === targetRequestId &&
        current.scopeKey === targetScopeKey
          ? null
          : current,
      );
    },
    [],
  );
  /** 当前工单归属：异步边界后与发起时比较，旧工单结果不得写回新工单 */
  const requestIdRef = useRef(requestId);
  /** 当前会话代次：异步边界后与发起时比较，旧会话结果不得写回新会话 */
  const scopeKeyRef = useRef(scopeKey);
  /** 实例是否仍挂载：卸载后旧回调（含新面板已就绪、重开同一工单）一律不得命中 adapter */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 最近一次渲染的 (工单, 会话) 身份：同一渲染内变化时，旧 ready 详情不得被视为新身份可用 */
  const identityRef = useRef(`${requestId}:${scopeKey}`);
  /**
   * 写入口资格的最新上下文：布局阶段随渲染同步，调用 adapter 前读取。
   * 用于拒绝「详情首载未就绪 / 页面已切换工单 / 会话已变化」时仍被旧回调触发的写入，
   * 不依赖按钮隐藏或旧 render 的闭包快照。
   */
  const writeContextRef = useRef({
    requestId,
    scopeKey,
    detail: state.status === 'ready' ? state.detail : null,
  });
  /**
   * 结单本地只读屏障：收到结单 mutation 明确成功后立即登记到会话级存储，
   * 在服务端详情被采用且确认为已结束前禁止过程与回复写入。
   * 久经详情页面以 key 重挂载后仍按「身份/会话 + 工单」命中；
   * 未结束/失败/失效/被取代的回读不撤销屏障，不同身份/会话互不复用。
   */
  const [, bumpClosureBarrierRevision] = useReducer((revision: number) => revision + 1, 0);
  const closureBarrier =
    requestId !== null && hasRepairRequestClosureSucceeded(scopeKey, requestId);
  /** 命令结果产生时所归属的工单：与当前工单不一致时对外返回 null，不展示旧反馈 */
  const [acceptResultFor, setAcceptResultFor] = useState<{
    requestId: number;
    scopeKey: string;
  } | null>(null);
  const [responseResultFor, setResponseResultFor] = useState<{
    requestId: number;
    scopeKey: string;
  } | null>(null);
  /**
   * 提交/重查忙令牌：按「工单 + 会话」归属键记录在 Map 中。
   * 切工单或换会话后旧归属的锁不再阻塞新归属；旧请求的 finally 只删除自己的键与令牌，
   * 不会清掉新请求的忙状态，也不会让同一归属的第三次提交穿透。
   */
  const responseBusyRef = useRef(new Map<string, number>());
  const responseTokenSeqRef = useRef(0);

  // 与详情 hook 同一边界同步工单归属：在途接单/回复只能写回发起时的工单。
  // 注意：结单屏障不在这里按 requestId 清除——它属于「身份/会话 + 工单」的
  // 会话级事实，切工单或页面重挂载后返回同一工单仍须保持只读。
  useLayoutEffect(() => {
    requestIdRef.current = requestId;
    scopeKeyRef.current = scopeKey;
    const identity = `${requestId}:${scopeKey}`;
    const identityChanged = identityRef.current !== identity;
    identityRef.current = identity;
    writeContextRef.current = {
      requestId,
      scopeKey,
      // 身份切换的同一渲染里，旧 ready 详情属于旧身份，不能被当作新身份可写
      detail: !identityChanged && state.status === 'ready' ? state.detail : null,
    };
  }, [requestId, scopeKey, state]);

  /**
   * 统一写入资格判定：目标工单与会话必须仍是当前的，且当前共享详情已实际采用
   * 该工单、未结束、没有本地结单屏障。供回复与过程/结单写入口在调用 adapter 前共用。
   */
  const canWriteRequest = useCallback(
    (targetRequestId: number | null, targetScopeKey: string): boolean => {
      const context = writeContextRef.current;
      if (
        !mountedRef.current ||
        targetRequestId !== context.requestId ||
        targetScopeKey !== context.scopeKey
      ) {
        return false;
      }
      return isRepairRequestWritableNow(context);
    },
    [],
  );

  /**
   * 接单的实例归属准入：原实例仍挂载、仍指向同一工单与会话，且当前详情确实已采用该工单。
   * 不复用编辑写入口的「未结束 / 结单屏障」条件：接单是接单前动作，业务准入仍由接单命令负责。
   */
  const canAcceptRequest = useCallback(
    (targetRequestId: number | null, targetScopeKey: string): boolean => {
      const context = writeContextRef.current;
      return (
        mountedRef.current &&
        targetRequestId !== null &&
        targetRequestId === context.requestId &&
        targetScopeKey === context.scopeKey &&
        targetScopeKey === scopeKeyRef.current &&
        context.detail !== null &&
        context.detail.id === targetRequestId
      );
    },
    [],
  );

  /**
   * 结单 mutation 明确成功：立即登记本地只读事实（同步写入会话级存储，
   * 早于详情回读发起），保证回读期间以及 A→B→A 重挂载后过程/回复写入口均已关闭。
   */
  const markClosureSucceeded = useCallback(() => {
    if (
      requestId === null ||
      !mountedRef.current ||
      requestIdRef.current !== requestId ||
      scopeKeyRef.current !== scopeKey
    ) {
      return;
    }
    markRepairRequestClosureSucceeded(scopeKey, requestId);
    bumpClosureBarrierRevision();
  }, [requestId, scopeKey]);

  /**
   * 结单回读已被共享详情采用且确认为已结束：服务端详情接管只读事实，撤销本地屏障。
   * 只接受当前身份、当前工单的回调；未结束、未采用、失效或被取代的回读不得走到这里。
   */
  const markClosureReadbackSucceeded = useCallback(() => {
    if (
      requestId === null ||
      !mountedRef.current ||
      requestIdRef.current !== requestId ||
      scopeKeyRef.current !== scopeKey ||
      // 只有「当前工单 + 当前会话」的详情被实际采用，才算服务端已确认结束
      !isAdoptedIdentity(requestId, scopeKey)
    ) {
      return;
    }
    clearRepairRequestClosureSucceeded(scopeKey, requestId);
    bumpClosureBarrierRevision();
  }, [requestId, scopeKey, isAdoptedIdentity]);

  /**
   * 当前共享详情实际采用并确认为已结束：服务端事实接管只读。
   * 撤销条件必须包含「采用时的身份」——同一渲染内切换会话时旧 ready 详情仍在 state 中，
   * 不能用当前 scopeKey 给它重新归属；未采用、未结束或身份不符一律不撤销。
   * 在详情已提交渲染之后才执行，撤销屏障时页面必然已按已结束详情只读，
   * 不会出现「屏障已清除、页面仍可写」的窗口。
   */
  const detailEnded = state.status === 'ready' && isEngineerRepairRequestEnded(state.detail);
  useEffect(() => {
    if (requestId === null || !detailEnded || !isAdoptedIdentity(requestId, scopeKey)) {
      return;
    }
    clearRepairRequestClosureSucceeded(scopeKey, requestId);
    bumpClosureBarrierRevision();
  }, [requestId, scopeKey, detailEnded, isAdoptedIdentity]);

  // 旧工单/旧会话的反馈不带到新页面；切换后在下一次操作前不显示任何历史结果。
  const lastAcceptResult =
    requestId !== null &&
    acceptResultFor?.requestId === requestId &&
    acceptResultFor.scopeKey === scopeKey
      ? acceptCommandResult
      : null;
  const lastCreateResponseResult =
    requestId !== null &&
    responseResultFor?.requestId === requestId &&
    responseResultFor.scopeKey === scopeKey
      ? createResponseCommandResult
      : null;

  /**
   * 发起接单。返回：
   * - null：无效 ID 或上一次接单仍在进行中（连点被拒）；
   * - 显式结果：成功或业务拒绝，调用方按 ok / reason 决定展示。
   */
  const acceptRequest = useCallback(async (): Promise<AcceptRepairRequestResult | null> => {
    const requestIdAtStart = requestId;
    if (requestIdAtStart === null) {
      return null;
    }
    // 实例归属准入：已卸载、已换工单/会话、或新详情尚未采用时，旧回调不得触达 adapter。
    if (!canAcceptRequest(requestIdAtStart, scopeKey)) {
      return null;
    }
    setAcceptResultFor({ requestId: requestIdAtStart, scopeKey });

    // 异步边界后仍属于发起时的实例/工单/会话：内层 command 依托它决定
    // 是否写反馈、是否宣告列表失效（外层 await 后的守卫拦不住内层已发出的通知）
    const isStillOwner = () =>
      mountedRef.current &&
      requestIdRef.current === requestIdAtStart &&
      scopeKeyRef.current === scopeKey;
    const acceptResult = await accept(requestIdAtStart, {
      key: `${requestIdAtStart}:${scopeKey}`,
      isCurrent: isStillOwner,
    });

    if (acceptResult === null) {
      return null;
    }

    // 实例已卸载 / 工单或会话已切换：迟到结果不注入新详情、不重查、不展示旧反馈
    if (!isStillOwner()) {
      return acceptResult;
    }

    // 成功 → Mutation 返回的就是服务器最新详情，原子注入不重查（不闪现）；
    // 冲突 / not-accessible → 现状已变（申请已被接单 / 申请不可访问），重查收敛，
    // 不保留可继续接单的过期按钮状态；
    // accept-failed → 接单结果不确定（事务可能已提交但事务外详情读取/传输失败），
    // 只重查详情确认，不自动重发接单 Mutation；
    // 重查确认视角为 MINE（接单者就是当前工程师）→ 反馈随展示状态同步收敛为成功；
    // 重查为他人已接单（TAKEN_BY_OTHER）→ 真实接单人与时间随详情展示，
    // 不保留「已接单」反馈（不做乐观伪造）；
    // 重查仍未接单 → 保留失败反馈，允许用户手动重试；
    // 重查失败 → 进入既有加载失败/重试状态，失败反馈照常保留；
    // insufficient-permission 是确定的拒绝，申请数据未变，不刷新，仅提示。
    if (acceptResult.ok) {
      applyDetail(acceptResult.detail, requestIdAtStart);
    } else if (acceptResult.reason === 'accept-failed') {
      const recheck = await reload();

      if (!isStillOwner()) {
        return acceptResult;
      }

      // 工程师入口现可读取任意未删除申请：他人接单后重查得到 TAKEN_BY_OTHER 详情，
      // 只有视角为 MINE 才证明接单成功的是当前工程师，不得以 isAccepted 误判
      if (recheck?.ok && recheck.detail.acceptanceViewStatus === 'MINE') {
        convergeToAccepted(recheck.detail);
      }
    } else if (
      acceptResult.reason === 'already-accepted' ||
      acceptResult.reason === 'not-accessible'
    ) {
      void reload();
    }

    return acceptResult;
  }, [requestId, scopeKey, accept, reload, applyDetail, convergeToAccepted, canAcceptRequest]);

  /**
   * 发起回复。返回：
   * - null：无效 ID、命令与当前详情不一致，或上一次回复（含收敛重查）仍在进行中；
   * - 显式结果：成功或业务拒绝，调用方按 ok / reason 决定展示。
   */
  const createResponse = useCallback(
    async (input: CreateEngineerResponseInput): Promise<CreateEngineerResponseResult | null> => {
      const requestIdAtStart = requestId;
      if (requestIdAtStart === null || input.requestId !== requestIdAtStart) {
        return null;
      }

      // 结单已确认成功（含页面重挂载后从会话级存储恢复）：直接拒绝回复写入。
      if (hasRepairRequestClosureSucceeded(scopeKey, requestIdAtStart)) {
        return null;
      }

      // 详情尚未就绪 / 仍是旧工单或旧会话的迟到回调：在调用 adapter 前按当前状态拒绝。
      // 同工单静默回读不会切 loading，仍保有可用详情，因此不会被一律禁写。
      if (!canWriteRequest(requestIdAtStart, scopeKey)) {
        return null;
      }

      // 提交锁覆盖「Mutation + 不确定结果收敛重查」全过程：
      // 收敛期间 reconciling 置位由 UI 禁用表单，本锁兜底拒绝并行提交，
      // 避免无幂等键时产生第二次回复。
      // 锁按「工单 + 会话」归属：旧会话在飞不阻塞新会话，同一归属重复提交仍被拒绝。
      const identityKey = `${requestIdAtStart}:${scopeKey}`;
      if (responseBusyRef.current.has(identityKey)) {
        return null;
      }
      const token = ++responseTokenSeqRef.current;
      responseBusyRef.current.set(identityKey, token);
      setResponseResultFor({ requestId: requestIdAtStart, scopeKey });

      // 内层 command 的迟到结果按同一归属判定：不属于发起时的实例/工单/会话时，
      // 不写反馈、不宣告列表失效（请求可能已在服务端处理，只隔离客户端副作用）
      const isStillOwner = () =>
        mountedRef.current &&
        requestIdRef.current === requestIdAtStart &&
        scopeKeyRef.current === scopeKey;

      try {
        const submitResult = await submit(input, {
          key: identityKey,
          isCurrent: isStillOwner,
        });

        if (submitResult === null) {
          return null;
        }

        // 实例已卸载 / 工单或会话已切换：迟到结果不写新详情、不重查新页面、不展示旧反馈
        if (!isStillOwner()) {
          return submitResult;
        }

        // 成功 → Mutation 返回的就是服务端新回复，经 apply-response 事件原子注入，
        // 不重查、不闪现；确定拒绝 → 申请数据未变，保留当前详情仅反馈；
        // response-failed → 结果不确定，只静默重查确认，绝不自动重发回复 Mutation。
        if (submitResult.ok) {
          applyResponse(submitResult.response, requestIdAtStart);
          return submitResult;
        }

        if (submitResult.reason === 'response-failed') {
          // 静默重查（不切 loading、不卸载详情与表单，草稿保留），
          // 收敛期间 reconciling 置位禁用表单与提交按钮，无重复提交窗口。
          // 重查只用于更新详情，不据此断言本次提交成功，始终保留不确定反馈。
          setReconcilingTarget({ requestId: requestIdAtStart, scopeKey });
          try {
            await recheckSilently();
          } finally {
            if (responseBusyRef.current.get(identityKey) === token) {
              if (mountedRef.current) {
                clearReconcilingTargetFor(requestIdAtStart, scopeKey);
              }
            }
          }
        }

        return submitResult;
      } finally {
        // 只释放自己取得的令牌：换会话后新归属的忙状态不被旧请求清掉，
        // 同一归属的第三次提交也无法在旧 finally 之后穿透
        if (responseBusyRef.current.get(identityKey) === token) {
          responseBusyRef.current.delete(identityKey);
          if (mountedRef.current) {
            clearReconcilingTargetFor(requestIdAtStart, scopeKey);
          }
        }
      }
    },
    [
      requestId,
      scopeKey,
      submit,
      recheckSilently,
      applyResponse,
      canWriteRequest,
      clearReconcilingTargetFor,
    ],
  );

  /**
   * 手动确认回复结果（语义明确的“重新加载详情”入口，UI 唯一重查动作）。
   *
   * 与回复提交共用同一把忙令牌，保证手动重查、自动收敛重查
   * 与回复提交三者互斥：
   * - 重查开始前获取令牌，已被提交或另一个重查占用时直接返回 null；
   * - 重查期间置 reconciling=true，UI 据此禁用正文/状态/提交/重新加载；
   * - 重查完成或失败后在 finally 中释放令牌与 reconciling，恢复手动重查入口；
   * - 只做静默重查（不切 loading、不卸载详情与表单、草稿保留），
   *   绝不自动重发回复 Mutation；重查失败时不改变当前详情与不确定提示。
   */
  const confirmResponseResult =
    useCallback(async (): Promise<EngineerRepairRequestDetailLoadOutcome | null> => {
      if (!mountedRef.current || requestId === null) {
        return null;
      }
      const identityKey = `${requestId}:${scopeKey}`;
      if (
        requestIdRef.current !== requestId ||
        scopeKeyRef.current !== scopeKey ||
        responseBusyRef.current.has(identityKey)
      ) {
        return null;
      }
      const token = ++responseTokenSeqRef.current;
      responseBusyRef.current.set(identityKey, token);
      setReconcilingTarget({ requestId, scopeKey });
      try {
        return await recheckSilently();
      } finally {
        if (responseBusyRef.current.get(identityKey) === token) {
          responseBusyRef.current.delete(identityKey);
          if (mountedRef.current) {
            clearReconcilingTargetFor(requestId, scopeKey);
          }
        }
      }
    }, [requestId, scopeKey, recheckSilently, clearReconcilingTargetFor]);

  return {
    state,
    accepting,
    lastAcceptResult,
    accept: acceptRequest,
    submitting,
    reconciling,
    lastCreateResponseResult,
    createResponse,
    canWriteRequest,
    reload,
    confirmResponseResult,
    closureBarrier,
    markClosureSucceeded,
    markClosureReadbackSucceeded,
  };
}
