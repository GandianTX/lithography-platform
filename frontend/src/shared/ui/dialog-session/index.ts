// src/shared/ui/dialog-session/index.ts

/**
 * 弹窗会话守卫的公开出口：宿主侧会话代次 + 弹窗侧提交代次。
 * 两层互不代替，详见各自实现文件头部说明。
 */

export { type DialogSessionSeqGuard, useDialogSessionSeq } from './use-dialog-session-seq';
export {
  type StaleSubmitGuard,
  type StaleSubmitGuardTargetKey,
  useStaleSubmitGuard,
} from './use-stale-submit-guard';
