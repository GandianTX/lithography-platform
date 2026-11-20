// src/features/ai-conversation/application/use-ai-diagnosis-workspace.ts
// 工程师 AI 诊断工作区状态机（任务 05 · S3）
//
// 关键约束（来自任务书 V2.3 验收条款与 02 号页面逻辑文档）：
// - 受理与「生成中」必须以服务端事实为准：问题与待分析记录同事务保存后才显示生成中；
// - 提交结果未知时先查原问题（用同一问题 UUID 查询），不另造 UUID、不重复提问；
// - 重试沿用同一问题 UUID，不新增用户消息；
// - 迟到响应不得覆盖新画面：切换会话/工单/账号后，旧请求的响应一律丢弃；
// - 提交在飞期间的草稿编辑不得被旧响应清空或覆盖：清空只对「本次仍拥有」的草稿生效；
// - 无有效图形时清除旧定位（回到流程参考图），正文照常保留；
// - 图形只在内存渲染，不写浏览器持久存储。

import { useCallback, useEffect, useRef, useState } from 'react';

import { base64ToBlob, saveBlobAsFile } from '@/shared/download';
import { useI18n } from '@/shared/i18n';

import { parseAiVisualization } from '../domain/ai-visualization';
import type {
  AiConversationDetail,
  AiConversationListItem,
  AiConversationTurn,
  AiMessageAnalysisStatus,
  AiQuestionStatus,
  AiVisualization,
} from '../infrastructure/ai-conversation.types';
import {
  createAiConversation,
  exportAiConversation,
  getAiQuestionStatus,
  getMyAiConversation,
  listMyAiConversations,
  retryAiQuestion,
  submitAiQuestion,
} from '../infrastructure/ai-conversation-adapter';

import {
  classifyAiConversationCreateFailure,
  describeAiConversationError,
} from './ai-conversation-error';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 1500;
/** 问题正文上限（与后端校验一致，前端同步拦截，避免白跑一次提交） */
export const AI_QUESTION_MAX_LENGTH = 2000;

/** 终态：不再轮询 */
function isTerminalStatus(status: AiQuestionStatus['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

/** 未终态轮次：仍可能在服务端推进，必须继续按事实更新 */
function isActiveAnalysisStatus(status: AiMessageAnalysisStatus | null): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

/** 会话内是否还有未终态轮次（F03：不能因最后一轮成功就停止更早轮次的更新） */
function hasActiveTurns(detail: AiConversationDetail | null): boolean {
  return (detail?.turns ?? []).some((turn) => isActiveAnalysisStatus(turn.analysisStatus));
}

/** 关注轮次：默认取最新一轮（不改变「当前图形只看关注轮」的规则） */
function pickFocusTurn(detail: AiConversationDetail): AiConversationTurn | undefined {
  return [...detail.turns].sort((left, right) => (left.turnNo ?? 0) - (right.turnNo ?? 0)).at(-1);
}

/** 一次会话创建尝试的上下文（供未知结果的恢复核对使用） */
export type AiConversationCreateAttempt = {
  /** 发起创建请求的时刻（服务端 createdAt 不早于它才算本次尝试建出） */
  readonly at: number;
  /** 目标工单（独立会话为 null） */
  readonly requestId: number | null;
};

/**
 * 在列表结果中定位「本次创建尝试可能已经建出」的会话。
 *
 * 三个条件同时成立才算候选：
 * - 绑定的工单与本次尝试一致（独立会话同为 null）；
 * - 创建时间不早于本次尝试（更早的会话是用户此前留下的，不接管）；
 * - 尚无任何消息（创建后首问未受理才会留下空会话）。
 *
 * 命中多个时取最新创建的一个。
 */
export function findCreatedConversation(
  items: readonly AiConversationListItem[],
  attempt: AiConversationCreateAttempt,
): AiConversationListItem | undefined {
  return items
    .filter((item) => item.requestId === attempt.requestId)
    .filter((item) => item.messageCount === 0)
    .filter((item) => {
      const createdAt = new Date(item.createdAt).getTime();
      return Number.isFinite(createdAt) && createdAt >= attempt.at;
    })
    .sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )[0];
}

export type AiDiagnosisWorkspaceState = {
  conversations: AiConversationListItem[];
  /** 服务端会话总数（F08：首页为空与真的没有记录必须可区分） */
  conversationsTotal: number;
  /** 已加载到第几页 */
  conversationsPage: number;
  /** 正在加载更多 */
  loadingMore: boolean;
  conversation: AiConversationDetail | null;
  selectedId: number | null;
  /** 手动选择的维修阶段（1–10；随问题快照提交） */
  stage: number | null;
  /** 当前轮有效图形（仅内存） */
  visualization: AiVisualization | null;
  /** 本轮图形是否降级（无图或非法） */
  visualizationDegraded: boolean;
  /** 当前轮问题 UUID（用于状态查询与重试） */
  activeQuestionUuid: string | null;
  /** 输入框内容（提交失败保留） */
  draft: string;
  /**
   * 未建会话时的待选工单（草稿态）。
   *
   * S1：草稿优先——首次发送才创建会话，选择变化只改草稿；
   * 会话已存在时以服务端 `conversation.requestId` 为准，本字段不再参与。
   */
  draftRequestId: number | null;
  /**
   * 上一次会话创建结果未知（请求已发出但失败）。
   *
   * 此时不得再次隐式创建，否则可能重复建会话；需用户显式「核对并继续」或
   * 「放弃本次」后重试。两种恢复都必须保留用户草稿与工单选择。
   */
  createUnknown: boolean;
  /** 正在核对未知创建结果（恢复动作在飞） */
  recoveringCreate: boolean;
  loading: boolean;
  /** 正在创建会话（U05：创建期间锁定新建入口与工单输入） */
  creating: boolean;
  submitting: boolean;
  retrying: boolean;
  /** 正在重试的具体轮次（F03：逐轮重试必须标明作用对象） */
  retryingQuestionUuid: string | null;
  /** 正在导出当前会话（PDF） */
  exporting: boolean;
  /** 正在等待服务端回复 */
  generating: boolean;
  errorMessage: string | null;
  noticeMessage: string | null;
};

const INITIAL_STATE: AiDiagnosisWorkspaceState = {
  conversations: [],
  conversationsTotal: 0,
  conversationsPage: 0,
  loadingMore: false,
  conversation: null,
  selectedId: null,
  stage: null,
  visualization: null,
  visualizationDegraded: false,
  activeQuestionUuid: null,
  draft: '',
  draftRequestId: null,
  createUnknown: false,
  recoveringCreate: false,
  loading: false,
  creating: false,
  submitting: false,
  retrying: false,
  retryingQuestionUuid: null,
  exporting: false,
  generating: false,
  errorMessage: null,
  noticeMessage: null,
};

/**
 * 工作区 hook：会话列表、会话详情、提问、轮询本轮状态、失败重试、图形应用。
 */
export function useAiDiagnosisWorkspace() {
  const { t } = useI18n();
  const [state, setState] = useState<AiDiagnosisWorkspaceState>(INITIAL_STATE);

  /** 会话代数：切换会话/新建时自增，用于丢弃旧会话的迟到响应 */
  const conversationEpoch = useRef(0);
  /** 轮次代数：同会话内切换关注轮次时自增，用于丢弃旧轮的迟到响应 */
  const turnEpoch = useRef(0);
  /** 列表请求代数（F08）：首页刷新推进代数，旧的第 N 页响应不得混入新列表 */
  const listEpoch = useRef(0);
  /** 同文本重试沿用同一 UUID：受理结果不明时再次提交不重复提问 */
  const pendingQuestion = useRef<{ text: string; uuid: string } | null>(null);
  /**
   * 草稿编辑修订号（P2-1）：只有用户编辑（setDraft）才推进。
   *
   * 提交在飞期间用户可能继续编辑（删空、粘贴、改回原文），旧响应不得清空或覆盖
   * 新草稿；清空判定一律以「提交时捕获的修订号」为准。
   */
  const draftRevision = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** F06：创建/提交的同步防重入（按钮禁用不足以拦截连点与回车连发） */
  const creatingRef = useRef(false);
  const submittingRef = useRef(false);
  /** 未知创建结果的恢复防重入 */
  const recoveringRef = useRef(false);
  /**
   * 本次会话创建尝试的上下文。
   *
   * 创建结果未知时用它核对服务端是否已经建出会话，避免重复创建，
   * 同时不丢用户草稿与工单选择。
   */
  const createAttempt = useRef<AiConversationCreateAttempt | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /** 切换会话/新建：清空上一轮的本地状态（图形、输入、提示），不跨会话复用结果 */
  const resetSessionState = useCallback(() => {
    conversationEpoch.current += 1;
    turnEpoch.current += 1;
    pendingQuestion.current = null;
    // 未知创建的上下文随会话态一起作废（用户已放弃或切换）
    createAttempt.current = null;
    clearPollTimer();
    setState((current) => ({
      ...current,
      conversation: null,
      selectedId: null,
      stage: null,
      visualization: null,
      visualizationDegraded: false,
      activeQuestionUuid: null,
      draft: '',
      draftRequestId: null,
      createUnknown: false,
      generating: false,
      // 切换会话/新建即放弃当前创建态；在飞创建的 UI 态不得留到新页面
      creating: false,
      submitting: false,
      retrying: false,
      errorMessage: null,
      noticeMessage: null,
    }));
  }, [clearPollTimer]);

  /**
   * 首页结果统一应用（F08）：初次加载、新建后刷新、手动刷新都走这一条路径，
   * 一次更新 items＋page=1＋total＋loading，并推进列表代数使在途的旧页响应失效。
   */
  const applyFirstPage = useCallback(
    (page: { items: AiConversationListItem[]; total?: number | null }) => {
      listEpoch.current += 1;
      setState((current) => ({
        ...current,
        conversations: page.items,
        conversationsTotal: page.total ?? page.items.length,
        conversationsPage: 1,
        loading: false,
        loadingMore: false,
      }));
    },
    [],
  );

  const loadConversations = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, errorMessage: null }));
    const token = listEpoch.current + 1;
    listEpoch.current = token;
    try {
      const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
      if (listEpoch.current !== token) {
        return;
      }
      applyFirstPage(page);
    } catch (error) {
      if (listEpoch.current !== token) {
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, [applyFirstPage]);

  /** F08：加载下一页并追加（首页为空但 total>0 时可继续取） */
  const loadMoreConversations = useCallback(async () => {
    if (state.loadingMore || state.loading) {
      return;
    }
    const nextPage = state.conversationsPage + 1;
    const token = listEpoch.current;
    setState((current) => ({ ...current, loadingMore: true, errorMessage: null }));
    try {
      const page = await listMyAiConversations({ page: nextPage, pageSize: PAGE_SIZE });
      // 首页刷新（新建/手动刷新）已推进代数：旧页响应不得混入新列表，也不改页码与 total
      if (listEpoch.current !== token) {
        return;
      }
      setState((current) => {
        const seen = new Set(current.conversations.map((item) => item.id));
        return {
          ...current,
          conversations: [
            ...current.conversations,
            ...page.items.filter((item) => !seen.has(item.id)),
          ],
          conversationsTotal: page.total ?? current.conversationsTotal,
          conversationsPage: nextPage,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (listEpoch.current !== token) {
        return;
      }
      setState((current) => ({
        ...current,
        loadingMore: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, [state.conversationsPage, state.loading, state.loadingMore]);

  const applyVisualization = useCallback((status: AiQuestionStatus) => {
    const parsed = parseAiVisualization(status.visualization);
    setState((current) => ({
      ...current,
      // 无有效图形 → 清除旧定位（回到流程参考图），正文照常
      visualization: parsed.visualization,
      visualizationDegraded: parsed.degraded,
    }));
  }, []);

  /**
   * F03：会话内仍有未终态轮次时的后续刷新。
   *
   * 只刷新一次会话详情即可更新全部轮次状态，不为每轮各建一个定时器；
   * 图形仍只跟随「关注轮次」，这里不替未关注的轮次查询图形。
   */
  const refreshWhileTurnsActive = useCallback(
    async (conversationId: number, sessionToken: number, turnToken: number) => {
      if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
        return;
      }
      try {
        const detail = await getMyAiConversation(conversationId);
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return;
        }
        const stillActive = hasActiveTurns(detail);
        setState((current) => ({ ...current, conversation: detail, generating: stillActive }));
        if (stillActive) {
          pollTimer.current = setTimeout(() => {
            void refreshWhileTurnsActive(conversationId, sessionToken, turnToken);
          }, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return;
        }
        clearPollTimer();
        setState((current) => ({
          ...current,
          generating: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [clearPollTimer],
  );

  /** 轮询关注轮次状态：迟到响应（会话/轮次已切换）直接丢弃 */
  const pollQuestionStatus = useCallback(
    async (conversationId: number, questionUuid: string) => {
      const sessionToken = conversationEpoch.current;
      const turnToken = turnEpoch.current;
      try {
        const status = await getAiQuestionStatus({ conversationId, questionUuid });
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return;
        }
        if (!isTerminalStatus(status.status)) {
          setState((current) => ({ ...current, generating: true }));
          pollTimer.current = setTimeout(() => {
            void pollQuestionStatus(conversationId, questionUuid);
          }, POLL_INTERVAL_MS);
          return;
        }
        // 关注轮已终态：以本次读取为准更新图形（成功但无图 → 回流程参考图）
        applyVisualization(status);
        const detail = await getMyAiConversation(conversationId);
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return;
        }
        // 关注轮以本次状态读取为准：详情若仍是旧快照，不得据此把已终态的轮次重新标成生成中
        const otherTurnsActive = (detail.turns ?? []).some(
          (turn) =>
            turn.questionUuid !== questionUuid && isActiveAnalysisStatus(turn.analysisStatus),
        );
        setState((current) => ({
          ...current,
          conversation: detail,
          generating: otherTurnsActive,
          // 终态轮询说明提交阶段已结束，兜底复位提交态，避免按钮长期 loading
          submitting: false,
        }));
        if (otherTurnsActive) {
          void refreshWhileTurnsActive(conversationId, sessionToken, turnToken);
        }
      } catch (error) {
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return;
        }
        clearPollTimer();
        setState((current) => ({
          ...current,
          generating: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [applyVisualization, clearPollTimer, refreshWhileTurnsActive],
  );

  const selectConversation = useCallback(
    async (conversationId: number) => {
      const sessionToken = conversationEpoch.current + 1;
      conversationEpoch.current = sessionToken;
      turnEpoch.current += 1;
      pendingQuestion.current = null;
      clearPollTimer();
      setState((current) => ({
        ...current,
        selectedId: conversationId,
        conversation: null,
        stage: null,
        visualization: null,
        visualizationDegraded: false,
        activeQuestionUuid: null,
        draft: '',
        generating: false,
        // U05：切换历史即放弃当前创建态的展示；在飞创建仍会被 epoch 丢弃
        creating: false,
        errorMessage: null,
        noticeMessage: null,
        loading: true,
      }));
      try {
        const detail = await getMyAiConversation(conversationId);
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({ ...current, conversation: detail, loading: false }));

        // F03／F10：刷新/切换只恢复服务端正文与状态。
        // 未终态轮次继续按服务端事实推进；已终态历史不再异步补旧图形（画面回流程参考），
        // 避免「打开成功历史」这一步再引入一处迟到响应竞态。
        const focusTurn = pickFocusTurn(detail);
        if (focusTurn !== undefined && conversationEpoch.current === sessionToken) {
          const stillRunning = isActiveAnalysisStatus(focusTurn.analysisStatus);
          setState((current) => ({
            ...current,
            activeQuestionUuid: focusTurn.questionUuid,
            generating: stillRunning || hasActiveTurns(detail),
          }));
          if (stillRunning || hasActiveTurns(detail)) {
            void pollQuestionStatus(detail.id, focusTurn.questionUuid);
          }
        }
      } catch (error) {
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [clearPollTimer, pollQuestionStatus],
  );

  const createConversation = useCallback(
    async (requestId: number | null) => {
      // F06-01：创建请求在飞时忽略后续触发，避免并发创建多个会话
      if (creatingRef.current) {
        return null;
      }
      creatingRef.current = true;
      resetSessionState();
      // F06：捕获本次创建的归属（resetSessionState 已推进会话代数）
      const sessionToken = conversationEpoch.current;
      // U05：创建期间单独暴露 creating，供页面锁定新建入口与工单输入
      setState((current) => ({ ...current, loading: true, creating: true, errorMessage: null }));
      try {
        const created = await createAiConversation(requestId);
        // 期间用户已选历史/切账号/卸载：不再刷新列表、不抢走当前选择
        if (sessionToken !== conversationEpoch.current) {
          return created;
        }
        const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
        if (sessionToken !== conversationEpoch.current) {
          return created;
        }
        // F08：新建后刷新同样一次更新 items＋page=1＋total（否则下次会请求第 3 页）
        applyFirstPage(page);
        await selectConversation(created.id);
        return created;
      } catch (error) {
        if (sessionToken !== conversationEpoch.current) {
          return null;
        }
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeAiConversationError(error),
        }));
        return null;
      } finally {
        creatingRef.current = false;
        // U05：期间已切换历史/账号时，迟到的创建不得把新页面重新置为创建态
        if (sessionToken === conversationEpoch.current) {
          setState((current) => ({ ...current, creating: false }));
        }
      }
    },
    [applyFirstPage, resetSessionState, selectConversation],
  );

  /** 受理结果不明时先查原问题：查到即视为已受理（不重复提问） */
  const confirmAcceptedQuestion = useCallback(
    async (conversationId: number, questionUuid: string) => {
      try {
        const status = await getAiQuestionStatus({ conversationId, questionUuid });
        return status;
      } catch {
        return null;
      }
    },
    [],
  );

  const submitQuestion = useCallback(
    async (question: string) => {
      // F06-01：同一时刻只允许一个提交在飞（回车连发 / 连点）
      if (submittingRef.current) {
        return null;
      }
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        setState((current) => ({
          ...current,
          errorMessage: t('ai.panel.error.emptyQuestion'),
        }));
        return null;
      }
      if (trimmed.length > AI_QUESTION_MAX_LENGTH) {
        setState((current) => ({
          ...current,
          errorMessage: t('ai.panel.error.questionTooLong', {
            max: String(AI_QUESTION_MAX_LENGTH),
          }),
        }));
        return null;
      }

      // 同一文本重试沿用同一 UUID：网络失败再次提交不会产生第二条用户问题
      const pending =
        pendingQuestion.current && pendingQuestion.current.text === trimmed
          ? pendingQuestion.current
          : { text: trimmed, uuid: crypto.randomUUID() };
      pendingQuestion.current = pending;
      // P2-1：提交前捕获草稿修订号，响应回写时据此判断草稿是否仍属于本次提交
      const draftRevisionAtSubmit = draftRevision.current;
      // S1：草稿优先——未建会话时捕获此刻的工单选择，创建在飞期间目标锁定
      const draftRequestId = state.draftRequestId;
      const stageAtSubmit = state.stage;

      const sessionToken = conversationEpoch.current;
      const turnToken = turnEpoch.current + 1;
      turnEpoch.current = turnToken;

      submittingRef.current = true;
      setState((current) => ({
        ...current,
        submitting: true,
        errorMessage: null,
        noticeMessage: null,
        // F10：新一轮开始即清除上一轮图形定位，不等首次轮询返回
        visualization: null,
        visualizationDegraded: false,
      }));

      // S1：目标会话在首次发送时解析；已选中则直接复用，否则先创建
      let conversationId: number | null = state.selectedId;
      try {
        if (conversationId === null) {
          // 创建结果未知时不再隐式重建：否则可能重复建会话，
          // 需用户显式「核对并继续」或「放弃本次」后重试（两者都保留草稿）
          if (state.createUnknown) {
            setState((current) => ({
              ...current,
              submitting: false,
              errorMessage: t('ai.panel.error.createUnknown'),
            }));
            return null;
          }
          setState((current) => ({ ...current, creating: true }));
          // 记录本次创建尝试：结果未知时据此核对服务端是否已建出会话
          createAttempt.current = { at: Date.now(), requestId: draftRequestId };
          try {
            const created = await createAiConversation(draftRequestId);
            if (sessionToken !== conversationEpoch.current) {
              return null;
            }
            conversationId = created.id;
            createAttempt.current = null;
            setState((current) => ({
              ...current,
              selectedId: created.id,
              creating: false,
              createUnknown: false,
              draftRequestId: null,
            }));
            // 列表刷新不阻塞首问受理；过期响应由列表代数丢弃
            void listMyAiConversations({ page: 1, pageSize: PAGE_SIZE })
              .then((page) => {
                if (sessionToken === conversationEpoch.current) {
                  applyFirstPage(page);
                }
              })
              .catch(() => undefined);
          } catch (error) {
            if (sessionToken !== conversationEpoch.current) {
              return null;
            }
            // 创建失败的两种性质（服务端是否已答复）：
            // - 明确拒绝：会话确定未创建 → 不阻断重试，保留草稿与工单选择，
            //   用户可改工单后重新发送；
            // - 结果未知：请求可能已到达服务端 → 阻断隐式重建，等待用户核对或放弃。
            const failure = classifyAiConversationCreateFailure(error);
            setState((current) => ({
              ...current,
              creating: false,
              submitting: false,
              createUnknown: failure === 'UNKNOWN',
              errorMessage: describeAiConversationError(error),
            }));
            return null;
          }
        }

        if (conversationId === null) {
          setState((current) => ({ ...current, submitting: false }));
          return null;
        }

        const result = await submitAiQuestion({
          conversationId,
          questionUuid: pending.uuid,
          question: trimmed,
          stage: stageAtSubmit,
        });
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        pendingQuestion.current = null;
        // P2-1：提交在飞期间用户已编辑草稿时保留编辑内容，只清本次仍拥有的草稿
        const ownsDraft = draftRevision.current === draftRevisionAtSubmit;
        setState((current) => ({
          ...current,
          submitting: false,
          ...(ownsDraft ? { draft: '' } : {}),
          activeQuestionUuid: result.questionUuid,
          generating: result.status === 'PENDING' || result.status === 'RUNNING',
          errorMessage: result.dispatchStatus === 'FAILED' ? '本轮派发失败，可重试本轮。' : null,
        }));
        const detail = await getMyAiConversation(conversationId);
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        setState((current) => ({ ...current, conversation: detail }));
        void pollQuestionStatus(conversationId, result.questionUuid);
        return result;
      } catch (error) {
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        // 创建阶段就失败时没有会话可确认，保持草稿与错误提示
        if (conversationId === null) {
          setState((current) => ({ ...current, submitting: false }));
          return null;
        }
        // 受理结果不明：先查原问题；查到即按已受理处理
        const confirmed = await confirmAcceptedQuestion(conversationId, pending.uuid);
        // P2-1：确认返回后、写任何结果前复核会话与轮次，
        // 覆盖「查不到」「确认请求失败（confirmed === null）」等返程
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        if (confirmed !== null) {
          pendingQuestion.current = null;
          const ownsDraft = draftRevision.current === draftRevisionAtSubmit;
          setState((current) => ({
            ...current,
            submitting: false,
            ...(ownsDraft ? { draft: '' } : {}),
            activeQuestionUuid: confirmed.questionUuid,
            generating: !isTerminalStatus(confirmed.status),
            noticeMessage: '提交结果不明，已按原问题核对，服务端已受理。',
          }));
          const detail = await getMyAiConversation(conversationId);
          if (sessionToken === conversationEpoch.current && turnToken === turnEpoch.current) {
            setState((current) => ({ ...current, conversation: detail }));
          }
          void pollQuestionStatus(conversationId, confirmed.questionUuid);
          return null;
        }
        // 未受理：保留当前输入与错误（不回填提交文本，避免覆盖用户在飞期间的编辑），
        // 用户可原样重试（沿用同一 UUID）
        setState((current) => ({
          ...current,
          submitting: false,
          errorMessage: describeAiConversationError(error),
        }));
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [
      applyFirstPage,
      confirmAcceptedQuestion,
      pollQuestionStatus,
      state.createUnknown,
      state.draftRequestId,
      state.selectedId,
      t,
      state.stage,
    ],
  );

  /**
   * F03：逐轮重试。必须显式指定要重试的失败轮次（沿用该轮问题 UUID，不新增用户消息），
   * 不能只看「当前关注轮」，否则早轮失败、末轮成功时无法重试原失败轮。
   */
  const retryTurn = useCallback(
    async (questionUuid: string) => {
      const conversationId = state.selectedId;
      if (conversationId === null) {
        setState((current) => ({ ...current, errorMessage: '请先选择或新建一个会话' }));
        return null;
      }
      const turn = state.conversation?.turns.find((item) => item.questionUuid === questionUuid);
      if (turn === undefined || turn.analysisStatus !== 'FAILED' || turn.answer !== null) {
        setState((current) => ({
          ...current,
          errorMessage: '只有失败且未保存回答的轮次可以重试',
        }));
        return null;
      }

      const sessionToken = conversationEpoch.current;
      const turnToken = turnEpoch.current + 1;
      turnEpoch.current = turnToken;
      setState((current) => ({
        ...current,
        retrying: true,
        retryingQuestionUuid: questionUuid,
        // 关注轮切到被重试的轮次；旧图形与警示焦点一并清掉（F10）
        activeQuestionUuid: questionUuid,
        errorMessage: null,
        noticeMessage: null,
        visualization: null,
        visualizationDegraded: false,
      }));

      try {
        const result = await retryAiQuestion({
          conversationId,
          questionUuid,
          stage: state.stage,
        });
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        setState((current) => ({
          ...current,
          retrying: false,
          retryingQuestionUuid: null,
          generating: result.status === 'PENDING' || result.status === 'RUNNING',
          errorMessage: result.dispatchStatus === 'FAILED' ? '本轮派发失败，可重试本轮。' : null,
        }));
        const detail = await getMyAiConversation(conversationId);
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        setState((current) => ({
          ...current,
          conversation: detail,
          generating: hasActiveTurns(detail),
        }));
        void pollQuestionStatus(conversationId, questionUuid);
        return result;
      } catch (error) {
        if (sessionToken !== conversationEpoch.current || turnToken !== turnEpoch.current) {
          return null;
        }
        setState((current) => ({
          ...current,
          retrying: false,
          retryingQuestionUuid: null,
          errorMessage: describeAiConversationError(error),
        }));
        return null;
      }
    },
    [pollQuestionStatus, state.conversation, state.selectedId, state.stage],
  );

  /** 兼容入口：重试当前关注的轮次 */
  const retryCurrentTurn = useCallback(async () => {
    const questionUuid = state.activeQuestionUuid;
    if (questionUuid === null) {
      setState((current) => ({ ...current, errorMessage: '没有可重试的轮次' }));
      return null;
    }
    return await retryTurn(questionUuid);
  }, [retryTurn, state.activeQuestionUuid]);

  /**
   * F03：状态查询失败后的显式重试动作。
   *
   * 轮询失败会把错误抛给用户，但用户需要一个明确的「再查一次」入口，
   * 而不是重开页面或盲目重试整轮；这里只重查关注轮的服务端事实。
   */
  const refreshCurrentTurn = useCallback(async () => {
    const conversationId = state.selectedId;
    const questionUuid = state.activeQuestionUuid;
    if (conversationId === null || questionUuid === null) {
      setState((current) => ({ ...current, errorMessage: '没有可查询的轮次' }));
      return;
    }
    setState((current) => ({ ...current, errorMessage: null, noticeMessage: null }));
    await pollQuestionStatus(conversationId, questionUuid);
  }, [pollQuestionStatus, state.activeQuestionUuid, state.selectedId]);

  /**
   * 导出当前会话为 PDF（任务 05 · S4.2 · R039-01）。
   *
   * 固定当前内容版本：导出期间服务端新增的消息不混入本次产物；
   * 服务端失败或产物为空时抛错，不落地空文件。
   */
  const exportConversationPdf = useCallback(async () => {
    const current = state.conversation;
    if (current === null) {
      return;
    }
    setState((previous) => ({ ...previous, exporting: true, errorMessage: null }));
    try {
      const payload = await exportAiConversation({
        conversationId: current.id,
        contentVersion: current.contentVersion,
        format: 'PDF',
      });
      const blob = base64ToBlob(payload.contentBase64, payload.mimeType);
      if (blob.size === 0) {
        throw new Error('导出产物为空，请稍后重试');
      }
      saveBlobAsFile(blob, payload.filename);
      setState((previous) => ({
        ...previous,
        exporting: false,
        noticeMessage: `已导出 ${payload.filename}（版本 v${payload.contentVersion}）`,
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        exporting: false,
        errorMessage: describeAiConversationError(error),
      }));
    }
  }, [state.conversation]);

  const setStage = useCallback((stage: number | null) => {
    setState((current) => ({ ...current, stage }));
  }, []);

  const setDraft = useCallback((draft: string) => {
    // P2-1：用户编辑推进修订号（含删空、粘贴、改回原文），用于判定草稿归属
    draftRevision.current += 1;
    setState((current) => ({ ...current, draft }));
  }, []);

  /** S1：未建会话时选择「独立会话 / 关联工单」——只改草稿，不写服务端 */
  const setDraftRequestId = useCallback((requestId: number | null) => {
    setState((current) =>
      current.conversation === null
        ? { ...current, draftRequestId: requestId, createUnknown: false, errorMessage: null }
        : current,
    );
  }, []);

  /**
   * 接管一个已存在的会话（未知创建结果的恢复路径）。
   *
   * 与 `selectConversation` 的区别：**不清空用户草稿**——恢复时用户的现场描述
   * 必须留下，可继续发送；会话已绑定工单，后续以服务端事实为准。
   */
  const adoptConversation = useCallback(
    async (conversationId: number) => {
      const sessionToken = conversationEpoch.current + 1;
      conversationEpoch.current = sessionToken;
      turnEpoch.current += 1;
      pendingQuestion.current = null;
      clearPollTimer();
      setState((current) => ({
        ...current,
        selectedId: conversationId,
        conversation: null,
        createUnknown: false,
        recoveringCreate: false,
        generating: false,
        loading: true,
        errorMessage: null,
        noticeMessage: t('ai.panel.createRecovered'),
        // 会话已绑定工单，后续以服务端事实为准
        draftRequestId: null,
      }));
      try {
        const detail = await getMyAiConversation(conversationId);
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({ ...current, conversation: detail, loading: false }));
      } catch (error) {
        if (conversationEpoch.current !== sessionToken) {
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          errorMessage: describeAiConversationError(error),
        }));
      }
    },
    [clearPollTimer, t],
  );

  /**
   * 未知创建结果的恢复动作（S1）：先核对服务端是否已经建出会话。
   *
   * - 找到（本次尝试后创建、同工单、尚无消息）→ 接管该会话，用户草稿保留，可继续发送；
   * - 没找到 → 本次创建确定未落地，解除阻断，允许直接重新发送。
   *
   * 两种结果都保留草稿与工单选择；核对失败时同样只提示错误，不丢现场。
   */
  const recoverUnknownCreate = useCallback(async () => {
    if (state.createUnknown !== true || recoveringRef.current) {
      return null;
    }
    recoveringRef.current = true;
    const sessionToken = conversationEpoch.current;
    setState((current) => ({ ...current, recoveringCreate: true, errorMessage: null }));
    try {
      const page = await listMyAiConversations({ page: 1, pageSize: PAGE_SIZE });
      if (sessionToken !== conversationEpoch.current) {
        return null;
      }
      const attempt = createAttempt.current;
      const candidate = attempt === null ? undefined : findCreatedConversation(page.items, attempt);
      if (candidate !== undefined) {
        await adoptConversation(candidate.id);
        return candidate.id;
      }
      setState((current) => ({
        ...current,
        recoveringCreate: false,
        createUnknown: false,
        noticeMessage: t('ai.panel.createNotFound'),
      }));
      return null;
    } catch (error) {
      if (sessionToken !== conversationEpoch.current) {
        return null;
      }
      setState((current) => ({
        ...current,
        recoveringCreate: false,
        errorMessage: describeAiConversationError(error),
      }));
      return null;
    } finally {
      recoveringRef.current = false;
    }
  }, [adoptConversation, state.createUnknown, t]);

  /**
   * S1：新建回到空草稿（不创建空会话、不产生写请求）。
   *
   * 会话与工单绑定都在首次发送时才落库；这里只清本地草稿态。
   *
   * 例外：创建结果未知时，这个动作的语义是「放弃这次未知的创建」，
   * 必须保留用户草稿与工单选择，不得丢现场描述（此时另有「核对并继续」）。
   */
  const startNewDraft = useCallback(() => {
    if (state.createUnknown) {
      const keptDraft = state.draft;
      const keptRequestId = state.draftRequestId;
      resetSessionState();
      setState((current) => ({
        ...current,
        loading: false,
        draft: keptDraft,
        draftRequestId: keptRequestId,
        noticeMessage: t('ai.panel.createAbandoned'),
      }));
      return;
    }
    resetSessionState();
    setState((current) => ({ ...current, loading: false }));
  }, [resetSessionState, state.createUnknown, state.draft, state.draftRequestId, t]);

  const dismissNotice = useCallback(() => {
    setState((current) => ({ ...current, noticeMessage: null }));
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 组件卸载/账号切换：停止轮询并丢弃在途响应
  useEffect(
    () => () => {
      conversationEpoch.current += 1;
      turnEpoch.current += 1;
      if (pollTimer.current !== null) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    },
    [],
  );

  return {
    ...state,
    loadConversations,
    loadMoreConversations,
    selectConversation,
    createConversation,
    startNewDraft,
    recoverUnknownCreate,
    submitQuestion,
    retryCurrentTurn,
    retryTurn,
    refreshCurrentTurn,
    exportConversationPdf,
    setStage,
    setDraft,
    setDraftRequestId,
    dismissNotice,
  };
}
