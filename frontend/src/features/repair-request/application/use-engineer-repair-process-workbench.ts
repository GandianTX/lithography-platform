// src/features/repair-request/application/use-engineer-repair-process-workbench.ts

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  CloseRepairRequestResult,
  DownloadRepairProcessFileResult,
  EngineerRepairProcessEntry,
  EngineerRepairRequestDetail,
  InterruptRepairRequestResult,
  RepairProcessWriteResult,
  RepairRequestHandlingResult,
  StagedRepairProcessFile,
  UploadRepairProcessFileResult,
} from '../infrastructure/engineer-repair-request.types';
import {
  closeRepairRequest,
  createRepairProcessEntry,
  downloadRepairProcessFile,
  interruptRepairRequest,
  updateRepairProcessEntry,
  uploadRepairProcessFile,
} from '../infrastructure/engineer-repair-request-adapter';

import { isEngineerRepairRequestEnded } from './repair-request-ended';
import type { EngineerRepairRequestDetailLoadOutcome } from './use-engineer-repair-request-detail';

export type RepairProcessFormInput = {
  operationText: string;
  testResult: string | null;
  occurredAt: string | null;
};

type EditInstance = {
  requestId: number;
  /** 会话/账号代次：换会话后旧实例的在途结果不得写回新会话页面 */
  sessionScopeKey: string;
  scopeKey: string;
  generation: number;
};

type StagedFileState = {
  file: StagedRepairProcessFile;
  instance: EditInstance;
};

const STAGED_DISCARD_NOTICE =
  '上一编辑对象的上传文件未带入当前编辑，也未随保存提交；服务端暂存文件未被删除，如需使用请重新上传。';

const STAGED_SUBMIT_PENDING_NOTICE =
  '上一编辑对象上传的原件已随保存请求提交，结果尚待确认；本地引用未带入当前编辑。前端不会取消已发出的请求，文件可能已绑定，请刷新详情确认。';

type ProcessReload = (options?: {
  shouldApply?: () => boolean;
  silent?: boolean;
  mutation?: boolean;
  onApplied?: (detail: EngineerRepairRequestDetail) => void;
}) => Promise<unknown>;

export type ProcessWorkbenchOptions = {
  /** 本地只读屏障：结单已成功但详情尚未由服务端事实接管时，拒绝所有实际写入口 */
  writeBlocked?: boolean;
  /** 当前登录会话/账号作用域；与写入口资格判定一起用于拒绝旧会话的迟到回调 */
  scopeKey?: string;
  /**
   * 调用 adapter 前读取当前状态的统一写入资格判定（回复/上传/过程/结单共用）。
   * 返回 false 表示详情未就绪、工单/会话已切换、详情已结束或本地结单屏障生效。
   */
  writeEligible?: (requestId: number | null, scopeKey: string) => boolean;
  /** 结单 mutation 明确成功、发起详情回读之前同步通知页面建立只读屏障 */
  onCloseSucceeded?: () => void;
  /** 结单回读结果被共享详情采用且确认为已结束：由服务端详情接管只读状态 */
  onCloseReadbackSucceeded?: () => void;
};

function instanceKey(instance: EditInstance): string {
  return `${instance.requestId}:${instance.sessionScopeKey}:${instance.scopeKey}:${instance.generation}`;
}

function sameInstance(left: EditInstance, right: EditInstance): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionScopeKey === right.sessionScopeKey &&
    left.scopeKey === right.scopeKey &&
    left.generation === right.generation
  );
}

/**
 * 内部维修过程 / 原件 / 结单编排（任务 04 第一轮）。
 *
 * - 上传只产生「已上传暂存」状态；保存过程成功后才成为「已保存绑定」；
 * - 保存时暂存原件与过程共用后端同一事务；保存成功后清空暂存并走正式详情读接口回读；
 * - 编辑仅在当前过程尚无原件时补传暂存原件；已有原件时更新入参不携带文件且不消耗暂存；
 * - 每次进入编辑（含 A→B→A、关闭后重开）都推进实例代次；暂存文件、上传/保存结果、
 *   loading 与完成回调都绑定到「工单 ID + 过程 ID + 实例代次」；
 *   旧实例的迟到响应不得写入当前实例，服务端已成功的保存不会被前端取消；
 * - 切换实例时显式丢弃旧实例的本地暂存引用并提示，不删除服务端暂存、不伪称已取消写入，
 *   也绝不把旧暂存带入新过程或新工单；
 * - 同一实例内的上传、保存、结单各自以同步忙键防重（同一入口重复调用被拒绝）；
 *   不同入口、不同实例的在飞请求互不阻塞；`closing` 只反映当前结单令牌的忙状态；
 * - 编辑携带 expectedVersion，冲突时不自动重试，只提示并刷新；
 * - 结单成功只回读详情，不在前端伪造结单事实。
 */
export function useEngineerRepairProcessWorkbench(
  requestId: number | null,
  reload: ProcessReload,
  options: ProcessWorkbenchOptions = {},
) {
  const {
    writeBlocked = false,
    scopeKey: sessionScopeKey = 'default',
    writeEligible,
    onCloseSucceeded,
    onCloseReadbackSucceeded,
  } = options;
  /**
   * 写入口在调用 adapter 前的最后一道判定：优先读取当前最新状态，
   * 而不是仅依赖按钮隐藏或旧 render 的 writeBlocked 快照。
   */
  /** 实例是否仍挂载：卸载后的旧回调一律不得触达 adapter */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const canWriteNow = useCallback(
    (targetRequestId: number | null): boolean => {
      if (!mountedRef.current) return false;
      if (writeBlocked) return false;
      return writeEligible === undefined || writeEligible(targetRequestId, sessionScopeKey);
    },
    [writeBlocked, writeEligible, sessionScopeKey],
  );
  const [stagedState, setStagedState] = useState<StagedFileState | null>(null);
  const [stagedDiscardNotice, setStagedDiscardNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [lastProcessResult, setLastProcessResult] = useState<RepairProcessWriteResult | null>(null);
  const [lastCloseResult, setLastCloseResult] = useState<CloseRepairRequestResult | null>(null);
  const [lastInterruptResult, setLastInterruptResult] =
    useState<InterruptRepairRequestResult | null>(null);
  const [processReadbackFailed, setProcessReadbackFailed] = useState(false);
  const [processReadbackRetrying, setProcessReadbackRetrying] = useState(false);
  const [closeReadbackFailed, setCloseReadbackFailed] = useState(false);
  const [closeReadbackRetrying, setCloseReadbackRetrying] = useState(false);
  const processRetryBusyRef = useRef(false);
  const closeRetryBusyRef = useRef(false);

  // 实例代次：工单 ID + 编辑对象（过程 ID / new）+ 每次打开编辑的递增代号。
  // 不能只按过程 ID 判断：A→B→A 与关闭后重开同一 A 的过程 ID 相同，但属于不同实例。
  const instanceRef = useRef<EditInstance>({
    requestId: requestId ?? -1,
    sessionScopeKey,
    scopeKey: 'new',
    generation: 0,
  });
  const stagedRef = useRef<StagedFileState | null>(null);
  const uploadBusyKeysRef = useRef(new Set<string>());
  const saveBusyKeysRef = useRef(new Set<string>());
  // 结单在首个 await 前同步认领令牌：同一归属第二次调用直接拒绝，
  // 且 finally 只允许令牌持有者释放该归属的忙状态。
  const closeBusyRef = useRef(new Map<string, symbol>());
  const submitSeqRef = useRef(0);
  const pendingSubmitsRef = useRef(
    new Map<
      string,
      { instance: EditInstance; file: StagedRepairProcessFile; submitGeneration: number }
    >(),
  );

  const setStaged = useCallback((next: StagedFileState | null) => {
    stagedRef.current = next;
    setStagedState(next);
  }, []);

  const matchesCurrent = useCallback((instance: EditInstance): boolean => {
    return mountedRef.current && sameInstance(instance, instanceRef.current);
  }, []);

  // 换工单或换会话时清空本实例的全部暂存/在飞状态。生产页面以组件 key 强制重挂载，
  // 这里额外兜底同一 hook 实例被复用的场景（旧工单/旧会话响应绝不能写入新页面）。
  // 用布局阶段同步实例归属：若在被动 effect 中更新，切换渲染后、effect 执行前的
  // 微任务仍可能按旧实例通过 matchesCurrent，把迟到结果写进新会话页面。
  useLayoutEffect(() => {
    if (
      instanceRef.current.requestId === (requestId ?? -1) &&
      instanceRef.current.sessionScopeKey === sessionScopeKey
    ) {
      return;
    }
    instanceRef.current = {
      requestId: requestId ?? -1,
      sessionScopeKey,
      scopeKey: 'new',
      generation: instanceRef.current.generation + 1,
    };
    stagedRef.current = null;
    setStagedState(null);
    setStagedDiscardNotice(null);
    setUploading(false);
    setSaving(false);
    setClosing(false);
    setLastProcessResult(null);
    setLastCloseResult(null);
    setLastInterruptResult(null);
    setProcessReadbackFailed(false);
    setProcessReadbackRetrying(false);
    setCloseReadbackFailed(false);
    setCloseReadbackRetrying(false);
    processRetryBusyRef.current = false;
    closeRetryBusyRef.current = false;
    // 旧归属的在途结单不再可能成为当前归属：清空令牌表，旧 finally 无法据此释放新锁
    closeBusyRef.current.clear();
  }, [requestId, sessionScopeKey]);

  const beginEditScope = useCallback(
    (scopeKey: string) => {
      const previous = instanceRef.current;
      const next: EditInstance = {
        requestId: requestId ?? -1,
        sessionScopeKey,
        scopeKey,
        generation: previous.generation + 1,
      };
      instanceRef.current = next;

      const previousStaged = stagedRef.current;
      if (previousStaged && !sameInstance(previousStaged.instance, next)) {
        // 只丢弃本地引用并明确提示：不删除服务端 TEMPORARY，也不声称已取消/回滚写入
        const pendingSubmit = pendingSubmitsRef.current.get(instanceKey(previousStaged.instance));
        setStaged(null);
        setStagedDiscardNotice(
          pendingSubmit && pendingSubmit.file.fileId === previousStaged.file.fileId
            ? STAGED_SUBMIT_PENDING_NOTICE
            : STAGED_DISCARD_NOTICE,
        );
      } else {
        setStagedDiscardNotice(null);
      }

      // 旧实例的在飞上传/保存不能阻塞新实例，也不能在结束时回写新实例的 loading
      setUploading(false);
      setSaving(false);
      setLastProcessResult(null);
    },
    [requestId, sessionScopeKey, setStaged],
  );

  const uploadFile = useCallback(
    async (file: File): Promise<UploadRepairProcessFileResult | null> => {
      if (!canWriteNow(requestId)) return null;
      const instance = instanceRef.current;
      if (requestId === null || requestId !== instance.requestId || !matchesCurrent(instance)) {
        return null;
      }
      const key = instanceKey(instance);
      if (uploadBusyKeysRef.current.has(key)) return null;

      uploadBusyKeysRef.current.add(key);
      setUploading(true);
      setLastProcessResult(null);
      setStagedDiscardNotice(null);
      try {
        const result = await uploadRepairProcessFile(file);
        if (!matchesCurrent(instance)) {
          return null;
        }
        if (!result.ok) {
          setStaged(null);
          return result;
        }
        setStaged({ file: result.file, instance });
        return result;
      } finally {
        uploadBusyKeysRef.current.delete(key);
        if (matchesCurrent(instance)) {
          setUploading(false);
        }
      }
    },
    [requestId, matchesCurrent, setStaged, canWriteNow],
  );

  const clearStagedFile = useCallback(() => {
    setStaged(null);
  }, [setStaged]);

  /**
   * 写后回读并返回服务端结果与采用事实：
   * - 沿用详情 hook 的 silent + mutation + shouldApply 归属规则，不新建请求排序；
   * - 返回 null 表示回读期间实例/工单已切换，调用方不得写任何反馈或状态；
   * - applied 只有在详情 hook 实际提交到共享详情时才为 true，请求 ok 不等于被采用；
   * - ok 仅表示回读请求本身成功，仍可能返回未结束、失效或被取代的详情。
   */
  const confirmReadback = useCallback(
    async (
      instance: EditInstance,
    ): Promise<{
      ok: boolean;
      applied: boolean;
      detail: EngineerRepairRequestDetail | null;
    } | null> => {
      const readback = { detail: null as EngineerRepairRequestDetail | null };
      const outcome = (await reload({
        silent: true,
        mutation: true,
        shouldApply: () => matchesCurrent(instance),
        onApplied: (detail) => {
          readback.detail = detail;
        },
      })) as EngineerRepairRequestDetailLoadOutcome | null | undefined;

      if (!matchesCurrent(instance)) {
        return null;
      }

      return {
        ok: outcome !== null && typeof outcome === 'object' && outcome.ok === true,
        applied: readback.detail !== null,
        detail: readback.detail,
      };
    },
    [reload, matchesCurrent],
  );

  /**
   * 结单回读确认：请求成功、结果实际被共享详情采用、且采用后的详情按项目
   * 现有结束状态规则确认为已结束，三者同时成立才允许服务端详情接管本地屏障。
   * 返回 null 表示实例/工单已切换，调用方不得写任何反馈或状态。
   */
  const confirmCloseReadback = useCallback(
    async (instance: EditInstance): Promise<boolean | null> => {
      const confirmation = await confirmReadback(instance);
      if (confirmation === null) {
        return null;
      }
      return (
        confirmation.ok &&
        confirmation.applied &&
        confirmation.detail !== null &&
        isEngineerRepairRequestEnded(confirmation.detail)
      );
    },
    [confirmReadback],
  );

  const retryProcessReadback = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (
      requestId === null ||
      requestId !== instance.requestId ||
      !matchesCurrent(instance) ||
      processRetryBusyRef.current
    ) {
      return;
    }

    processRetryBusyRef.current = true;
    setProcessReadbackRetrying(true);
    try {
      const confirmed = await confirmReadback(instance);
      if (confirmed !== null) {
        setProcessReadbackFailed(!confirmed.ok);
      }
    } finally {
      processRetryBusyRef.current = false;
      if (matchesCurrent(instance)) {
        setProcessReadbackRetrying(false);
      }
    }
  }, [requestId, confirmReadback, matchesCurrent]);

  const retryCloseReadback = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (
      requestId === null ||
      requestId !== instance.requestId ||
      !matchesCurrent(instance) ||
      closeRetryBusyRef.current
    ) {
      return;
    }

    closeRetryBusyRef.current = true;
    setCloseReadbackRetrying(true);
    try {
      const confirmed = await confirmCloseReadback(instance);
      if (confirmed !== null) {
        setCloseReadbackFailed(!confirmed);
        if (confirmed) {
          onCloseReadbackSucceeded?.();
        }
      }
    } finally {
      closeRetryBusyRef.current = false;
      if (matchesCurrent(instance)) {
        setCloseReadbackRetrying(false);
      }
    }
  }, [requestId, confirmCloseReadback, matchesCurrent, onCloseReadbackSucceeded]);

  const saveProcess = useCallback(
    async (
      input: RepairProcessFormInput,
      editingEntry: EngineerRepairProcessEntry | null,
    ): Promise<RepairProcessWriteResult | null> => {
      if (!canWriteNow(requestId)) return null;
      const instance = instanceRef.current;
      if (requestId === null || requestId !== instance.requestId || !matchesCurrent(instance)) {
        return null;
      }
      const key = instanceKey(instance);
      if (saveBusyKeysRef.current.has(key)) return null;

      saveBusyKeysRef.current.add(key);
      setSaving(true);
      setLastProcessResult(null);
      setProcessReadbackFailed(false);
      setStagedDiscardNotice(null);

      // 只允许携带与当前编辑实例匹配的暂存文件：
      // 旧实例的暂存即使尚未被清理，也绝不附到当前过程
      const stagedAtStart = stagedRef.current;
      const attachableFile =
        (editingEntry === null || editingEntry.fileId === null) &&
        stagedAtStart !== null &&
        sameInstance(stagedAtStart.instance, instance)
          ? stagedAtStart.file
          : null;
      const consumedStagedFile = attachableFile !== null;
      // 提交代次：用于切换时区分“未提交的暂存”和“已提交、结果待确认的暂存”
      const submitGeneration = consumedStagedFile ? ++submitSeqRef.current : null;
      if (attachableFile && submitGeneration !== null) {
        pendingSubmitsRef.current.set(key, {
          instance,
          file: attachableFile,
          submitGeneration,
        });
      }

      try {
        const result = editingEntry
          ? await updateRepairProcessEntry({
              requestId,
              entryId: editingEntry.id,
              expectedVersion: editingEntry.versionNo,
              operationText: input.operationText,
              testResult: input.testResult,
              occurredAt: input.occurredAt,
              file: attachableFile
                ? {
                    fileId: attachableFile.fileId,
                    uploadContextId: attachableFile.uploadContextId,
                  }
                : null,
            })
          : await createRepairProcessEntry({
              requestId,
              operationText: input.operationText,
              testResult: input.testResult,
              occurredAt: input.occurredAt,
              file: attachableFile
                ? {
                    fileId: attachableFile.fileId,
                    uploadContextId: attachableFile.uploadContextId,
                  }
                : null,
            });

        // 旧实例的迟到响应只允许结束自己的在飞标记，不得改当前实例的结果/回读/暂存
        if (!matchesCurrent(instance)) {
          return null;
        }

        setLastProcessResult(result);
        if (result.ok) {
          if (consumedStagedFile) {
            setStaged(null);
          }
          // 保存成功后只走正式详情读接口回读（不把 Mutation 返回值当最终绑定事实）。
          // 回读失败不回滚保存成功事实，也不清空既有详情；仅标记刷新失败供 UI 如实提示。
          const confirmed = await confirmReadback(instance);
          if (confirmed === null) {
            return null;
          }
          setProcessReadbackFailed(!confirmed.ok);
        }
        return result;
      } finally {
        saveBusyKeysRef.current.delete(key);
        const pending = pendingSubmitsRef.current.get(key);
        if (pending && pending.submitGeneration === submitGeneration) {
          pendingSubmitsRef.current.delete(key);
        }
        if (matchesCurrent(instance)) {
          setSaving(false);
        }
      }
    },
    [requestId, matchesCurrent, confirmReadback, setStaged, canWriteNow],
  );

  const closeRequest = useCallback(
    async (
      handlingResult: RepairRequestHandlingResult,
      closureReason: string | null,
    ): Promise<CloseRepairRequestResult | null> => {
      if (!canWriteNow(requestId)) return null;
      const instance = instanceRef.current;
      if (requestId === null || requestId !== instance.requestId || !matchesCurrent(instance)) {
        return null;
      }

      // 归属资格只回答「能不能结单」，不回答「本归属是否已有结单在途」。
      // closing 是渲染态，不能充当同步锁；必须在首个 await 前认领唯一令牌。
      const key = instanceKey(instance);
      if (closeBusyRef.current.has(key)) {
        return null;
      }
      const token = Symbol('close');
      closeBusyRef.current.set(key, token);

      setClosing(true);
      setLastCloseResult(null);
      setCloseReadbackFailed(false);
      try {
        const result = await closeRepairRequest({ requestId, handlingResult, closureReason });
        if (!matchesCurrent(instance)) {
          return null;
        }

        setLastCloseResult(result);
        if (result.ok) {
          // mutation 明确成功：同步建立页面只读屏障，再发起详情回读。
          // 回读失败、未结束、失效或被取代都不撤销屏障，只提示详情尚未确认。
          onCloseSucceeded?.();
          setStaged(null);
          const confirmed = await confirmCloseReadback(instance);
          if (confirmed === null) {
            return null;
          }
          setCloseReadbackFailed(!confirmed);
          if (confirmed) {
            onCloseReadbackSucceeded?.();
          }
        }
        return result;
      } finally {
        // 只允许令牌持有者释放自己的归属：旧请求完成不得清掉新实例/新会话的锁
        if (closeBusyRef.current.get(key) === token) {
          closeBusyRef.current.delete(key);
          if (matchesCurrent(instance)) {
            setClosing(false);
          }
        }
      }
    },
    [
      requestId,
      matchesCurrent,
      confirmCloseReadback,
      setStaged,
      canWriteNow,
      onCloseSucceeded,
      onCloseReadbackSucceeded,
    ],
  );

  /**
   * 记录维修中断：与结单互斥占用同一在途锁，但不建立只读屏障。
   * 成功后仅回读详情，接单人仍可继续保存维修记录和回复。
   */
  const interruptRequest = useCallback(
    async (reason: string): Promise<InterruptRepairRequestResult | null> => {
      if (!canWriteNow(requestId)) return null;
      const instance = instanceRef.current;
      if (requestId === null || requestId !== instance.requestId || !matchesCurrent(instance)) {
        return null;
      }

      const key = instanceKey(instance);
      if (closeBusyRef.current.has(key)) {
        return null;
      }
      const token = Symbol('interrupt');
      closeBusyRef.current.set(key, token);

      setClosing(true);
      setLastInterruptResult(null);
      try {
        const result = await interruptRepairRequest({ requestId, reason });
        if (!matchesCurrent(instance)) {
          return null;
        }
        setLastInterruptResult(result);
        if (result.ok) {
          // 中断不结单：只回读服务端事实，不通知页面建立只读屏障。
          await confirmReadback(instance);
        }
        return result;
      } finally {
        if (closeBusyRef.current.get(key) === token) {
          closeBusyRef.current.delete(key);
          if (matchesCurrent(instance)) {
            setClosing(false);
          }
        }
      }
    },
    [requestId, matchesCurrent, confirmReadback, canWriteNow],
  );

  const downloadFile = useCallback(
    (fileId: string): Promise<DownloadRepairProcessFileResult> => downloadRepairProcessFile(fileId),
    [],
  );

  const currentStaged = stagedState?.file ?? null;

  return {
    stagedFile: currentStaged,
    stagedDiscardNotice,
    uploading,
    saving,
    closing,
    lastProcessResult,
    lastCloseResult,
    lastInterruptResult,
    processReadbackFailed,
    processReadbackRetrying,
    closeReadbackFailed,
    closeReadbackRetrying,
    uploadFile,
    clearStagedFile,
    beginEditScope,
    saveProcess,
    closeRequest,
    interruptRequest,
    retryProcessReadback,
    retryCloseReadback,
    downloadFile,
  };
}
