// src/usecases/auth/validate-access-token-session.usecase.ts
import type { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import {
  isAccountStatusAllowedForSession,
  isUserStateAllowedForSession,
} from '@core/account/policy/session-restriction.policy';
import { validateAccountRoleSet } from '@core/account/policy/account-role-convergence.policy';
import { DomainError, JWT_ERROR } from '@core/common/errors/domain-error';
import type { AccountSessionAuthoritySnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ResolveSessionRestrictionUsecase } from './resolve-session-restriction.usecase';

/**
 * `JwtStrategy` 的唯一数据库 Session 复核入口（P0-7）。
 *
 * `JwtStrategy` 只做协议接入（提取 Bearer token 与签名验证），账号存在性、状态与
 * 角色一致性等全部 Session 读校验上提到本用例（`auth-session-current.md`）；
 * 本用例不接触 Repository、不承载协议逻辑。
 *
 * `JWT_ERROR.AUTHENTICATION_FAILED` → 全局过滤器 `UNAUTHENTICATED`）：
 *
 * 1. payload 不是 access token（含 refresh token 误入受保护请求）；
 * 2. 账号或 userInfo 记录不存在（快照以 `null` 表达缺失，缺失语义见
 *    `AccountSessionAuthoritySnapshot`）；
 * 3. `account.status` 不是 `ACTIVE`；
 * 4. `userInfo.userState` 不是 `ACTIVE`；
 * 5. 数据库 `access_group` 与解密后的 `meta_digest` 必须是同一非空、无重复、合法
 *    角色集合，且 `identity_hint` 必须是该集合成员；管理员写链路仍使用单角色收敛；
 * 6. Token `accessGroup` 经统一映射后的角色集合必须与数据库集合完全一致；
 * 7. Token `activeRole` 可缺失；存在时必须是数据库集合成员。
 *
 * 服务端诊断日志（R10-3）：任一门禁拒绝时先以 `warn` 记录门禁序号、原因分类与账号主键
 * 再抛错。三源角色原值、收敛细节与任何凭据派生物不进日志，抛出的 `DomainError` 不携带
 * `details`——reason 分类按收敛 policy 注释「仅供服务端定位与日志使用」的裁决，本用例
 * 即其日志落点（与 `AdminUserQueryService`「诊断以 `DomainError.cause` 上行、由 Usecase
 *
 * `graphql-error-contract-current.md`）：本用例只表达「会话不可用」，一律抛
 * `JWT_ERROR.AUTHENTICATION_FAILED`（过滤器映射 `UNAUTHENTICATED`，前端据此走既有
 * 全局 auth failure handler 清理 Session 并跳 `/login`）；已认证但业务权限不足的
 * `FORBIDDEN`（`PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS` 等）由各业务用例的权限
 * 断言表达，本用例不越权代判，也不把任何权限失败改判为 `UNAUTHENTICATED`。
 *
 * 数据库异常不经本用例改写：QueryService 抛出的非领域异常按既有链路冒泡为
 * `INTERNAL_SERVER_ERROR`——数据库不可用不是「会话无效」，塌缩为 `UNAUTHENTICATED`
 * 会诱导前端误清本地会话（与 11.2 的 not-found / input 不塌缩口径同理）。
 *
 * 为什么停用和改角色能使旧 Token 失效：access token 在 `JWT_EXPIRES_IN` 内是静态的，
 * 但本用例在**每次受保护请求**读取数据库当前事实并与 Token 声明比对——`status` /
 * `user_state` 被停用、三源角色被改写、`activeRole` 不再匹配，任一变化都会在下一次
 * 在旧 Token 到期前被重新启用且角色恢复一致，旧 Token 会重新通过复核——本轮没有
 * 持久化撤销版本可永久区分该 Token，不在本 PR 扩展解决。
 *
 * 为什么密码重置不会使 Access Token 立即失效：本复核只比对状态与角色事实，不读取、
 * 不影响已签发 Token，旧登录态按 `JWT_EXPIRES_IN` 自然过期；不在此追加密码版本判断。
 *
 * 不引入新的 Session 真源：数据库 `base_user_account` / `base_user_info` 行就是唯一
 * 授权事实来源，本用例只做「Token 签发时声明」与「请求时数据库事实」的比对；
 * 不新增 Redis Session、Refresh Token、Token Version、黑名单或认证中间件
 */
@Injectable()
export class ValidateAccessTokenSessionUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly resolveSessionRestrictionUsecase: ResolveSessionRestrictionUsecase,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ValidateAccessTokenSessionUsecase.name);
  }

  async execute(input: { readonly payload: JwtPayload }): Promise<AuthenticatedSessionUser> {
    const { payload } = input;

    // 1. 只接受 access token：refresh token 不得进入受保护请求的认证链路
    if (payload.type !== 'access') {
      this.reject(1, 'NOT_ACCESS_TOKEN', payload.sub);
    }

    // Token 声明的规范化复用全仓唯一映射入口（auth-session-current.md：不各自手写
    // session shape）；roles 即经规范化的 accessGroup，activeRole 缺失时保持缺失
    const tokenSession = mapJwtToUsecaseSession(payload);

    // 2~4. 数据库当前事实快照（P0-7 单一语义读取），逐条失败关闭
    const snapshot: AccountSessionAuthoritySnapshot =
      await this.accountQueryService.findSessionAuthoritySnapshot({ accountId: payload.sub });

    if (snapshot.accountStatus === null) {
      this.reject(2, 'ACCOUNT_RECORD_MISSING', payload.sub);
    }
    if (snapshot.userInfo === null) {
      // 资料行缺失（账号行存在）：同上失败关闭，日志按缺失行区分诊断粒度（R10-3）
      this.reject(2, 'USER_INFO_RECORD_MISSING', payload.sub);
    }
    // 3~4. 账号/资料状态：ACTIVE 放行；PENDING 仅在存在明确限制（必须改密 / 工程师待审 /
    // 工程师拒绝 / 已批准但资格未生效）时放行给受限会话；其余状态（停用、封禁、删除、注销）
    // 一律失败关闭。门禁口径与登录入口共用 core 纯策略；本用例固定允许受限会话，
    // 业务入口的限制由 RolesGuard / SessionRestrictionGuard 继续拦截。
    // 限制状态与身份组织字段由同一解析用例产出，申请/成员事实只看一次库。
    const resolution = await this.resolveSessionRestrictionUsecase.execute({
      accountId: payload.sub,
      snapshot,
    });
    const restriction = resolution.restriction;

    const isAccountStatusAllowed = isAccountStatusAllowedForSession({
      accountStatus: snapshot.accountStatus,
      restriction,
      allowRestrictedSession: true,
    });
    if (!isAccountStatusAllowed) {
      this.reject(3, 'ACCOUNT_STATUS_NOT_ALLOWED', payload.sub);
    }

    const isUserStateAllowed = isUserStateAllowedForSession({
      userState: snapshot.userInfo.userState,
      restriction,
      allowRestrictedSession: true,
    });
    if (!isUserStateAllowed) {
      this.reject(4, 'USER_STATE_NOT_ALLOWED', payload.sub);
    }

    // 5. 历史会话兼容的三源角色集合校验。管理员写链路仍使用严格单角色收敛。
    const roleSet = validateAccountRoleSet({
      identityHint: snapshot.identityHint,
      accessGroup: snapshot.userInfo.accessGroup,
      metaDigest: snapshot.userInfo.metaDigest,
    });
    if (!roleSet.valid) {
      this.reject(5, `ROLE_SET_VALIDATION_FAILED:${roleSet.reason}`, payload.sub);
    }

    // 6. Token 角色集合必须与数据库当前角色集合完全一致。
    if (
      tokenSession.roles.length !== roleSet.roles.length ||
      !tokenSession.roles.every((role) => roleSet.roles.includes(role as IdentityTypeEnum))
    ) {
      this.reject(6, 'TOKEN_ACCESS_GROUP_MISMATCH', payload.sub);
    }

    // 7. activeRole 是可选的历史声明；存在时必须属于当前数据库角色集合。
    if (tokenSession.activeRole !== undefined && !roleSet.roles.includes(tokenSession.activeRole)) {
      this.reject(7, 'ACTIVE_ROLE_NOT_IN_ROLE_SET', payload.sub);
    }

    // 复核通过：返回 JWT 声明 + 请求期会话事实（restriction / 身份字段），Strategy 与下游
    // 业务层仍可把返回值当作 `JwtPayload` 使用
    return {
      ...payload,
      accountId: payload.sub,
      role: payload.activeRole ?? null,
      adminLevel: snapshot.adminLevel,
      customerOrganizationId: snapshot.userInfo.customerOrganizationId,
      engineerOrganizationId: resolution.engineerOrganizationId,
      adminOrganizationId: resolution.adminOrganizationId,
      registrationOrganizationId: resolution.latestEngineerApplication?.organizationId ?? null,
      restriction,
    };
  }

  /**
   * 统一失败关闭出口（R10-3）：先记服务端诊断日志，再抛既有 JWT 认证失败领域错误。
   *
   * 原值、收敛细节与任何凭据派生物一律不进日志，抛出的 `DomainError` 不携带 `details`
   * ——对外契约（过滤器映射 `UNAUTHENTICATED`）与失败关闭行为不受日志影响。
   */
  private reject(gate: number, reason: string, accountId: number): never {
    this.logger.warn(
      { event: 'access_token_session_rejected', gate, reason, accountId },
      '受保护请求会话复核未通过',
    );
    throw new DomainError(JWT_ERROR.AUTHENTICATION_FAILED, 'JWT 认证失败');
  }
}
