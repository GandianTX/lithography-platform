// src/features/reference-document/application/use-reference-document-actions.ts

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { saveBlobAsFile } from '@/shared/download';
import type { NotifyFeedback } from '@/shared/feedback';

import type {
  DeleteReferenceDocumentResult,
  UpdateReferenceDocumentPatch,
  UpdateReferenceDocumentResult,
} from '../infrastructure/reference-document.types';
import {
  deleteReferenceDocument,
  updateReferenceDocument,
} from '../infrastructure/reference-document-adapter';
import { downloadReferenceDocumentFile } from '../infrastructure/reference-document-http-adapter';

/**
 * 参考资料详情写路径编排（编辑 / 软删 / 下载，收束在 feature application）。
 *
 * 从详情面板（ui）搬出的原因：面板原先同时持有 use case 编排（update / delete / download /
 * reload / 操作代次 / 在途锁）与展示，`ui` 不应吞掉业务编排（stable-clean architecture §5）。
 * 搬出后 `ui` 只剩「渲染 + 把编排结果转成提示与导航」。
 *
 * 行为口径（与搬出前逐字一致）：
 * - 操作目标守卫：update / delete / download 在 `await` 之后先核对「发起时的操作代次是否仍是
 *   当前代次」，代次不一致（documentId 在途中变更、或组件已卸载）时整体丢弃结果（不提示、
 *   不刷新、不跳转、不触发保存）。否则旧目标的结果会把旧资料 reload 回新路由，形成
 *   「界面显示 B、内容却是 A」，用户随后保存会把 A 的字段写入 B（数据完整性风险）；
 *   卸载后不失效则旧删除成功会把已进入其他页面的用户强制带回资料列表，旧下载也会在错误
 *   上下文触发文件保存。
 * - 代次由 `useLayoutEffect` 在 commit 内同步推进、并在 cleanup（含卸载）中作废本代次
 *   （本仓同口径见 admin-user-management 的 use-stale-submit-guard）：`react-hooks/refs`
 *   禁止 render 期间读写 ref，且 render 可能被并发特性重放而自增不幂等；用 passive effect
 *   则会留出「已提交但未推进」的窗口。
 * - id 变化时退出旧资料的编辑态（渲染期按 props 调整 state 的官方范式）：新资料加载完成后
 *   不得继续显示由旧资料开启的编辑界面，避免「看到 A 的表单、提交到 B」。
 * - 在途锁按代次记录而非布尔：代次随 documentId 推进，目标切换后旧目标的锁不阻塞新目标，
 *   同一代次内重复发起才需要拦；finally 只释放归属自身代次的锁，不误放新目标的锁。
 * - remove 返回 boolean：true 表示「删除成功且目标仍有效」，调用方（页面 / 面板）据此导航；
 *   失败给明确原因并回刷数据态，不做乐观成功（backend e2e 口径：重复软删统一 NOT_FOUND）。
 * - 反馈经注入的窄 port（NotifyFeedback）上报，由 ui 层决定呈现方式——本层不得依赖
 *   具体 UI 组件实现（docs/stable-clean/architecture.md 最小落地规则第 6 条）。
 */

/** 编辑提交输入：与表单输出同形（不含创建专属的 file 字段），避免 application 依赖 ui 类型 */
export type ReferenceDocumentEditInput = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string | null;
};

/** 编辑提交结果：与表单 onSubmit 的返回同形（结构一致，可直接接到表单 onSubmit 上） */
export type ReferenceDocumentEditSubmitResult = { ok: true } | { ok: false; message: string };

export function useReferenceDocumentActions(params: {
  documentId: number | null;
  notify: NotifyFeedback;
  reload: () => void;
}) {
  const { documentId, notify, reload } = params;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const deletingSeqRef = useRef<number | null>(null);
  const downloadingSeqRef = useRef<number | null>(null);

  // 编辑会话目标：与 documentId 绑定，用于识别「目标已切换」
  const [editingSessionId, setEditingSessionId] = useState(documentId);

  // 操作代次：在途操作在 await 之后用它核对「发起时的目标是否仍是当前目标」。
  const operationSeqRef = useRef(0);

  useLayoutEffect(() => {
    operationSeqRef.current += 1;

    const seq = operationSeqRef.current;

    // cleanup（含卸载）时使本代次失效：用户离开详情页后，仍在途的旧操作只能静默收尾，
    // 不得再提示 / navigate / reload / 触发浏览器保存。条件递增保证只作废自己那一代：
    // 新代次已推进时不动它，StrictMode 的 setup → cleanup → setup 重放只会留下更高代次，
    // 首次可交互状态读取的是新代次，不会被误判失效。
    return () => {
      if (operationSeqRef.current === seq) {
        operationSeqRef.current += 1;
      }
    };
  }, [documentId]);

  // 目标已切换：退出旧目标的编辑态与 pending 按钮态（在途锁按代次记录，
  // 旧代次的锁本就不会命中新代次，无需在此改写）
  if (editingSessionId !== documentId) {
    setEditingSessionId(documentId);
    setEditing(false);
    setDeleting(false);
    setDownloading(false);
  }

  const submitUpdate = useCallback(
    async (output: ReferenceDocumentEditInput): Promise<ReferenceDocumentEditSubmitResult> => {
      const targetId = documentId;
      const operationSeq = operationSeqRef.current;

      if (targetId === null) {
        return { ok: false, message: '参考资料不存在或不可编辑。' };
      }

      const patch: UpdateReferenceDocumentPatch = {
        title: output.title,
        documentType: output.documentType,
        equipmentModelId: output.equipmentModelId,
        description: output.description,
        // 空白正文传空字符串：后端编辑路径归一为 null，仅当资料已有文件时放行
        // （双空拦截已由表单预检承担，此处不做二次判定）
        contentText: output.contentText ?? '',
      };
      const result: UpdateReferenceDocumentResult = await updateReferenceDocument(targetId, patch);

      // 操作目标守卫：await 期间路由已切到其他资料（代次已推进）时，旧目标结果不得提示成功、
      // 不得退出编辑态、不得 reload（reload 会把旧资料加载进新路由，用户随后保存即把 A 的
      // 字段写入 B）。旧编辑表单已随 id 变化卸载，此处如实回传结果即可。
      if (operationSeqRef.current !== operationSeq) {
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      }

      if (result.ok) {
        notify({ type: 'success', text: '参考资料已保存。' });
        setEditing(false);
        reload();

        return { ok: true };
      }

      return { ok: false, message: result.message };
    },
    [documentId, notify, reload],
  );

  /** 软删当前资料。返回 true 表示删除成功且目标仍有效，调用方应导航回列表。 */
  const remove = useCallback(async (): Promise<boolean> => {
    const targetId = documentId;
    const operationSeq = operationSeqRef.current;

    if (targetId === null || deletingSeqRef.current === operationSeq) {
      return false;
    }

    deletingSeqRef.current = operationSeq;
    setDeleting(true);

    try {
      const result: DeleteReferenceDocumentResult = await deleteReferenceDocument(targetId);

      // 操作目标守卫：目标已切换时丢弃旧目标结果，不得跳转 / 刷新 / 改写新目标状态
      if (operationSeqRef.current !== operationSeq) {
        return false;
      }

      if (result.ok) {
        notify({ type: 'success', text: '参考资料已删除。' });

        return true;
      }

      // 失败给明确原因并刷新数据态，不做乐观成功
      notify({ type: 'error', text: result.message });
      reload();

      return false;
    } catch {
      if (operationSeqRef.current !== operationSeq) {
        return false;
      }

      notify({ type: 'error', text: '参考资料删除失败，请稍后重试。' });
      reload();

      return false;
    } finally {
      // 仅在锁仍归属本次代次时释放；新代次可能已持有自己的锁（否则会误放新目标的在途锁）
      if (deletingSeqRef.current === operationSeq) {
        deletingSeqRef.current = null;
        setDeleting(false);
      }
    }
  }, [documentId, notify, reload]);

  /** 下载资料文件：REST 取 blob → 经浏览器保存适配落地 */
  const download = useCallback(async (): Promise<void> => {
    const targetId = documentId;
    const operationSeq = operationSeqRef.current;

    if (targetId === null || downloadingSeqRef.current === operationSeq) {
      return;
    }

    downloadingSeqRef.current = operationSeq;
    setDownloading(true);

    try {
      const result = await downloadReferenceDocumentFile(targetId);

      // 操作目标守卫：目标已切换时不得提示、也不得触发保存，
      // 否则会把 A 的文件存到 B 的界面之下
      if (operationSeqRef.current !== operationSeq) {
        return;
      }

      if (!result.ok) {
        notify({ type: 'error', text: result.message });

        return;
      }

      saveBlobAsFile(result.blob, result.filename);
    } catch {
      if (operationSeqRef.current !== operationSeq) {
        return;
      }

      notify({ type: 'error', text: '下载失败，请稍后重试。' });
    } finally {
      // 仅在锁仍归属本次代次时释放；新代次可能已持有自己的锁（否则会误放新目标的在途锁）
      if (downloadingSeqRef.current === operationSeq) {
        downloadingSeqRef.current = null;
        setDownloading(false);
      }
    }
  }, [documentId, notify]);

  const openEditing = useCallback(() => setEditing(true), []);
  const cancelEditing = useCallback(() => setEditing(false), []);

  return {
    cancelEditing,
    deleting,
    download,
    downloading,
    editing,
    openEditing,
    remove,
    submitUpdate,
  };
}
