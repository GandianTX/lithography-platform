// src/usecases/registration/engineer-registration.types.ts
// 工程师自助注册（本人查询 / 重提）与组织审核相关执行契约。
// 仅服务对应 usecase 与其调用 adapter；稳定读模型复用模块层快照类型。

import type { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type {
  EngineerRegistrationApplicationSnapshot,
  EngineerRegistrationListPage,
} from '@src/modules/lithography/engineer-registration.types';

/** 本人申请状态查询命令 */
export type GetEngineerRegistrationStatusCommand = {
  /** 登录名或登录邮箱（凭据证明输入） */
  accountIdentifier: string;
  /** 原始密码（服务端不 trim） */
  password: string;
  /** OFFSET 分页；本人申请历史按提交时间倒序 */
  pagination: PaginationParams;
};

/** 本人申请状态查询结果：最新一份申请 + 分页历史 */
export type EngineerRegistrationStatusResult = {
  accountId: number;
  latest: EngineerRegistrationApplicationSnapshot | null;
  applications: EngineerRegistrationListPage;
};

/** 拒绝后重提命令：账号、目标组织与申请说明 */
export type ResubmitEngineerRegistrationCommand = {
  accountIdentifier: string;
  password: string;
  organizationId: number;
  applicationNote?: string | null;
};

/** 重提结果：新 PENDING 申请的最小事实 */
export type ResubmitEngineerRegistrationResult = {
  applicationId: number;
  organizationId: number;
  status: EngineerRegistrationApplicationStatus;
  submittedAt: Date;
};

/** 本人申请读取命令：账号只来自已认证 Session，无任何他人 ID 入参 */
export type GetMyEngineerRegistrationCommand = {
  session: UsecaseSession;
};

/**
 * 本人最新一份工程师申请的最小展示事实。
 *
 * 只含申请人自己在受限页需要看到的信息：目标公司、状态、提交/审核时间与审核意见；
 * 不含审核管理员身份、账号资料或任何他人数据。
 */
export type MyEngineerRegistrationResult = {
  applicationId: number;
  organizationId: number;
  /** 目标公司名称；组织行已物理删除时为 null（不影响其余事实展示） */
  organizationName: string | null;
  status: EngineerRegistrationApplicationStatus;
  applicationNote: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewComment: string | null;
};
