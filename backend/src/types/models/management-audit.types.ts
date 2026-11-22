// src/types/models/management-audit.types.ts
// 关键操作记录共享稳定枚举（任务 10）：
// 放共享类型层供 GraphQL adapter 注册正式枚举；Module / Core / DTO 共用，不复制第二套，
// adapter 层不得运行时依赖 modules 实现（docs/api/adapters.rules.md「GraphQL Schema 组织」）。

/**
 * 三类业务事实的 operation 取值（任务书 R089 固定三类）。
 *
 * 刻意只含业务事实：凭据补发／重置两类留在审计表内部（旧调用方契约），
 * 不进入 GraphQL 枚举，协议层即无法表达本页不该展示的操作。
 */
export enum ManagementAuditBusinessOperation {
  /** 管理员删除正式资料（含管理员即原作者的情形） */
  ADMIN_DELETE_DOCUMENT = 'ADMIN_DELETE_DOCUMENT',
  /** 更改资料上传者与公司归属 */
  CORRECT_DOCUMENT_OWNERSHIP = 'CORRECT_DOCUMENT_OWNERSHIP',
  /** 使用备份包恢复本机业务 */
  RESTORE_LOCAL_BUSINESS = 'RESTORE_LOCAL_BUSINESS',
}

/** 结果三值：与 chk_management_audit_result 一致。 */
export enum ManagementAuditResult {
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  DENIED = 'DENIED',
}
