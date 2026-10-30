// src/modules/lithography/engineer-registration.types.ts
// 工程师自助注册申请域写模型与读模型（模块层内部契约，不含 GraphQL 装饰器）。

import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';

/**
 * 申请写入数据。
 *
 * 只承载已完成业务判定的写入事实：账号与目标组织必须由 usecase 在同一事务内
 * 先创建/解析并核验后传入；本层不推断归属、不裁决审批权限。
 */
export type EngineerRegistrationApplicationInsertData = {
  /** 待审工程师账号主键（同事务内创建，双状态应为 PENDING/PENDING） */
  accountId: number;
  /** 本次申请的目标组织主键（不是已生效成员关系） */
  organizationId: number;
  /** 申请说明；未填写为 null（去空白由 usecase 输入规范化负责） */
  applicationNote: string | null;
  /** 提交事件时间（服务器时间） */
  submittedAt: Date;
};

/** 申请记录安全视图（不含凭据、角色摘要或其他账号资料） */
export type EngineerRegistrationApplicationSnapshot = {
  id: number;
  accountId: number;
  organizationId: number;
  status: EngineerRegistrationApplicationStatus;
  applicationNote: string | null;
  submittedAt: Date;
  /** 待审为空；终态关联审核管理员账号 */
  reviewedByAccountId: number | null;
  reviewedAt: Date | null;
  /** 拒绝时非空白；通过时可空 */
  reviewComment: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 本人申请历史分页参数（页码从 1 开始） */
export type EngineerRegistrationListPagination = {
  page: number;
  pageSize: number;
};

/** 本人申请历史分页结果（按提交时间倒序） */
export type EngineerRegistrationListPage = {
  items: EngineerRegistrationApplicationSnapshot[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 一次终态审核决策的写入数据。
 *
 * `applicationId` 指申请记录，`reviewedByAccountId` 是审核事务内由可信会话解析出的管理员；
 * 只写入终态字段，不覆盖历史记录，也不创建新的申请行。
 */
export type EngineerRegistrationDecisionUpdateData = {
  applicationId: number;
  status:
    EngineerRegistrationApplicationStatus.APPROVED | EngineerRegistrationApplicationStatus.REJECTED;
  reviewedByAccountId: number;
  reviewedAt: Date;
  /** 拒绝必填非空白；通过时可空 */
  reviewComment: string | null;
};

/** 组织审核队列查询（organizationId 必须来自可信组织解析） */
export type EngineerRegistrationOrganizationQueueQuery = {
  organizationId: number;
  /** 不传表示不按状态筛选 */
  status?: EngineerRegistrationApplicationStatus;
  pagination: EngineerRegistrationListPagination;
};
