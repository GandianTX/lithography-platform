// src/usecases/account/list-admin-users.usecase.ts

import {
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  isDomainError,
} from '@core/common/errors/domain-error';
import {
  applyDefaults,
  enforceMaxPageSize,
  isOffsetMode,
} from '@core/pagination/pagination.policy';
import type { PaginationParams } from '@core/pagination/pagination.types';
import { Injectable } from '@nestjs/common';
import type { AdminUserListPage, AdminUserListQuery } from '@src/modules/account/account.types';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { PinoLogger } from 'nestjs-pino';
import {
  normalizeAdminUserKeyword,
  normalizeAdminUserListRoleFilter,
  normalizeAdminUserListStatusFilter,
} from './admin-user-management.input.normalize';
import type { ListAdminUsersCommand } from './admin-user-management.types';
import { assertAdminUserManagementPermission } from './admin-user-permission';

/**
 * 页大小上限：与 GraphQL 边界 `PaginationArgs` 的 `@Max(100)`、
 * `ListMyRepairRequestsUsecase` 以及 `TypeOrmSearch.computeParams()` 内部的上限保持一致。
 * 上限在传输无关的用例层强制，不依赖入口校验。
 */
const MAX_PAGE_SIZE = 100;

/**
 * 管理员用户列表用例（P0-2）。
 *
 * 执行顺序刻意固定：
 * 1. **第一步就是精确 SUPER_ADMIN 权限断言**（`assertAdminUserManagementPermission()`，
 *    全仓唯一实现，同时校验 `roles` 含 SUPER_ADMIN 且 `activeRole` 精确等于 SUPER_ADMIN，
 *    缺失或矛盾即失败关闭为 `FORBIDDEN`）。断言先于任何输入规范化与数据库读取，
 *    因此无权限的调用者既不会触发查询，也不会从错误文案里推断出筛选值域；
 * 2. 分页收敛：唯一路径是 `@core/pagination/pagination.policy` 的 `applyDefaults()` +
 *    `enforceMaxPageSize()`，不在本用例另写钳制逻辑；
 * 3. 场景输入规范化（keyword / role / status 白名单）；
 * 4. 组织隔离：经 `TrustedOrganizationContextQueryService.resolveForAccount()` 解析管理员
 *    单一有效组织，再经 `OrganizationMembershipQueryService.listActiveAccountIdsByOrganization()`
 *    取得本组织有效账号 ID 清单，作为 `accountIds` 下推给 QueryService；
 * 5. 调用 QueryService 读取。
 *
 * 依赖方向（`usecase.rules.md`）：本用例只依赖 QueryService，**不访问 Repository、
 * 不接触 ORM、不开启事务**（读链路没有事务边界）。组织范围由 usecase 编排解析后以
 * 账号 ID 清单跨域下推，account 域 QueryService 不导入组织 Entity。
 * 权限白名单与断言留在 usecases 层，不下沉到 modules。
 *
 * 不能收敛为同一个唯一角色时，QueryService 抛 `ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT`
 * （映射 `INTERNAL_SERVER_ERROR`），本用例原样上抛——**不返回部分列表、不排除异常行、
 * 不选任一源字段兜底、不静默修复**。本用例只补充服务端日志：定位所需的最小信息
 * （账号主键 + 失败原因分类）取自 `DomainError.cause`，刻意不记录三源角色原值、
 * `access_group` / `meta_digest` 内容、密码或 Token；`cause` 不会被全局过滤器序列化进
 * `extensions`，因此异常账号 ID 不会外泄给前端。
 *
 * 不含数据库复核。已停用或已降级的账号在旧 Access Token 到期前仍可能通过该断言，
 * 即时失效由 `ValidateAccessTokenSessionUsecase`（P0-7）承担。
 */
@Injectable()
export class ListAdminUsersUsecase {
  constructor(
    private readonly adminUserQueryService: AdminUserQueryService,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ListAdminUsersUsecase.name);
  }

  async execute(command: ListAdminUsersCommand): Promise<AdminUserListPage> {
    assertAdminUserManagementPermission(command.session, '查看');

    const { page, pageSize } = this.resolveOffsetPagination(command.pagination);

    // 组织隔离：管理员只能查看本组织账号。组织范围只来自可信解析（Session 账号的单一
    // 有效成员关系），绝不取客户端自报；无有效组织或存在歧义时由解析服务失败关闭为
    // FORBIDDEN，不返回全库列表。
    const organization = await this.organizationContextQueryService.resolveForAccount({
      accountId: command.session.accountId,
    });
    const accountIds =
      await this.organizationMembershipQueryService.listActiveAccountIdsByOrganization({
        organizationId: organization.organizationId,
      });

    const query: AdminUserListQuery = {
      page,
      pageSize,
      keyword: normalizeAdminUserKeyword(command.keyword),
      role: normalizeAdminUserListRoleFilter(command.role),
      status: normalizeAdminUserListStatusFilter(command.status),
      accountIds,
    };

    try {
      return await this.adminUserQueryService.listAdminUsers(query);
    } catch (error) {
      this.logListFailure(error);
      throw error;
    }
  }

  /**
   * 分页收敛：只接受 OFFSET，钳制页大小与页码下界，并**丢弃** `sorts` 与 `withTotal`。
   *
   * 的固定契约给出（`created_at DESC, id DESC`），`total` 恒定返回。结构上不存在这两个字段，
   * 比在用例内做运行时校验更可靠。
   */
  private resolveOffsetPagination(pagination: PaginationParams): {
    page: number;
    pageSize: number;
  } {
    if (pagination.mode !== 'OFFSET') {
      throw new DomainError(
        INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
        '管理员用户列表第一版仅支持 OFFSET 分页',
      );
    }

    const resolved = enforceMaxPageSize(applyDefaults(pagination, {}), MAX_PAGE_SIZE);
    if (!isOffsetMode(resolved)) {
      // 不可达：`applyDefaults()` / `enforceMaxPageSize()` 都不改变 `mode`，非 OFFSET 输入
      // 使 narrowing 由编译器而非断言保证。
      throw new DomainError(
        INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE,
        '管理员用户列表第一版仅支持 OFFSET 分页',
      );
    }
    return { page: resolved.page, pageSize: resolved.pageSize };
  }

  /**
   *
   * 只记录错误大类与最小定位信息；不记录筛选入参、三源角色原值、密码或 Token，
   * 也不把原始数据库异常对象整体打进日志（其 `message` 可能带 SQL 文本）。
   *
   * 分流依据是 `cause` 的**形态**而非错误码：`READ_FAILED` 有两类来源——资料行缺失
   * （`cause` 为纯对象，含定位所需的 `accountId`）与驱动故障（`cause` 为 `Error` 实例，
   * `message` 含 SQL 文本，必须丢弃）。按错误码一刀切会让前者丢失 `accountId`，
   * 运维面对 500 时无法定位到具体账号。
   */
  private logListFailure(error: unknown): void {
    if (!isDomainError(error)) {
      this.logger.error(
        { reason: 'UNEXPECTED' },
        '管理员用户列表读取失败（非领域异常，已按 INTERNAL_SERVER_ERROR 上抛）',
      );
      return;
    }

    const cause = error.cause;
    // 结构化诊断对象（`accountId` / `reason` / `diagnostic`，均不含敏感数据）原样保留；
    // `Error` 实例一律丢弃，只保留类型名——`QueryFailedError.message` 含 SQL 文本。
    const diagnostic = cause instanceof Error || cause === undefined ? undefined : cause;

    if (error.code === ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT) {
      const convergence = diagnostic as
        { readonly accountId?: unknown; readonly reason?: unknown } | undefined;
      this.logger.error(
        { accountId: convergence?.accountId, reason: convergence?.reason },
        '管理员用户列表因账号三源角色数据无法收敛为唯一角色而整次失败关闭',
      );
      return;
    }

    this.logger.error(
      {
        errorCode: error.code,
        diagnostic,
        causeErrorName: cause instanceof Error ? cause.name : undefined,
      },
      '管理员用户列表读取失败',
    );
  }
}
