// src/usecases/ai-conversation/ai-conversation-export-authorization.contract.ts

/**
 * 受控原始 JSON 导出的技术授权凭据（任务 05 · S4.2 · R040-01）。
 *
 * 原始 JSON 属受控技术操作：普通页面不提供入口，且必须携带与运行时配置一致的
 * 授权凭据。凭据由部署环境通过配置注入（infrastructure 读取 ConfigService），
 * 业务层不直接读取进程环境变量；未配置或为空时一律拒绝导出。
 */
export const AI_RAW_JSON_EXPORT_AUTHORIZATION = Symbol('AI_RAW_JSON_EXPORT_AUTHORIZATION');
