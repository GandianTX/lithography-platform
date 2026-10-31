// src/modules/account/queries/admin-user.query.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import type { SortParam } from '@core/pagination/pagination.types';
import type { SearchOptions, SearchResult } from '@core/search/search.types';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { SearchService } from '@src/modules/common/search.module';
import { Repository } from 'typeorm';
import type {
  AdminUserCredentialConflictField,
  AdminUserListPage,
  AdminUserListQuery,
  AdminUserStatusFacts,
  AdminUserView,
} from '../account.types';
import { AccountEntity } from '../base/entities/account.entity';
import { UserInfoEntity } from '../base/entities/user-info.entity';

/**
 * 登录名 / 登录邮箱 / 昵称联合模糊搜索的安全列（含别名）。
 * 列名一律来自本文件的固定常量，不接受任何外部输入，避免把原始列名透传进 SQL。
 */
const ADMIN_USER_LIST_SEARCH_COLUMNS: ReadonlyArray<string> = [
  'account.loginName',
  'account.loginEmail',
  'userInfo.nickname',
];

/**
 * 业务字段 → 安全列（含别名）的唯一映射：筛选与排序共用，
 * 保证 `allowedFilters` / `allowedSorts` 与 `resolveColumn` 使用同一套「业务字段」语义
 * （`src/infrastructure/typeorm/search/README.md` 第 2 条约束）。
 */
const ADMIN_USER_LIST_COLUMN_MAP: Readonly<Record<string, string>> = {
  // 角色筛选落在 `base_user_account.identity_hint`：三源必须一致，任一行不一致即整次失败关闭，
  // 因此按 `identity_hint` 筛选与按收敛后的 `role` 筛选等价；`access_group` 是 json 列，
  // 既不便索引也不便等值比较，不作为筛选列。
  role: 'account.identityHint',
  status: 'account.status',
  createdAt: 'account.createdAt',
  id: 'account.id',
};

/**
 *
 * `id` 作为 tieBreaker 必须存在：`created_at` 是 `TIMESTAMP(3)`，批量创建（含 seed 与本轮
 * 管理员创建）完全可能落在同一毫秒，只按它排序会让翻页出现重复行或漏行。
 * 排序字段由契约固定，**不接受客户端传入**（`AdminUserListQuery` 没有 `sorts`），
 * 因此 `allowedSorts` 只是引擎侧的白名单校验，不构成可被外部放宽的入口。
 */
const ADMIN_USER_LIST_DEFAULT_SORTS: ReadonlyArray<SortParam> = [
  { field: 'createdAt', direction: 'DESC' },
  { field: 'id', direction: 'DESC' },
];

/**
 * `ADMIN_USER_LIST_COLUMN_MAP`、`ADMIN_USER_LIST_DEFAULT_SORTS` 与下方
 * `ADMIN_USER_LIST_SEARCH_OPTIONS` 四个常量高度耦合——`allowedFilters` /
 * `allowedSorts` 的成员必须是 `ADMIN_USER_LIST_COLUMN_MAP` 的键；
 * `ADMIN_USER_LIST_DEFAULT_SORTS` 的成员必须是 `allowedSorts` 的子集。
 * 修改任一常量时必须同步复核其余三者。
 */
const ADMIN_USER_LIST_SEARCH_OPTIONS: SearchOptions = {
  searchColumns: ADMIN_USER_LIST_SEARCH_COLUMNS,
  allowedFilters: ['role', 'status'],
  allowedSorts: ['createdAt', 'id'],
  defaultSorts: ADMIN_USER_LIST_DEFAULT_SORTS,
  resolveColumn: (field: string): string | null => ADMIN_USER_LIST_COLUMN_MAP[field] ?? null,
  // 刻意不配置 minQueryLength（默认 1）：`normalizeAdminUserKeyword()` 已把空白收敛为
  // `undefined`（不搜索），因此到达这里的 keyword 必然是用户真实输入的 1~100 字符；
  // 把阈值提到 2 会让「搜单个字符」静默退化为「返回全量」，属于静默改写用户搜索意图。
  // 刻意不配置 countDistinctBy：`account` 与 `userInfo` 是 OneToOne 且 `base_user_info`
  // 带 `uk_account_id` UNIQUE 索引（migration 侧 `UNIQUE KEY uk_account_id (account_id)`），
  // 因此下面的 LEFT JOIN 同样不会产生行放大；而 TypeORM 在存在 join 时的 `getCount()`
  // 已自动使用 MySQL 分支的 `COUNT(DISTINCT account.id)`（`computeCountExpression()`），
  // 再叠一层手工 DISTINCT 表达式只会增加方言差异面。
};

/**
 * 管理员用户读链路 QueryService（单一职责：管理员场景的账号 + 资料读取与 View 整形）。
 *
 * 为什么新建而不扩展 `AccountQueryService`：后者已承载登录凭据读取、昵称候选生成、
 * userInfo 可见资料装配、登录引导快照等多种读取语义（465 行），再叠加管理员列表分页、
 * 三源角色收敛与写后读会把「一类事情一文件」彻底打散（`queryservice.rules.md`
 * 「单文件单语义」「当出现多种读取语义时，考虑拆分」「当出现不同权限策略时，考虑拆分」）。
 * 本文件只做管理员场景读取，不含权限断言——精确 SUPER_ADMIN 授权属**写用例的流程级授权**
 * 与列表用例的入口断言，由 `ListAdminUsersUsecase` / `AdminCreateUserUsecase` 调用
 * `assertAdminUserManagementPermission()` 完成（`queryservice.rules.md`「写用例的流程级授权
 * 由 Usecase 负责」）。
 *
 * 边界（`queryservice.rules.md`）：
 * - 只读：不写库、不开启业务事务、不产生副作用（刻意不注入 logger，诊断信息以
 *   `DomainError.cause` 上行，由 Usecase 决定是否记录）；
 * - 对上游只返回稳定 View（`AdminUserView` / `AdminUserListPage`）与窄事实类型，
 *   **不返回 ORM Entity、不返回 QueryBuilder、不返回 GraphQL DTO**；
 * - 不依赖混合读写的普通 Service（`AccountService` / `AccountSecurityService`），
 *   下游只有 core policy、同域只读 repository 与通过 DI 注入的共享搜索门面
 *   （`SearchService` → core 端口 `ISearchEngine` → infrastructure `TypeOrmSearch`）。
 *   该组合的合规依据是三条规则**同时生效**（`rule-precedence.rules.md` 第 34-35 行：
 *   多份文档均适用且不冲突时全部约束同时生效）：`queryservice.rules.md` 第 23 行
 *   「QueryService 归属 modules(service)」+ 第 24-25 行下游许可（core / 同域只读
 *   repository / 同域 ORM Entity / 同域其他 QueryService / 通过 DI 引入的 infrastructure
 *   查询实现）；`modules.rules.md` 第 75 行「允许业务域 modules(service) →
 *   `src/modules/common/*`」；`eslint.config.mjs` boundaries `modules-queries` 的 allow
 *   含 `modules-internal{moduleScope:'common'}` 与 `infrastructure`。`SearchService` 位于
 *   `modules/common`（而非 infrastructure）属既有架构事实，它是端口的薄门面，
 *   不构成跨 bounded context 依赖。
 *
 * `TypeOrmSearch.applyTextSearch()` 已实现「命名参数化 + `%` / `_` / `\` 转义」，
 * `executeOffsetPagination()` 已实现「同一 QueryBuilder 克隆出分页查询与 COUNT 查询」，
 * 因此 `total` 与 `items` 天然来自同一筛选条件，且不存在全量加载后内存分页的路径。
 *
 * **必须走 entity 水合路径（`getMany()` / `findOne()`），禁止 `getRawMany()`**：
 * `meta_digest` 是 varchar(1024) 的**加密列**（`AccountFieldEncryptionRegistrar` 注册
 * `registerEncryptedField(UserInfoEntity, 'metaDigest')`），只有
 * `FieldEncryptionSubscriber.afterLoad` → `FieldEncryptionService.decryptEntity()` 才会把它解密
 * 并 `JSON.parse` 回数组；TypeORM 的 `broadcastLoadEvent()` 会递归进已加载的 relation，
 * 所以 `leftJoinAndSelect('account.userInfo', …)` + `getMany()` 能拿到解密后的数组，
 * 而 `getRawMany()` 拿到的是密文字符串，会让三源收敛对**每一行**都失败。
 */
@Injectable()
export class AdminUserQueryService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    private readonly searchService: SearchService,
  ) {}

  /**
   * 管理员用户列表：筛选、模糊搜索、统计、分页与排序全部下推数据库。
   *
   * 同一个唯一角色**时，**整次查询失败**——不返回部分列表、不排除该行、不跳过异常账号、
   * 不选任一源字段兜底、不静默修复、不引入 `excludedCount`。两类异常均映射
   * `INTERNAL_SERVER_ERROR`，但错误码不同：资料行缺失是 `ADMIN_USER_ERROR.READ_FAILED`
   * （`diagnostic: 'USER_INFO_ROW_MISSING'`），三源不收敛是 `ROLE_DATA_INCONSISTENT`。
   * 两类判定都由 `toAdminUserView()` 一处持有，本方法不重复实现。
   * 对外只抛错误码与通用文案，
   * `details` 刻意留空：全局过滤器会把 `details` 原样写入 `extensions.details`，
   * 放入异常账号 ID、三源角色原值或收敛失败原因都会违反「不向前端暴露内部错误细节」。
   * 定位所需的最小信息（账号主键 + 失败原因分类）放在 `DomainError.cause`，
   * 过滤器不序列化 `cause`，由 Usecase 决定如何记录日志。
   *
   * @param query 已由 Usecase 完成场景规范化、白名单收敛与分页钳制的查询入参
   */
  async listAdminUsers(query: AdminUserListQuery): Promise<AdminUserListPage> {
    const filters: Record<string, string> = {};
    if (query.role !== undefined) {
      filters.role = query.role;
    }
    if (query.status !== undefined) {
      filters.status = query.status;
    }

    // LEFT JOIN 而非 INNER JOIN：资料行缺失的账号必须被**加载**出来，把缺失事实带到
    // `toAdminUserView()` 触发整次失败关闭。INNER JOIN 会让这类账号在 SQL 层被静默排除，
    // 既不出现在 items 也不计入 total ⇒ 等于「跳过异常账号 + 返回部分列表」，
    // LEFT JOIN 不放大行数，因此 total 与 items 仍来自同一筛选与分页口径。
    const qb = this.accountRepository
      .createQueryBuilder('account')
      .leftJoinAndSelect('account.userInfo', 'userInfo');

    // 组织范围由 Usecase 经可信组织解析后以账号 ID 清单下推：account 域不跨域导入组织
    // Entity，也不接受客户端自报组织。空数组直接返回空页，**不得**退化为「不筛选」——
    // 那会把「没有可见账号」静默变成「全库账号」。
    if (query.accountIds !== undefined) {
      if (query.accountIds.length === 0) {
        return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
      }
      qb.andWhere('account.id IN (:...accountIds)', { accountIds: [...query.accountIds] });
    }

    let searchResult: SearchResult<AccountEntity>;
    try {
      searchResult = await this.searchService.search<AccountEntity>({
        qb,
        params: {
          query: query.keyword,
          filters,
          pagination: {
            mode: 'OFFSET',
            page: query.page,
            pageSize: query.pageSize,
            // 管理页面依赖 total 渲染服务端分页，因此这里恒定开启，不提供 withTotal 开关
            withTotal: true,
          },
        },
        options: ADMIN_USER_LIST_SEARCH_OPTIONS,
      });
    } catch (error) {
      // 引擎会把底层异常包成 `PAGINATION_ERROR.DB_QUERY_FAILED` 且把原始数据库错误文本放进
      // `details`，而 `buildGraphQLErrorFromDomainError()` 不区分环境、会把 `details` 直接写入
      // `extensions.details`。这里统一收敛为管理员场景的读失败码并丢弃 details，
      // 原始异常仅以 `cause` 保留供服务端排查（`cause` 不进 extensions）。
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '用户列表读取失败，请稍后重试',
        undefined,
        error,
      );
    }

    // ROLE_DATA_INCONSISTENT / READ_FAILED 必须原样冒泡。若纳入上面的 try，会被其 catch
    // 重包为 READ_FAILED，既改变对外 errorCode，也使 `ListAdminUsersUsecase` 针对收敛失败的
    // 专门日志分支失效。映射阶段抛错即整次失败：`items` 不会被部分返回给调用方。
    const items = searchResult.items.map((account) => this.toAdminUserView(account));

    const total = searchResult.total;
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      // 契约退化，不得以 0 静默兖底——那会让前端把服务端故障渲染成「共 0 条用户」。
      // 放得过 `NaN`，而 NaN 作为 total 传给前端同样会破坏分页渲染。
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '用户列表读取失败，请稍后重试',
        undefined,
        { diagnostic: 'SEARCH_TOTAL_MISSING' },
      );
    }

    return {
      items,
      total,
      page: searchResult.page ?? query.page,
      pageSize: searchResult.pageSize ?? query.pageSize,
    };
  }

  /**
   *
   * 供 `AdminCreateUserUsecase` 在**同一事务内**回读刚创建的账号，因此必须接受
   * `transactionContext`；不在事务内调用时读取的是已提交数据。
   *
   * @returns 账号不存在时返回 `null`（由 Usecase 决定错误口径）；账号存在但资料行缺失，
   *   或三源角色不能收敛时失败关闭抛错——这两种都是数据不变量被破坏，不是「查无此人」。
   */
  async findAdminUserViewById(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<AdminUserView | null> {
    try {
      const account = await this.getAccountRepository(params.transactionContext).findOne({
        where: { id: params.accountId },
        relations: { userInfo: true },
      });
      if (!account) {
        return null;
      }
      return this.toAdminUserView(account);
    } catch (error) {
      this.rethrowAsReadFailure(error, '用户账号读取失败，请稍后重试');
    }
  }

  /**
   *
   * 为什么独立于 `findAdminUserViewById()`：第一版状态转换矩阵要求在**任何状态写入前**
   * 读取 `account.status` 与 `userInfo.user_state` 的当前值并裁决一致性与可转换性，
   * 本方法只服务 `AdminSetUserStatusUsecase`，返回普通数据，不返回 ORM Entity /
   * QueryBuilder（`queryservice.rules.md`）。
   *
   * 走 entity 水合路径（`findOne` + relation），与本文件「禁止 `getRawMany()`」的
   * 既有约束同源：虽然 `status` / `user_state` 都不是加密列，但保持单一读取惯例，
   * 避免出现第二套「绕过订阅者」的查询路径。
   *
   * @returns 账号行或资料行任一缺失时返回 `null`（由 Usecase 决定错误口径）。
   *   两行都在前置 `loadWritableAdminUserTarget()` 阶段已被验证存在，`null` 在本路径
   *   属纵深防御，不承载「查无此人」语义。
   */
  async findAdminUserStatusFacts(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<AdminUserStatusFacts | null> {
    try {
      const account = await this.getAccountRepository(params.transactionContext).findOne({
        where: { id: params.accountId },
        relations: { userInfo: true },
      });
      if (!account || !account.userInfo) {
        return null;
      }
      return { accountStatus: account.status, userState: account.userInfo.userState };
    } catch (error) {
      this.rethrowAsReadFailure(error, '用户账号读取失败，请稍后重试');
    }
  }

  /**
   * 登录凭据唯一性**预检查**：返回被占用的凭据维度，供 Usecase 组织友好错误。
   *
   * 数据库现有唯一索引 `uk_login_name` / `uk_login_email` 继续作为并发竞争的最终裁决，
   * 命中后由 `AccountService.insertAccount()` 在 ORM 边界收敛为 `CREDENTIAL_CONFLICT`。
   * 因此「预检查通过但插入冲突」是预期路径，不是缺陷。
   *
   * 两个凭据分别判定（而不是复用 `AccountQueryService.checkAccountExists()` 的布尔结果），
   * 因为管理员创建的口径是「登录名与登录邮箱至少一个」，两列均可为 `null`，
   * 且友好文案需要区分是哪一维冲突；理由详见 `AdminUserCredentialConflictField` 注释。
   *
   * @returns 未被占用时返回 `null`；两维都被占用时优先返回 `loginName`
   *   （一次只提示一个原因，避免把两个已占用账号的存在同时暴露给调用方）
   */
  async findAdminUserCredentialConflict(params: {
    loginName: string | null;
    loginEmail: string | null;
  }): Promise<AdminUserCredentialConflictField | null> {
    try {
      if (
        params.loginName !== null &&
        (await this.accountRepository.existsBy({ loginName: params.loginName }))
      ) {
        return 'loginName';
      }
      if (
        params.loginEmail !== null &&
        (await this.accountRepository.existsBy({ loginEmail: params.loginEmail }))
      ) {
        return 'loginEmail';
      }
      return null;
    } catch (error) {
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '登录凭据可用性检查失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 账号 + 资料 → 稳定 `AdminUserView` 的唯一映射点。
   *
   * 字段口径见 `AdminUserView` 注释：`contactEmail` 取 `base_user_info.email`（联系邮箱），
   * 与 `loginEmail`（`base_user_account.login_email`，登录凭据）严格区分；
   * `updatedAt` 取账号侧与资料侧的较新值。
   *
   * 刻意**不含**密码 / 密码哈希 / `metaDigest` / Access Token / Refresh Token /
   * 不使用 `{ ...account }` 之类展开，因此新增敏感列不会自动流入 View。
   */
  private toAdminUserView(account: AccountEntity): AdminUserView {
    const userInfo: UserInfoEntity | undefined = account.userInfo;
    if (!userInfo) {
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '用户账号资料缺失，无法生成用户视图',
        undefined,
        { diagnostic: 'USER_INFO_ROW_MISSING', accountId: account.id },
      );
    }

    const convergence = convergeAccountRole({
      identityHint: account.identityHint,
      accessGroup: userInfo.accessGroup,
      metaDigest: userInfo.metaDigest,
    });
    if (!convergence.converged) {
      throw new DomainError(
        ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        '用户账号数据异常，暂时无法加载用户信息',
        undefined,
        {
          diagnostic: 'ROLE_CONVERGENCE_FAILED',
          accountId: account.id,
          reason: convergence.reason,
        },
      );
    }

    return {
      id: account.id,
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      nickname: userInfo.nickname,
      companyName: userInfo.companyName,
      phone: userInfo.phone,
      contactEmail: userInfo.email,
      role: convergence.role,
      status: account.status,
      createdAt: account.createdAt,
      updatedAt: this.resolveUpdatedAt(account.updatedAt, userInfo.updatedAt),
    };
  }

  /**
   * `ADMIN_USER_ERROR.READ_FAILED` 并以原始异常为 `cause`（过滤器不序列化 `cause`）。
   * `findAdminUserViewById()` 与 `findAdminUserStatusFacts()` 共用，不各写一份 catch。
   *
   * 用 isDomainError() 而非裸 instanceof：全仓 catch 块统一使用该判据
   * （instanceof + `name` / `code` 鸭子类型双判据），比裸 instanceof 更宽，
   */
  private rethrowAsReadFailure(error: unknown, message: string): never {
    if (isDomainError(error)) {
      throw error;
    }
    throw new DomainError(ADMIN_USER_ERROR.READ_FAILED, message, undefined, error);
  }

  /**
   * `updatedAt` 取账号侧与资料侧 `updated_at` 的较新值，
   * 使资料编辑与状态修改都反映为同一个「最近变更时间」。
   *
   * 自动维护，假定为合法 `Date`；若出现 `Invalid Date`（`getTime()` 返回 `NaN`），
   * 本比较会静默取账号侧值，不在此做额外校验——该形态属系统侧故障，应由写入链路
   * 与数据库层暴露，而非读映射层兼修。
   */
  private resolveUpdatedAt(accountUpdatedAt: Date, userInfoUpdatedAt: Date): Date {
    return userInfoUpdatedAt.getTime() > accountUpdatedAt.getTime()
      ? userInfoUpdatedAt
      : accountUpdatedAt;
  }

  private getAccountRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AccountEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(AccountEntity)
      : this.accountRepository;
  }
}
