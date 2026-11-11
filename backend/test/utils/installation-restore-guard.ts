/**
 * 安装设置恢复判定：只允许把「本轮写入值」或「原始值」写回原值。
 * 任一业务字段出现第三方组合时放弃写回，避免覆盖异主修改。
 */
export interface InstallationRowValues {
  readonly local_site_name: string | null;
  readonly auto_upload_enabled: boolean | number;
  readonly backup_interval_days: number | string;
  readonly updated_at: Date | string;
}

export type InstallationRestoreDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export const planInstallationRestore = (
  origin: InstallationRowValues,
  current: InstallationRowValues,
  runSiteName: string,
  runInterval: number,
): InstallationRestoreDecision => {
  const siteNameAllowed =
    current.local_site_name === origin.local_site_name || current.local_site_name === runSiteName;
  const intervalAllowed =
    Number(current.backup_interval_days) === Number(origin.backup_interval_days) ||
    Number(current.backup_interval_days) === runInterval;
  const uploadAllowed =
    Boolean(current.auto_upload_enabled) === Boolean(origin.auto_upload_enabled);
  if (!siteNameAllowed || !intervalAllowed || !uploadAllowed) {
    return { allowed: false, reason: '安装设置已被本轮之外的操作修改，拒绝写回' };
  }
  return { allowed: true };
};

export const matchesOriginalInstallation = (
  origin: InstallationRowValues,
  restored: InstallationRowValues,
): boolean =>
  restored.local_site_name === origin.local_site_name &&
  Boolean(restored.auto_upload_enabled) === Boolean(origin.auto_upload_enabled) &&
  Number(restored.backup_interval_days) === Number(origin.backup_interval_days) &&
  new Date(restored.updated_at).getTime() === new Date(origin.updated_at).getTime();
