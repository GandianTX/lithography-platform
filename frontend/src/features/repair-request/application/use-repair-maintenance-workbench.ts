// src/features/repair-request/application/use-repair-maintenance-workbench.ts

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  RepairMaintenanceFaultPanelInput,
  RepairMaintenanceStepInput,
  RepairMaintenanceWriteResult,
  StagedRepairProcessFile,
  UploadRepairProcessFileResult,
} from '../infrastructure/engineer-repair-request.types';
import {
  saveRepairRequestMaintenance,
  uploadRepairProcessFile,
} from '../infrastructure/engineer-repair-request-adapter';

export type RepairMaintenanceFormInput = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: RepairMaintenanceStepInput[];
  panels: RepairMaintenanceFaultPanelInput[];
};

type MaintenanceReload = (options?: {
  shouldApply?: () => boolean;
  silent?: boolean;
  mutation?: boolean;
  onApplied?: (detail: unknown) => void;
}) => Promise<unknown>;

export type RepairMaintenanceWorkbenchOptions = {
  /** 本地只读屏障：结单已成功但详情尚未由服务端事实接管时拒绝写入 */
  writeBlocked?: boolean;
  /** 当前登录会话/账号作用域 */
  scopeKey?: string;
  /** 调用 adapter 前的统一写入资格判定（与回复/过程写入口一致） */
  writeEligible?: (requestId: number | null, scopeKey: string) => boolean;
};

/**
 * 结构化内部维修记录编排（任务 04）。
 *
 * - 上传只产生「已上传暂存」状态；保存维修记录成功后才成为「已保存绑定」；
 * - 保存携带 expectedVersion，冲突只提示刷新，不自动重试；
 * - 保存成功后清空暂存引用并静默回读详情（仍可继续编辑）；
 * - 回读失败单独标记，可手动重试，不把已成功的保存伪报为失败；
 * - 切换工单/会话后，旧的在途上传/保存结果不写入新页面；
 * - 暂存文件与服务端暂存一致：本地移除不删除服务端文件。
 */
export function useRepairMaintenanceWorkbench(
  requestId: number | null,
  reload: MaintenanceReload,
  options: RepairMaintenanceWorkbenchOptions = {},
) {
  const { writeBlocked = false, scopeKey = 'default', writeEligible } = options;

  const [stagedFile, setStagedFile] = useState<StagedRepairProcessFile | null>(null);
  const stagedFileRef = useRef<StagedRepairProcessFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [lastResult, setLastResult] = useState<RepairMaintenanceWriteResult | null>(null);
  const [readbackFailed, setReadbackFailed] = useState(false);
  const [retryingReadback, setRetryingReadback] = useState(false);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(requestId);
  const scopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    stagedFileRef.current = stagedFile;
  }, [stagedFile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const identityRef = useRef(`${String(requestId)}:${scopeKey}`);
  useLayoutEffect(() => {
    requestIdRef.current = requestId;
    scopeKeyRef.current = scopeKey;
    const identity = `${String(requestId)}:${scopeKey}`;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      stagedFileRef.current = null;
      uploadingRef.current = false;
      savingRef.current = false;
      setStagedFile(null);
      setUploading(false);
      setUploadError(null);
      setSaving(false);
      setLastResult(null);
      setReadbackFailed(false);
    }
  }, [requestId, scopeKey]);

  const isCurrentInstance = useCallback(
    (targetRequestId: number): boolean =>
      mountedRef.current &&
      requestIdRef.current === targetRequestId &&
      scopeKeyRef.current === scopeKey,
    [scopeKey],
  );

  const canWriteNow = useCallback(
    (targetRequestId: number | null): boolean => {
      if (!mountedRef.current || targetRequestId === null) return false;
      if (writeBlocked) return false;
      return writeEligible === undefined || writeEligible(targetRequestId, scopeKey);
    },
    [scopeKey, writeBlocked, writeEligible],
  );

  const clearStagedAttachment = useCallback(() => {
    if (uploadingRef.current || savingRef.current) return;
    stagedFileRef.current = null;
    setStagedFile(null);
    setUploadError(null);
  }, []);

  /** 上传维修原件（REPAIR_PROCESS 用途，暂存态）；已有暂存时拒绝重复上传 */
  const uploadAttachment = useCallback(
    async (file: File): Promise<UploadRepairProcessFileResult | null> => {
      const requestIdAtStart = requestId;
      if (
        requestIdAtStart === null ||
        !canWriteNow(requestIdAtStart) ||
        uploadingRef.current ||
        savingRef.current ||
        stagedFileRef.current !== null
      ) {
        return null;
      }
      uploadingRef.current = true;
      setUploading(true);
      setUploadError(null);

      let result: UploadRepairProcessFileResult;
      try {
        result = await uploadRepairProcessFile(file);
      } catch (error) {
        uploadingRef.current = false;
        if (isCurrentInstance(requestIdAtStart)) {
          setUploading(false);
          setUploadError(error instanceof Error ? error.message : null);
        }
        throw error;
      }

      uploadingRef.current = false;
      if (!isCurrentInstance(requestIdAtStart)) {
        return result;
      }
      setUploading(false);
      if (result.ok) {
        stagedFileRef.current = result.file;
        setStagedFile(result.file);
      } else {
        setUploadError(result.message);
      }
      return result;
    },
    [canWriteNow, isCurrentInstance, requestId],
  );

  const clearFeedback = useCallback(() => {
    setLastResult(null);
    setReadbackFailed(false);
    setUploadError(null);
  }, []);

  const readback = useCallback(
    async (targetRequestId: number): Promise<boolean> => {
      let applied = false;
      try {
        await reload({
          silent: true,
          mutation: true,
          shouldApply: () =>
            isCurrentInstance(targetRequestId) && requestIdRef.current === targetRequestId,
          onApplied: () => {
            applied = true;
          },
        });
        return applied;
      } catch {
        return false;
      }
    },
    [isCurrentInstance, reload],
  );

  /**
   * 保存维修记录并回读详情。
   * 返回 null 表示未发起（无写入资格、正在上传/保存或工单已切换）。
   */
  const saveMaintenance = useCallback(
    async (
      input: RepairMaintenanceFormInput,
      expectedVersion: number,
    ): Promise<RepairMaintenanceWriteResult | null> => {
      const requestIdAtStart = requestId;
      if (
        requestIdAtStart === null ||
        !canWriteNow(requestIdAtStart) ||
        savingRef.current ||
        uploadingRef.current
      ) {
        return null;
      }
      savingRef.current = true;
      setSaving(true);
      setLastResult(null);
      setReadbackFailed(false);

      let result: RepairMaintenanceWriteResult;
      try {
        const staged = stagedFileRef.current;
        result = await saveRepairRequestMaintenance({
          requestId: requestIdAtStart,
          expectedVersion,
          maintenanceDate: input.maintenanceDate,
          engineerName: input.engineerName,
          resetResult: input.resetResult,
          supplementaryNote: input.supplementaryNote,
          attachment: staged
            ? { fileId: staged.fileId, uploadContextId: staged.uploadContextId }
            : null,
          steps: input.steps,
          panels: input.panels,
        });
      } catch (error) {
        savingRef.current = false;
        if (isCurrentInstance(requestIdAtStart)) {
          setSaving(false);
        }
        throw error;
      }

      if (isCurrentInstance(requestIdAtStart)) {
        setLastResult(result);
        if (result.ok) {
          // 只有保存成功才清空暂存；失败保留暂存引用，便于用户重试
          stagedFileRef.current = null;
          setStagedFile(null);
          const applied = await readback(requestIdAtStart);
          if (isCurrentInstance(requestIdAtStart)) {
            setReadbackFailed(!applied);
          }
        }
        setSaving(false);
      }
      savingRef.current = false;
      return result;
    },
    [canWriteNow, isCurrentInstance, readback, requestId],
  );

  const retryReadback = useCallback(async () => {
    const requestIdAtStart = requestId;
    if (requestIdAtStart === null || retryingReadback) {
      return;
    }
    setRetryingReadback(true);
    setReadbackFailed(false);
    const applied = await readback(requestIdAtStart);
    if (isCurrentInstance(requestIdAtStart)) {
      setRetryingReadback(false);
      setReadbackFailed(!applied);
    }
  }, [isCurrentInstance, readback, requestId, retryingReadback]);

  return {
    stagedFile,
    uploading,
    uploadError,
    saving,
    lastResult,
    readbackFailed,
    retryingReadback,
    uploadAttachment,
    clearStagedAttachment,
    saveMaintenance,
    retryReadback,
    clearFeedback,
  };
}
