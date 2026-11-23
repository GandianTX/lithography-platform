// src/infrastructure/cloud/business-sync.config.ts

/**
 * 业务同步接收端（云端业务同步入口）的**服务端配置**（任务 09 新计划第 12 项）。
 *
 * 纪律（与云备份配置同一条）：
 * - **不硬编码地址与凭据**：全部来自环境变量（见 `config.module.ts` 的 `localRuntimeConfig`）；
 * - 缺地址或缺凭据 ⇒ **不注册** `BUSINESS_SYNC_RECEIVER` 端口 ⇒ 派发链按
 *   "生产接收端缺失"把任务留在**待传**状态（可续传），**不伪造成功**；
 * - 凭据只注入到 HTTP 客户端，**不进日志、不进错误信息**；
 * - 用途固定为 `BUSINESS_SYNC`：**业务同步凭据不得与云备份凭据混用**
 *   （见 `local-credential-purpose.policy`）。
 */
export type BusinessSyncCloudConfig = {
  /** 云端业务同步入口根地址；未配置为 null */
  baseUrl: string | null;
  /** 本机业务同步凭据（账号 × 公司 × 用途）；未配置为 null */
  credential: string | null;
  /** 请求超时（毫秒） */
  timeoutMs: number;
};

export const BUSINESS_SYNC_CLOUD_CONFIG = Symbol('BUSINESS_SYNC_CLOUD_CONFIG');
