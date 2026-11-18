// src/types/jwt.types.ts

import { AudienceTypeEnum, IdentityTypeEnum } from './models/account.types';

/**
 * 生成访问令牌的参数类型
 */
export type GenerateAccessTokenParams = {
  payload: JwtPayload;
  expiresIn?: string;
  audience?: AudienceTypeEnum; // 更明确的类型，使用枚举而非字符串
};

/**
 * 生成刷新令牌的参数类型
 */
export type GenerateRefreshTokenParams = {
  payload: Pick<JwtPayload, 'sub'>;
  tokenVersion?: number;
  audience?: AudienceTypeEnum; // 更明确的类型，使用枚举而非字符串
};

/**
 * JWT Payload 类型定义
 */
export type JwtPayload = {
  // 自定义字段
  sub: number; // 用户 ID
  username: string; // 用户昵称（来自 UserInfoEntity.nickname）
  email: string | null; // 邮箱，允许为空
  accessGroup: string[]; // 角色或分组
  /** 当前使用角色（可选；在登录后角色决策阶段写入） */
  activeRole?: IdentityTypeEnum;
  type?: 'access' | 'refresh';
  tokenVersion?: number; // Refresh 控制用
  /**
   * 凭据代次（access token 专用）：与 `base_user_account.credential_version` 比对，
   * 补发 / 重置 / 自助改密 / 公司启停后递增，使旧 access token 永久失效。
   * 缺失声明的旧 Token 按 0 处理。
   */
  credentialVersion?: number;
  // 自动管理字段
  iat?: number; // 签发时间
  exp?: number; // 过期时间
  iss?: string; // 签发者
  aud?: string; // 受众 (audience)，对应 JWT 标准的 audience 声明，用于标识 token 的预期接收者
};
