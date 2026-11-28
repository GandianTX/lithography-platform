// src/types/models/auth.types.ts

import { MinimalUserInfo } from '../auth/login-flow.types';
import { SessionRestriction } from '../auth/session-restriction.types';
import { AudienceTypeEnum, IdentityTypeEnum, LoginTypeEnum } from './account.types';
import { Gender, GeographicInfo, UserState } from './user-info.types';

/**
 * 用户信息视图模型（领域层）
 * 完整用户资料 + 运行时 accessGroup + 安全字段
 * 注意：即使 user_info 表无记录，也要返回一个兜底对象（避免 GraphQL 字段消失）
 */
export interface UserInfoView {
  accountId: number;
  nickname: string; // 非空，提供默认值
  gender: Gender; // 非空，提供默认值
  birthDate: string | null; // MySQL DATE 通常以 string 返回
  avatarUrl: string | null;
  email: string | null;
  signature: string | null;
  accessGroup: IdentityTypeEnum[];
  address: string | null;
  phone: string | null;
  tags: string[] | null; // JSON 列
  geographic: GeographicInfo | null; // JSON 列
  metaDigest: IdentityTypeEnum[] | null; // 用于安全比对的加密字段
  notifyCount: number; // 非空，提供默认值
  unreadCount: number; // 非空，提供默认值
  userState: UserState; // 非空，提供默认值
  createdAt: Date; // 非空，提供默认值
  updatedAt: Date; // 非空，提供默认值
}

/**
 * 登录输入参数领域模型
 */
export interface AuthLoginModel {
  loginName: string;
  loginPassword: string;
  type: LoginTypeEnum;
  ip?: string;
  audience: AudienceTypeEnum;
  /** 是否允许受限账号登录（默认 false，保持旧客户端行为） */
  allowRestrictedSession?: boolean;
  /**
   * 本次签发的 Access Token 有效期覆盖值（jsonwebtoken 时长格式，如 `8h`）。
   *
   * 只允许需要与全局 `JWT_EXPIRES_IN` 区分的入口传入（当前仅浏览器会话 REST 登录）；
   * 缺省时不传，签发完全沿用 `JwtModule` 的全局 `signOptions.expiresIn`，因此
   * GraphQL 登录、小程序第三方登录与 Refresh Token 的既有有效期不受影响。
   */
  accessTokenTtl?: string;
}

/**
 * 身份信息领域模型
 */
export interface IdentityModel {
  role: IdentityTypeEnum;
}

/**
 * 登录结果领域模型
 */
export interface LoginResultModel {
  accessToken: string;
  refreshToken: string;
  accountId: number;
  role: IdentityTypeEnum;
  identity?: unknown; // 简化为 unknown，由适配器层处理
  userInfo?: MinimalUserInfo | null; // 使用 MinimalUserInfo
  /** 当前会话限制状态（缺省视为 NONE） */
  restriction?: SessionRestriction;
  /** 管理员等级（1 / 2 / null） */
  adminLevel?: number | null;
  /** 客户公司归属 */
  customerOrganizationId?: number | null;
  /** 唯一有效 ENGINEER 成员组织 */
  engineerOrganizationId?: number | null;
  /** 唯一有效 SUPER_ADMIN 成员组织 */
  adminOrganizationId?: number | null;
  /** 最新工程师申请的目标公司（仅展示，不授予权限） */
  registrationOrganizationId?: number | null;
}
