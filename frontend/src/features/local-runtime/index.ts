// src/features/local-runtime/index.ts

/**
 * 本地运行数据 feature 公开出口（任务 09 S1）。
 *
 * 页面只消费这里导出的 UI 与视图类型，不直接引用 infrastructure/application 内部文件。
 */
export type {
  LocalRuntimeAuthorizationSummary,
  LocalRuntimeCompanySetting,
  LocalRuntimeStatus,
  LocalRuntimeStorageStatus,
  LocalRuntimeTaskStatus,
  LocalRuntimeViewerRole,
} from './infrastructure/local-runtime.types';
export { LocalRuntimeSettingsPanel } from './ui/local-runtime-settings-panel';
