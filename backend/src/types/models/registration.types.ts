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
 * 注册入口通道：决定输入默认值、公司资格口径与资料写入范围。
 *
 * - `LEGACY`：既有 `register` 入口（旧客户端、小程序注册、凭据重提共用）。
 *   组织主键必填，资格只要求 `ACTIVE`；工程师姓名/电话可省略；不支持手填公司；
 *   客户注册不写 `customer_organization_id`。与主线原有请求形状保持一致；
 * - `WEB`：V44 Web 注册入口 `registerWeb`。公司资格为 `ACTIVE + 受管`；
 *   工程师必填姓名/电话；客户在「选择公司 / 手填公司」中二选一，
 *   选择公司时写可信 `customer_organization_id`。
 *
 * 两条通道复用同一账号初始化、唯一性校验与注册事务，差异只在校验口径与字段写入。
 */
export enum RegistrationEntryChannel {
  LEGACY = 'LEGACY',
  WEB = 'WEB',
}

/**
 * 邮箱注册用例参数
 *
 * `entryChannel` 由 GraphQL 入口显式传入，不使用默认值，避免新入口误走旧规则；
 * `organizationId` 在 `LEGACY` 下必填，在 `WEB` 下与 `organizationName` 二选一；
 * `applicationNote` 仅工程师待审申请使用，客户注册忽略。
 */
export interface RegisterWithEmailParams {
  loginName?: string | null;
  loginEmail: string;
  loginPassword: string;
  nickname?: string | null;
  /** 真实姓名：`WEB` 工程师必填；`LEGACY` 工程师可省略，客户忽略 */
  realName?: string | null;
  /** 联系电话：`WEB` 工程师必填；`LEGACY` 工程师可省略，客户忽略 */
  phone?: string | null;
  type?: RegisterTypeEnum;
  /** 注册入口通道；调用方必须显式指定 */
  entryChannel: RegistrationEntryChannel;
  /** 选择名单内公司时使用；`LEGACY` 为必填，`WEB` 与 `organizationName` 互斥 */
  organizationId?: number | null;
  /** 手填自家公司名称时使用；仅 `WEB` 客户支持，与 `organizationId` 互斥 */
  organizationName?: string | null;
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
