// src/types/auth/session-restriction.types.ts

import type { JwtPayload } from '../jwt.types';
import { IdentityTypeEnum } from '../models/account.types';

/**
 * 受限会话类型：表达「账号已通过身份认证，但当前只允许改密 / 查看自身会话 / 退出」。
 *
 * - `NONE`：无限制，可正常访问业务；
 * - `MUST_CHANGE_PASSWORD`：管理员要求下次登录必须改密；
 * - `ENGINEER_PENDING`：工程师注册申请待审核；
 * - `ENGINEER_REJECTED`：工程师注册申请被拒绝；
 * - `ENGINEER_INACTIVE`：申请已批准但资格未生效——双状态未同时 ACTIVE，或申请目标
 *   组织内没有有效 `ENGINEER` 成员关系（含组织停用、角色不符、多组织歧义）。
 *   已批准事实单独不授予业务权限，必须由服务端成员事实确认。
 *
 * 判定实现归属 `src/core/account/policy/session-restriction.policy.ts` 的纯函数，
 * 鉴权层只消费结论，不在 Usecase / Guard 内各自推导。
 */
export enum SessionRestriction {
  NONE = 'NONE',
  MUST_CHANGE_PASSWORD = 'MUST_CHANGE_PASSWORD',
  ENGINEER_PENDING = 'ENGINEER_PENDING',
  ENGINEER_REJECTED = 'ENGINEER_REJECTED',
  ENGINEER_INACTIVE = 'ENGINEER_INACTIVE',
}

/**
 * 请求期会话身份事实（由 `ValidateAccessTokenSessionUsecase` 每请求计算并挂到 `request.user`）。
 *
 * 只含可对外展示的身份字段，不含 `accessGroup` / `metaDigest` 等授权原值。
 * `role` 取 Token 的 `activeRole`；历史 Token 缺失时保持 `null`，不推导、不伪造。
 */
export interface SessionIdentity {
  /** 当前账户 ID（等同 JWT `sub`） */
  accountId: number;
  /** 当前使用角色；历史 Token 缺失 `activeRole` 时为 `null` */
  role: IdentityTypeEnum | null;
  /** 管理员等级（1 / 2 / null），非管理员为 `null` */
  adminLevel: number | null;
  /** 客户公司归属（`base_user_info.customer_organization_id`），无归属为 `null` */
  customerOrganizationId: number | null;
  /** 唯一有效 ENGINEER 成员组织；无成员或多组织歧义为 `null` */
  engineerOrganizationId: number | null;
  /** 唯一有效 SUPER_ADMIN 成员组织；无成员或多组织歧义为 `null` */
  adminOrganizationId: number | null;
  /**
   * 最新工程师申请的目标公司，仅用于本人在受限页展示申请去向；
   * **不授予任何组织业务权限**，与 `engineerOrganizationId` 相互独立。
   */
  registrationOrganizationId: number | null;
  /** 当前限制状态 */
  restriction: SessionRestriction;
}

/**
 * 认证通过后的请求用户：JWT 声明 + 请求期会话事实。
 *
 * `JwtStrategy.validate()` 返回该形状；`RolesGuard` / `SessionRestrictionGuard` 读取
 * `restriction`，业务 Resolver 仍可把该值当作 `JwtPayload` 使用（结构兼容）。
 */
export type AuthenticatedSessionUser = JwtPayload & SessionIdentity;
