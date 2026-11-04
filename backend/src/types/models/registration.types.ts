// src/types/models/registration.types.ts

import { RegisterTypeEnum } from '@app-types/services/register.types';

/**
 * 工程师自助注册申请状态（跨上下文稳定枚举）。
 *
 * `PENDING` 表示待目标组织管理员审核；`APPROVED` 表示审核通过并已开通；
 * `REJECTED` 表示审核拒绝，账号保持待审、可凭本人凭据重提新申请。
 * 该枚举只描述申请记录，不新增账号状态；账号仍使用 `AccountStatus.PENDING`。
 */
export enum EngineerRegistrationApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * 注册结果状态：客户注册直接开通；工程师注册只落待审申请，账号保持待审。
 *
 * 该枚举只描述**注册入口的即时结果**，不参与账号或申请状态判定。
 */
export enum RegistrationOutcomeStatus {
  REGISTERED = 'REGISTERED',
  PENDING_REVIEW = 'PENDING_REVIEW',
}

/**
 * 组织管理员对工程师注册申请的终态决策动作。
 *
 * 只允许二选一终态：`APPROVE` 同事务开通账号并建立有效成员关系；
 * `REJECT` 仅记录拒绝与意见，账号保持待审、可重提。
 */
export enum EngineerRegistrationReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

/**
 * 邮箱注册用例参数
 *
 * `organizationId` 为客户/工程师所选组织（必填，事务内复核有效）；
 * `applicationNote` 仅工程师待审申请使用，客户注册忽略。
 */
export interface RegisterWithEmailParams {
  loginName?: string | null;
  loginEmail: string;
  loginPassword: string;
  nickname?: string | null;
  type?: RegisterTypeEnum;
  organizationId: number;
  applicationNote?: string | null;
  inviteToken?: string;
  clientIp?: string;
}

/**
 * 邮箱注册结果
 *
 * `registrationStatus` 区分「已开通」与「待审核」；客户注册恒为 `REGISTERED`，
 * 工程师注册恒为 `PENDING_REVIEW` 且 `applicationId` 非空。
 */
export interface RegisterWithEmailResult {
  success: boolean;
  message: string;
  accountId: number;
  registrationStatus: RegistrationOutcomeStatus;
  applicationId: number | null;
}
