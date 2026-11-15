// src/types/auth/session.types.ts
import { JwtPayload } from '../jwt.types';
import { IdentityTypeEnum } from '../models/account.types';
import type { SessionIdentity } from './session-restriction.types';

/**
 * 请求期会话事实中可供业务用例使用的身份字段子集。
 *
 * 这些字段由 `JwtStrategy` 经 `ValidateAccessTokenSessionUsecase` 每请求查库后挂到
 * `request.user`，**不是 JWT 签发声明**，客户端无法传入；登录流程自行拼装的 payload
 * 不含这些字段时按 `null` 处理。
 */
type RequestTimeSessionFacts = Partial<
  Pick<SessionIdentity, 'adminLevel' | 'adminOrganizationId' | 'customerOrganizationId'>
>;

/**
 * Usecase 层统一会话类型
 * 从 GraphQL 层的 `JwtPayload` 中抽取必要字段，避免在各 usecase 重复定义。
 */
export interface UsecaseSession {
  /** 当前账户 ID */
  accountId: number;
  /**
   * 角色访问组（已在此处做规范化）
   * - 来源：JWT `accessGroup`
   * - 格式：全部转为大写字符串，去除空值与重复项
   * - 语义：与 GraphQL `@Roles()` 所使用的角色编码保持一致（如 "ENGINEER"）
   */
  roles: string[];
  /**
   * 当前使用角色（可选）
   * - 来源：JWT `activeRole`（登录后角色决策阶段写入）
   * - 缺失或异常值不做补全/伪造，由需要精确角色判定的用例自行失败关闭
   */
  activeRole?: IdentityTypeEnum;
  /**
   * 管理员等级（1=一级；2=二级；null=非管理员、未映射或请求期未复核）
   *
   * 来源为请求期数据库复核（`request.user.adminLevel`），不是 JWT 声明。
   * 管理员用例必须同时校验可信公司归属，等级缺失或非法一律失败关闭。
   */
  adminLevel?: number | null;
  /**
   * 请求期复核得到的唯一有效管理员成员公司（`SUPER_ADMIN` 成员且组织启用）。
   * 0 条或多条成员关系时为 `null`，二级管理员缺少该值时必须拒绝。
   */
  adminOrganizationId?: number | null;
  /** 请求期复核得到的客户可信公司归属（`base_user_info.customer_organization_id`） */
  customerOrganizationId?: number | null;
}

/**
 * 从 JWT Payload 映射到 UsecaseSession 的辅助函数
 * 防止不同调用方手动拼装导致字段不一致。
 */
export function mapJwtToUsecaseSession(jwt: JwtPayload & RequestTimeSessionFacts): UsecaseSession {
  return {
    accountId: jwt.sub,
    roles: normalizeAccessGroup(jwt.accessGroup),
    // 直接透传 JWT activeRole（可能为 undefined），不在此处推导或伪造；
    // 精确角色用例（如接单）在缺失/异常时自行失败关闭
    activeRole: jwt.activeRole,
    // 请求期复核结果透传：缺省（登录流程自行拼装的 payload）按 null 表达，
    // 由需要等级/归属的用例自行失败关闭
    adminLevel: jwt.adminLevel ?? null,
    adminOrganizationId: jwt.adminOrganizationId ?? null,
    customerOrganizationId: jwt.customerOrganizationId ?? null,
  };
}

/**
 * 将 JWT `accessGroup` 规范化为用例层可直接使用的角色数组
 * - 统一转为大写字符串
 * - 过滤空值与空字符串
 * - 去重，避免重复角色影响后续判断与日志
 */
function normalizeAccessGroup(accessGroup: string[]): string[] {
  if (!Array.isArray(accessGroup)) return [];

  const normalized: string[] = [];
  for (const role of accessGroup) {
    if (role == null) continue;
    const name = String(role).trim();
    if (!name) continue;
    normalized.push(name.toUpperCase());
  }

  return Array.from(new Set(normalized));
}
