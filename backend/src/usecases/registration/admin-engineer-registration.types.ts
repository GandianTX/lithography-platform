// src/usecases/registration/admin-engineer-registration.types.ts
// 组织管理员审核工程师自助注册申请的执行契约（仅服务对应 usecase 与其调用 adapter）。

import type { UsecaseSession } from '@app-types/auth/session.types';
import type {
  EngineerRegistrationApplicationStatus,
  EngineerRegistrationReviewAction,
} from '@app-types/models/registration.types';
import type { PaginationParams } from '@core/pagination/pagination.types';
import type { AdminApplicantDetailView, AdminUserView } from '@src/modules/account/account.types';
import type { EngineerRegistrationApplicationSnapshot } from '@src/modules/lithography/engineer-registration.types';

/** 审核队列/详情的最小条目：申请事实 + 申请人公开资料 + 目标公司展示名，不含任何凭据或角色摘要 */
export type AdminEngineerRegistrationItem = {
  readonly application: EngineerRegistrationApplicationSnapshot;
  readonly applicant: AdminUserView;
  /** 申请目标公司展示名；公司行缺失时为 null，仅用于展示 */
  readonly organizationName: string | null;
};

/** 审核队列分页结果 */
export type AdminEngineerRegistrationQueuePage = {
  readonly items: ReadonlyArray<AdminEngineerRegistrationItem>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
};

/**
 * 审核详情条目：申请事实 + 申请人详情资料（含真实姓名）+ 目标公司展示名。
 *
 * 与列表条目分开：列表只需要摘要，详情才需要真实姓名；真实姓名 `realName` 可能为
 * `null`（旧数据未填），调用方必须按空展示，不得用 `nickname` 冒充。
 */
export type AdminEngineerRegistrationDetailItem = {
  readonly application: EngineerRegistrationApplicationSnapshot;
  readonly applicant: AdminApplicantDetailView;
  /** 申请目标公司展示名；公司行缺失时为 null，仅用于展示 */
  readonly organizationName: string | null;
};

/** 组织审核队列查询命令：organizationId 由可信组织解析，绝不取客户端自报 */
export type ListAdminEngineerRegistrationsCommand = {
  readonly session: UsecaseSession;
  readonly status?: EngineerRegistrationApplicationStatus | null;
  readonly pagination: PaginationParams;
};

/** 组织审核详情查询命令 */
export type GetAdminEngineerRegistrationDetailCommand = {
  readonly session: UsecaseSession;
  readonly applicationId: number;
};

/** 一次性终态审核命令 */
export type ReviewEngineerRegistrationCommand = {
  readonly session: UsecaseSession;
  readonly applicationId: number;
  readonly action: EngineerRegistrationReviewAction;
  readonly reviewComment?: string | null;
};

/** 审核结果：终态申请事实 + 审核后的申请人当前视图（拒绝时账号仍为待审） */
export type ReviewEngineerRegistrationResult = {
  readonly application: EngineerRegistrationApplicationSnapshot;
  readonly applicant: AdminUserView;
  /** 申请目标公司展示名；公司行缺失时为 null，仅用于展示 */
  readonly organizationName: string | null;
};
