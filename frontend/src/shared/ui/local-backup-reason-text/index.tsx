// src/shared/ui/local-backup-reason-text/index.tsx

import { useI18n } from '@/shared/i18n';
import { resolveLocalBackupReasonKey } from '@/shared/i18n/local-backup-reason';

/**
 * 受控原因码文案（本地备份／恢复域）。
 *
 * 后端对外只给**受控原因码**（`LOCAL_*` 与清理授权层的 `CLOUD_*`），
 * 原始异常与本机绝对路径只进服务端日志。界面按码映射文案：
 * 已知码给受控文案，未知码给通用兜底——不把后端自由文本原样渲染。
 */
export function LocalBackupReasonText({ reason }: { reason: string | null | undefined }) {
  const { t } = useI18n();
  const key = resolveLocalBackupReasonKey(reason);

  if (key === null) {
    return <>{reason ? t('local-backup.error.unknownReason') : t('local-backup.value.dash')}</>;
  }
  return <>{t(key)}</>;
}
