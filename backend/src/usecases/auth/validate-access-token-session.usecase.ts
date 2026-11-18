// src/usecases/auth/validate-access-token-session.usecase.ts
import type { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { type AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { evaluateSessionStatusCombination } from '@core/account/policy/session-restriction.policy';
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
 * 3. `account.status` 与 `userInfo.userState` 的组合不合法：只允许 `ACTIVE` / `ACTIVE`，
 *    `PENDING` / `PENDING` 仅在存在明确限制时放行给受限会话；单边状态不一致、其余
 *    禁用状态与缺行失败关闭（日志原因可区分子项）；
 * 4. 数据库 `access_group` 与解密后的 `meta_digest` 必须是同一非空、无重复、合法
 *    角色集合，且 `identity_hint` 必须是该集合成员；管理员写链路仍使用单角色收敛；
 * 5. Token `accessGroup` 经统一映射后的角色集合必须与数据库集合完全一致；
 * 6. Token `activeRole` 可缺失；存在时必须是数据库集合成员；
 * 7. Token `credentialVersion`（缺失按 0）必须与数据库 `credential_version` 一致：
 *    补发 / 二级专用重置 / 自助改密 / 公司启停都会在各自事务内递增该列，
 *    因此旧 Token 在到期前也会被永久拒绝（不依赖再启用或角色恢复）。
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
 * 请求被拒绝。仅靠状态复核时，若停用后又被重新启用且角色恢复一致，旧 Token 会重新
 * 通过——凭据代次（门禁 7）为此提供**持久撤销**：公司启停在同事务内递增
 * `credential_version`，旧 Token 声明不再匹配，永久失效。
 *
 * 为什么凭据变更会使旧 Access Token 失效：登录签发时把当时的 `credential_version`
 * 写入 access token；补发、二级专用重置、自助改密与公司启停都在写事务内递增该列，
 * 本用例逐请求比对。旧 Token 缺失该声明时按 0 处理，因此存量令牌在首次凭据变更前
 * 自然兼容，变更后即被拒绝。refresh token 在本仓库没有续签消费者（`generateRefreshToken`
 * 签发的 refresh token 无端点使用），故不存在「用 refresh 复活旧会话」的入口；
 * 若未来新增续签入口，必须在续签时同样校验并沿用最新 `credential_version`。
 *
 * 不引入新的 Session 真源：数据库 `base_user_account` / `base_user_info` 行就是唯一
 * 授权事实来源，本用例只做「Token 签发时声明」与「请求时数据库事实」的比对；
 * 不新增 Redis Session、黑名单或额外认证中间件。`credential_version` 是账号行上的
 * 持久撤销事实，不是第二份授权状态。
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
    // 3. 账号/资料双状态组合：只允许 ACTIVE/ACTIVE；PENDING/PENDING 仅在存在明确限制
    // （必须改密 / 工程师待审 / 工程师拒绝 / 已批准但资格未生效）时放行给受限会话。
    // 单边 PENDING、其余禁用状态与缺行一律失败关闭；日志原因可区分「双状态不一致」与
    // 「行缺失」。门禁口径与登录入口共用 core 纯策略；本用例固定允许受限会话，
    // 业务入口的限制由 RolesGuard / SessionRestrictionGuard 继续拦截。
    // 限制状态与身份组织字段由同一解析用例产出，申请/成员事实只看一次库。
    const resolution = await this.resolveSessionRestrictionUsecase.execute({
      accountId: payload.sub,
      snapshot,
    });
    const restriction = resolution.restriction;

    const statusDecision = evaluateSessionStatusCombination({
      accountStatus: snapshot.accountStatus,
      userState: snapshot.userInfo.userState,
      restriction,
      allowRestrictedSession: true,
    });
    if (!statusDecision.allowed) {
      this.reject(3, statusDecision.rejection, payload.sub);
    }

    // 4. 历史会话兼容的三源角色集合校验。管理员写链路仍使用严格单角色收敛。
    const roleSet = validateAccountRoleSet({
      identityHint: snapshot.identityHint,
      accessGroup: snapshot.userInfo.accessGroup,
      metaDigest: snapshot.userInfo.metaDigest,
    });
    if (!roleSet.valid) {
      this.reject(4, `ROLE_SET_VALIDATION_FAILED:${roleSet.reason}`, payload.sub);
    }

    // 5. Token 角色集合必须与数据库当前角色集合完全一致。
    if (
      tokenSession.roles.length !== roleSet.roles.length ||
      !tokenSession.roles.every((role) => roleSet.roles.includes(role as IdentityTypeEnum))
    ) {
      this.reject(5, 'TOKEN_ACCESS_GROUP_MISMATCH', payload.sub);
    }

    // 6. activeRole 是可选的历史声明；存在时必须属于当前数据库角色集合。
    if (tokenSession.activeRole !== undefined && !roleSet.roles.includes(tokenSession.activeRole)) {
      this.reject(6, 'ACTIVE_ROLE_NOT_IN_ROLE_SET', payload.sub);
    }

    // 7. 凭据代次必须与数据库当前值一致：补发 / 重置 / 改密 / 公司启停递增后，
    //    旧 access token（含未声明该字段的存量令牌，按 0 处理）永久失效。
    if ((payload.credentialVersion ?? 0) !== snapshot.credentialVersion) {
      this.reject(7, 'CREDENTIAL_VERSION_MISMATCH', payload.sub);
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
