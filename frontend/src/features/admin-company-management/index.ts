// src/features/admin-company-management/index.ts

/**
 * 公司档案管理 feature 的公开 API。
 * 跨模块导入只允许走本文件；application / infrastructure 内部实现不对外暴露，
 * pages 不深层 import。
 */

export { AdminCompanyManagementPanel } from './ui/admin-company-management-panel';
