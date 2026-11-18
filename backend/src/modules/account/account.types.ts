import type {
  AccountStatus,
  IdentityTypeEnum,
  LoginHistoryItemModel,
} from '@app-types/models/account.types';
import type { UserState } from '@app-types/models/user-info.types';

export interface AccountSnapshot {
  readonly id: number;
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly status: AccountStatus;
  readonly identityHint: string | null;
  readonly recentLoginHistory: LoginHistoryItemModel[] | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AccountCredentialSnapshot {
  readonly id: number;
  readonly status: AccountStatus;
  readonly loginPassword: string;
  readonly createdAt: Date;
  /**
   * 是否被要求先修改密码（`base_user_account.must_change_password`）。
   * 凭据式入口据此拒绝「改密前」的其他操作，口径与 JWT 会话的
   * `MUST_CHANGE_PASSWORD` 限制一致。
   */
  readonly mustChangePassword: boolean;
}

/**
 * 账号对外展示信息快照（只读公开字段：安全昵称 + 所属公司名称）。
 * 供管理员文档数据库等跨域读模型批量富集展示信息，不含任何敏感字段。
 * 昵称经空白收敛：空白视为缺失（null），与 findNicknamesByAccountIds 口径一致。
 */
export interface AccountDisplayInfo {
  readonly nickname: string | null;
  readonly companyName: string | null;
}

export interface AccountSecurityUserInfoSnapshot {
  readonly accessGroup: IdentityTypeEnum[] | null;
  readonly metaDigest: IdentityTypeEnum[] | null;
}

export interface AccountSecuritySubjectSnapshot {
  readonly id: number;
  readonly userInfo: AccountSecurityUserInfoSnapshot;
}

export interface AccountLoginBootstrapSnapshot {
  readonly account: {
    readonly id: number;
    readonly loginName: string | null;
    readonly loginEmail: string | null;
    readonly status: AccountStatus;
    readonly identityHint: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly userInfo: {
    readonly id: number;
    readonly accountId: number;
    readonly nickname: string | null;
    readonly avatarUrl: string | null;
    readonly accessGroup: IdentityTypeEnum[] | null;
    readonly metaDigest: IdentityTypeEnum[] | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
}

/**
 * 管理员用户管理：普通用户可写的单一业务角色值域。
 *
 * - 普通用户只能拥有 `ENGINEER` 或 `CUSTOMER` 中的一个业务角色；
 * - `SUPER_ADMIN` 不在可写值域内，只允许作为只读查询结果出现；
 * - 刻意显式列出成员，而不是使用 `IdentityTypeEnum` 整体别名：将来枚举新增成员时，
 *   本值域不会自动放宽，必须由负责人显式决策（失败关闭方向）；
 * - 本文件只声明稳定类型；运行时白名单数组属于业务授权决策，
 *   由 `src/usecases/account/admin-user-permission.ts` 单点持有，不下沉到 modules。
 */
export type AdminUserWritableRole = IdentityTypeEnum.ENGINEER | IdentityTypeEnum.CUSTOMER;

/**
 * 管理员用户列表的角色筛选值域（任务 08.4 起只允许普通账号）。
 *
 * 新版页面只读普通客户与工程师，不再暴露 `SUPER_ADMIN` 筛选；管理员账号
 * 即使出现在存量数据中也不进入列表。与可写角色值域仍分开声明。
 *
 * 同样显式列出成员：纯别名（`= IdentityTypeEnum`）在结构上与枚举完全等价，
 * 既不提供任何收窄，也会在枚举扩容时静默扩大筛选值域。
 */
export type AdminUserListRoleFilter = IdentityTypeEnum.ENGINEER | IdentityTypeEnum.CUSTOMER;

/**
 * 管理员列表的可见角色范围：与筛选值域同源但**独立声明**。
 *
 * 筛选是调用方可选的动作，可见范围是服务端强制的读面下推；两者一旦共用同一数组，
 * 任何一侧的演进都会静默改变另一侧。当前成员相同（仅普通账号），必须各自显式修改。
 */
export type AdminUserVisibleRole = IdentityTypeEnum.ENGINEER | IdentityTypeEnum.CUSTOMER;

/**
 * 管理员可写账号状态值域：第一版只开放 `ACTIVE` / `INACTIVE`。
 *
 * `PENDING`、`SUSPENDED`、`BANNED`、`DELETED` 不是管理员页面可写值；
 * 绕过前端提交这些值必须由后端拒绝。账号不做硬删除。
 *
 * 写入约束指引：状态写入是**双字段同步**——启用须同时置
 * `base_user_account.status = ACTIVE` 且 `base_user_info.user_state = ACTIVE`，停用同理
 * P0-5 用例职责；漏写 `user_state` 会造成「页面显示已启用、受保护请求仍被判失效」的
 * `userState`，管理员页面无法自行发现原因。
 */
export type AdminUserWritableStatus = AccountStatus.ACTIVE | AccountStatus.INACTIVE;

/**
 * 管理员用户列表的状态筛选值域。
 *
 * 第一版成员与 `AdminUserWritableStatus` 相同，但**刻意独立声明**（与角色的处理方式对称）：
 * 读筛选值域与写入值域一旦在类型层焊死，任何一侧的合理演进都会静默改变另一侧——
 * 开放写入 `SUSPENDED` 会让筛选自动获得该能力（未经产品决策），反之为「筛出存量
 * `PENDING` 账号」放宽筛选会同时放宽写入白名单，属于授权面被动扩大。
 */
export type AdminUserListStatusFilter = AccountStatus.ACTIVE | AccountStatus.INACTIVE;

/**
 * 管理员用户管理稳定读视图：**同时服务列表、详情与写后读**，不另建详情 View
 * 由 account QueryService 产出，Usecase 原样返回，adapter 薄映射为 GraphQL DTO。
 *
 * 产出前提（P0-2 必须遵守，R1 裁决；JOIN 口径经 R6 修正）：
 * - 采用 `base_user_account` LEFT JOIN `base_user_info`，且**资料行缺失即整次失败关闭**：
 *   `nickname` 是 NOT NULL 列，能成功返回的 View 必然已确认资料行存在，因此 `nickname`
 *   可安全声明为非空。刻意不用 INNER JOIN——那会让资料行缺失的账号在 SQL 层被静默
 *   排除（items 与 total 都不含它），等于跳过异常账号并返回部分列表，违反 12.6 R3-1；
 * - `role` 的三源收敛（`identity_hint` / `access_group` / `meta_digest` → 单一角色）
 *   实现归属 **`src/core/account/policy/` 下的单一纯函数**，P0-2（View 产出）与
 *   角色映射）。落点依据（R1 修正）：View 由 QueryService 产出，而 eslint
 *   `no-queryservice-to-mixed-service-imports` 禁止 QueryService 依赖 `base/services/` 下的
 *   普通 Service，因此**不能**以扩展 `AccountSecurityService.validateAccessGroupConsistency()`
 *   作为 View 侧实现路径（那会让 P0-2 走进死胡同，或迫使它另写一份）；
 *   `core/account/policy/` 是 QueryService、modules service 与 usecases 三方都能依赖的
 *   纯函数层，precedent 为 `role-access.policy.ts` 与 `user-info-visibility.policy.ts`
 *   （二者已被 `account.query.service.ts` 直接导入）。既有 `validateAccessGroupConsistency()`
 *   只做 accessGroup ↔ metaDigest 两源比对、不含 `identity_hint`，仅可作算法参考，不作归属地。
 *   按 `core.rules.md`「只有稳定且有生产调用点的规则才沉淀为 core policy」，该 policy 必须在
 *   P0-2 首次落地时就带上生产调用点；
 * - **三源收敛失败（三源不一致、`access_group` 非单元素、摘要非法）的口径已由负责人裁决为
 *   对外只表达通用 `INTERNAL_SERVER_ERROR`；不返回部分列表、不选任一源字段兜底、不静默修复、
 *   不排除异常行、不引入 `excludedCount`、不向前端暴露异常账号 ID / 三源角色原值 / 内部错误细节
 *   （`DomainError.details` 必须为空）。需求没有要求管理员页面展示「异常数据被跳过数量」，
 *   因此本类型不提供任何此类通道，P0-2 不得自行新增 GraphQL 字段、View 字段或前端提示。
 *
 * 字段口径：
 * - `contactEmail` 映射 `base_user_info.email`（可选联系邮箱），
 *   与 `loginEmail`（`base_user_account.login_email`，登录凭据邮箱）严格区分，不得互相代替；
 * - `status` 是账号真实状态（`base_user_account.status`）。管理页面只写入 ACTIVE/INACTIVE，
 *   但已有 `SUPER_ADMIN` 行仍按其真实状态只读展示，因此这里保留完整 `AccountStatus`；
 * - 刻意不含 `userState`：`user_state` 由 P0-5 与 `status` 同事务双写保持一致，
 *   不作为管理员可独立操作的字段暴露，避免出现第二个状态真源；
 * - `createdAt` 取账号创建时间；`updatedAt` 取账号侧与资料侧 `updated_at` 的较新值，
 *   使资料编辑与状态修改都能反映为同一个「最近变更时间」；
 *   两者均为 `TIMESTAMP(3)` 系统事件时间，按时间字段规范映射为 `Date`；
 * - 只读语义不在本视图内冗余表达：`role === SUPER_ADMIN` 即只读，
 *   由前端 application 单点派生展示策略（R1 裁决：不设 `readOnly` 字段），
 *   后端仍是权限真源，避免出现第二份只读规则。
 *
 * 严禁出现：`loginPassword` 或任何密码哈希、`metaDigest`、Access/Refresh Token、
 */
export interface AdminUserView {
  readonly id: number;
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly nickname: string;
  readonly companyName: string | null;
  readonly phone: string | null;
  readonly contactEmail: string | null;
  readonly role: IdentityTypeEnum;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 审批详情专用的申请人读模型（最小面）。
 *
 * 为什么不复用 `AdminUserView`：审批决策需要展示**真实姓名**（`base_user_info.real_name`），
 * 而 `AdminUserView` 是列表 / 写后读共用的稳定视图，扩大它会同时放大所有消费面的字段面；
 * 且真实姓名对列表并非必需。因此单列一个仅供审批详情读取的窄视图，由
 * `AdminUserQueryService.findAdminUserDetailViewById()` 产出。
 *
 * - 刻意不含 `role` / `status` / 时间戳：审批详情消费的是申请状态，不是账号角色；
 * - 刻意不含角色三源收敛：详情读取只需展示资料，角色异常不应让详情不可读；
 * - `realName` 允许为 `null`（旧数据可能未填），消费方必须显式按空展示，
 *   **不得用 `nickname` 冒充真实姓名**；
 * - 严禁出现密码 / 密码哈希、`metaDigest`、Token 或任何凭据字段。
 */
export interface AdminApplicantDetailView {
  readonly id: number;
  readonly loginName: string | null;
  readonly nickname: string;
  readonly realName: string | null;
  readonly phone: string | null;
  readonly contactEmail: string | null;
}

/**
 * 管理员状态写用例（P0-5）专用的**窄内部事实**：账号侧状态与资料侧用户状态的当前值
 *
 * 为什么不并入 `AdminUserView`：`user_state` 不是管理员可独立操作的字段，
 * 避免出现第二个状态真源）；但转换矩阵需要它的当前事实，因此单独定义本类型，
 * 由 `AdminUserQueryService.findAdminUserStatusFacts()` 产出、仅被
 * `AdminSetUserStatusUsecase` 消费，不进入任何 GraphQL DTO。
 *
 * - 只含两个状态字段，不含任何身份 / 资料字段，防止事实读取演化为第二条 View 通道；
 * - `accountStatus` / `userState` 各自保持其所属枚举类型；两枚举成员字符串当前
 *   逐字相同但类型不同，一致性比对由用例显式按值进行，不做断言复用；
 * - 这是普通数据（plain object），不是 ORM Entity / QueryBuilder
 *   （`queryservice.rules.md`：QueryService 对上游只返回稳定数据）。
 */
export interface AdminUserStatusFacts {
  readonly accountStatus: AccountStatus;
  readonly userState: UserState;
}

/**
 * 二级管理员写目标归属复核所需的窄内部事实（V5.5 R012-01）。
 *
 * 客户以 `base_user_info.customer_organization_id` 为真实归属，工程师以本公司有效的
 * 工程师成员关系为准；因此写路径必须先拿到**收敛后的目标角色**与客户归属列，
 * 再按角色分别核验，不能用成员关系表统一代替两条来源。
 *
 * 只含定位归属所需的最小字段：不包含昵称、联系方式、密码派生值或任何 Token。
 * 角色三源无法收敛时不返回本类型（调用方按目标不存在失败关闭），避免把异常角色
 * 当作可写目标。
 */
export interface AdminUserOwnershipFacts {
  readonly role: IdentityTypeEnum;
  readonly customerOrganizationId: number | null;
}

/**
 * 管理员用户列表查询入参：筛选与分页的**单一契约**，已由 Usecase 完成场景规范化
 * 与白名单收敛后传入 QueryService。
 *
 * - `page` / `pageSize` 是**必填**项（`page` 从 1 开始，`pageSize` 上限由 Usecase 层统一钳制）：
 *   管理列表不存在「不带分页的查询」，因此 R1 裁决删除原独立的 `AdminUserListPagination`
 *   （它无生产者也无消费者，是必然漂移的孤儿契约）；也不复用 `@core/pagination` 的
 *   且 `total` 必须返回，在结构上禁止这两个入参比运行时校验更可靠；
 * - `keyword`：trim 后非空才对登录名、登录邮箱、昵称做参数化模糊搜索；缺省表示不搜索；
 * - `role` / `status`：缺省表示不按该维度筛选；
 * - 排序由契约固定（`created_at DESC, id DESC`），不接受客户端排序字段，
 *   避免把未约束字段名传入 QueryBuilder；
 * - 筛选、统计与分页必须由数据库执行，禁止全量读取后在上层分页。
 */
export interface AdminUserListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly keyword?: string;
  readonly role?: AdminUserListRoleFilter;
  readonly status?: AdminUserListStatusFilter;
  /**
   * 二级管理员的组织范围（V5.5 R012-01），由 Usecase 经可信组织解析后下推。
   *
   * 范围按目标真实角色分两条来源，**不能用统一的成员 ID 清单替代**：
   * - 客户：`base_user_info.customer_organization_id = organizationId`；
   * - 工程师：`account.id` 命中 `engineerAccountIds`（本公司有效工程师成员关系）。
   *
   * `undefined` = 不按组织收窄（一级管理员全范围）。
   * `engineerAccountIds` 为空时仍需保留客户条件，所以**不能**据此返回空页。
   *
   * 用 ID 而非组织 Entity：account 域 QueryService 不跨域导入组织 Entity
   * （`modules.rules.md`），组织事实由 lithography 域 QueryService 解析。
   */
  readonly organizationScope?: {
    readonly organizationId: number;
    readonly engineerAccountIds: ReadonlyArray<number>;
  };
  /**
   * 可见角色范围（任务 08.4）：只列出该值域内的账号。
   *
   * - `undefined` = 不按角色收窄；
   * - 空数组 = 范围为空，直接返回空页（与 `accountIds` 同口径）；
   * - 条件与分页 / COUNT 共用同一 QueryBuilder，因此 `total` 与 `items` 同源，
   *   不存在「先分页再过滤」导致的总数泄漏。
   */
  readonly visibleRoles?: ReadonlyArray<AdminUserVisibleRole>;
}

/**
 * 管理员用户列表分页结果：只包含 `items` / `total` / `page` / `pageSize` 四项。
 *
 * - `total`：同一筛选条件下的**数据库行总数**，管理页面依赖它渲染服务端分页，故为必填
 *   （R1 裁决：不用 `withTotal` 开关，也不沿用既有 `RepairRequestListPage.total?` 的可选形态）；
 * - `items` 用 `ReadonlyArray`：本类型是只读 View，且既有 QueryService 存在把 ORM 实体数组
 *   直接别名进快照的写法，只读约束可阻断消费方原地修改被 TypeORM 脏检查持久化的路径；
 * - **刻意不含任何「被跳过的异常行数量」字段**：需求未要求管理员页面展示该信息。
 *   不排除异常行，因此不存在「部分行被跳过」的语义需要表达，本类型不得扩展 `excludedCount`
 *   或任何等价字段；`total` 与 `items` 必须来自同一筛选条件并由数据库同一次查询统计与分页。
 */
export interface AdminUserListPage {
  readonly items: ReadonlyArray<AdminUserView>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * 管理员创建时的登录凭据冲突维度：告知调用方**哪一个**凭据已被占用，
 * 仅用于组织友好错误文案，不携带已占用者的任何身份信息。
 *
 * 为什么不复用 `AccountQueryService.checkAccountExists()`：该方法把 `loginEmail` 声明为
 * **必填** `string` 并只返回一个布尔值，而管理员创建的凭据口径是「登录名与登录邮箱至少一个」
 * （两列均可 `null`），且友好错误需要区分冲突维度；强行复用会对「只填登录名」的入参
 * 调用 `normalizeEmail(null)`，并把两个维度的冲突塌缩成同一个提示。
 */
export type AdminUserCredentialConflictField = 'loginName' | 'loginEmail';

/**
 * 账号插入的稳定事实结果（modules service → usecase）。
 *
 * 刻意**不返回 `AccountEntity`**：`usecase.rules.md` 明确「Usecase 不得 import 或短暂持有
 * ORM Entity」，而既有 `AccountService.saveAccount()` 返回的正是 Entity（本轮回改它会连带
 * 改变注册链路的错误口径，故保留不动）。本类型只给出后续编排所需的最小事实：
 *
 * - `CREATED`：插入成功。`accountId` 用于同事务内接着写 `base_user_info`；
 *   `createdAt` 是密码哈希的盐（`AccountService.hashPasswordWithTimestamp()` 以它为时间盐），
 *   因此必须从已保存结果回读，不得在用例侧自行 `new Date()` 另算一份；
 * - `CREDENTIAL_CONFLICT`：命中 `uk_login_name` / `uk_login_email` 唯一索引。
 *   驱动错误、SQL 与索引名一律**不**上行（仅以 `DomainError.cause` 在 modules 内部保留），
 *   由用例转换为 `ADMIN_USER_ERROR.CREDENTIAL_CONFLICT`（对外大类 `CONFLICT`）。
 *
 * 采用「返回事实对象而不抛错」的 precedent：`RepairRequestService.softDeleteRequest()`。
 * 之所以不在此直接抛 `DomainError`：唯一索引无法告知具体是哪一列冲突（MySQL 错误文本里
 * 才带索引名，向上透出等于泄露存储细节），因此只表达「冲突了」，
 * 具体友好文案由用例结合事务前的预检查结果组织。
 */
export type AccountCreateOutcome =
  | {
      readonly kind: 'CREATED';
      readonly accountId: number;
      readonly createdAt: Date;
    }
  | {
      readonly kind: 'CREDENTIAL_CONFLICT';
    };

/**
 * 受保护请求的账号权限事实快照：由 account QueryService 单语义读取，
 * 供 `ValidateAccessTokenSessionUsecase`（P0-7）复核数据库当前状态与角色，不返回 ORM Entity。
 *
 * 形状采用**嵌套 `userInfo`**（R1 裁决）：把账号侧事实（`accountStatus` / `identityHint`）与
 * 资料侧事实（`userState` / `accessGroup` / `metaDigest`）按来源列分组，使「资料行整体缺失」
 * 在结构上不可漏判（`userInfo: null` 一个判定点，而不是三个字段各自为 `null`），
 * 并与既有 `AccountSecurityUserInfoSnapshot` 的分组口径一致，P0-7 读代码时无需猜字段归属。
 *
 * 刻意**不**以「适配 `AccountSecuritySubjectSnapshot` + 调用
 * `AccountSecurityService.validateAccessGroupConsistency()`」作为 P0-7 的实现路径（R1 修正）：
 * 该方法只做 accessGroup ↔ metaDigest 两源比对、不含 `identity_hint` 第三源，用
 * `JSON.stringify` 做顺序敏感比较，且带 PinoLogger 副作用（对遗留脏数据会打
 * `SECURITY_BREACH_DETECTED` 级安全事件日志），且位于 `base/services/` 内；而 P0-7 需要的是
 * 无副作用、覆盖三源、失败关闭为 `UNAUTHENTICATED` 的纯判断。三源收敛的唯一实现见下条。
 *
 * 产出时必须对两个数组做**显式拷贝**（`[...]`）：既有 QueryService 存在把 ORM 实体数组
 * 直接别名进快照的写法，拷贝既满足本类型的 `ReadonlyArray` 约束，也断开实体别名，
 * 避免消费方的原地修改被 TypeORM 脏检查持久化。
 *
 * - `accountStatus` 为 `null` 表示 `base_user_account` 记录缺失；
 * - `userInfo` 为 `null` 表示 `base_user_info` 记录缺失。这与 `getLoginBootstrapSnapshot()`
 *   遇缺失即抛 `USER_INFO_NOT_FOUND` 的口径**不同**：本快照用 `null` 表达缺失，
 * - `identityHint` 属账号侧列（`base_user_account.identity_hint`），故置于顶层而非 `userInfo` 内；
 * - `accessGroup` / `metaDigest` 一律按数据库原值给出，不做补全、猜测或修复。
 *   **消费方必须保留 `Array.isArray` 运行时守卫**：`meta_digest` 实际是 varchar(1024) 列，
 *   既有 `account-security.service.ts` 至今仍对非数组值记录「格式无效，应为数组」并失败关闭，
 *   说明遗留数据可能不是数组；若省略守卫，TypeError 会冒泡成 `INTERNAL_SERVER_ERROR`，
 * - 三者不能表达同一个唯一有效角色时由调用方失败关闭；收敛实现归属
 *   `src/core/account/policy/` 下的单一纯函数，与 `AdminUserView.role` 共用同一实现
 *   （归属依据见该类型注释），不得在 usecases 侧再写一份；
 * - 快照只表达事实，不含权限结论；裁决顺序与错误口径归调用方 Usecase；
 * - **本快照仅供服务端内部复核，任何字段都不得经 View / DTO 外泄**
 */
export interface AccountSessionAuthoritySnapshot {
  readonly accountId: number;
  readonly accountStatus: AccountStatus | null;
  readonly identityHint: string | null;
  /** `base_user_account.must_change_password`（账号行缺失时为 false） */
  readonly mustChangePassword: boolean;
  /** `base_user_account.admin_level`（1 / 2 / null） */
  readonly adminLevel: number | null;
  readonly userInfo: {
    readonly userState: UserState | null;
    readonly accessGroup: ReadonlyArray<IdentityTypeEnum> | null;
    readonly metaDigest: ReadonlyArray<IdentityTypeEnum> | null;
    /** `base_user_info.customer_organization_id`（可信公司归属） */
    readonly customerOrganizationId: number | null;
  } | null;
}

/**
 * 当前用户账号设置（自助场景）的**内部窄事实快照**：由 account QueryService 单语义读取、
 * 完成三源角色收敛与双字段状态一致性判定后产出，仅供 `GetMyAccountSettingsUsecase` 消费，
 * 不进入任何 GraphQL DTO。
 *
 * 为什么不直接把 `MyAccountSettingsView` 交给 Usecase：本快照刻意比对外 View 多带一个
 * `accountId`——它是 Session 已认证的可信账号主键，只用于 Usecase 侧的结构化日志定位
 * （写入 `DomainError.cause` / PinoLogger），**绝不外泄到响应**。把「携带 accountId 的内部事实」
 * 与「不含 accountId 的公开读模型」拆成两个类型，使「不暴露目标 accountId」成为编译期结构约束
 * 而非口头纪律：公开 View 上根本不存在该字段，adapter 无从映射。
 *
 * 字段口径与 `AdminUserView` 同源但**独立命名**（不复用 admin
 * 命名的 View）：`role` 是三源收敛后的单值只读角色；`status` 是账号真实状态
 * （`base_user_account.status`，已与 `base_user_info.user_state` 双写一致，不一致即失败关闭，
 * 见 `findMyAccountSettingsSnapshot()`）；`contactEmail` 映射 `base_user_info.email`（联系邮箱），
 * 与 `loginEmail`（`base_user_account.login_email`，登录凭据）严格区分。
 *
 * 这是普通数据（plain object），不是 ORM Entity / QueryBuilder
 * （`queryservice.rules.md`：QueryService 对上游只返回稳定数据）。
 */
export interface MyAccountSettingsSnapshot {
  readonly accountId: number;
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly nickname: string;
  /** `base_user_info.real_name`：真实姓名（可空，与昵称分开） */
  readonly realName: string | null;
  readonly companyName: string | null;
  readonly phone: string | null;
  readonly contactEmail: string | null;
  readonly role: IdentityTypeEnum;
  readonly status: AccountStatus;
  /** `base_user_account.admin_level`（1 / 2 / null） */
  readonly adminLevel: number | null;
  readonly updatedAt: Date;
}

/**
 * 缺归属客户补录（任务 02.4）的锁内最小事实。
 *
 * 只承载「是否已有可信公司归属」这一判定所需字段：账号行与资料行已由调用方按
 * 「account 优先、资料随后」顺序加排他锁，本类型不表示任何权限结论。
 */
export interface CustomerCompanyBindingFacts {
  readonly accountId: number;
  /** `base_user_info.customer_organization_id`：客户可信公司归属（可空） */
  readonly customerOrganizationId: number | null;
}

/**
 * 当前用户账号设置（自助场景）的**稳定公开读视图**：由 `GetMyAccountSettingsUsecase` 从
 * `MyAccountSettingsSnapshot` 剥离内部字段后产出，Usecase 原样返回，adapter 薄映射为 GraphQL DTO。
 *
 * 服务 `myAccountSettings` 只读 Query（P1，契约见 `docs/api/account-write-current.md`）。该 Query 无任何输入
 * 参数，目标账号只能来自已认证 Session，因此本 View **刻意不含 `accountId`**（负责人明确要求
 * 「不暴露目标 accountId」；客户端已从登录结果获知自己的 accountId，无需由本视图回显）。
 *
 * `role` / `status` 均为**只读展示字段**：本功能不提供任何角色或状态写入入口，前端不渲染可编辑
 * 控件，后端仍是权限真源。
 *
 * 严禁出现：`accountId`、`loginPassword` 或任何密码哈希、`metaDigest`、完整 `accessGroup`、
 * Access/Refresh Token、`identityHint`、`userState`、任何内部诊断字段。映射点使用逐字段显式赋值，
 * 不使用 `{ ...snapshot }` 展开，因此新增敏感列不会自动流入 View。
 */
export interface MyAccountSettingsView {
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly nickname: string;
  /** `base_user_info.real_name`：真实姓名（可空） */
  readonly realName: string | null;
  readonly companyName: string | null;
  /** 可信公司名称：按当前角色解析出的组织名称；无归属或名称缺失时为 null，不回退 companyName */
  readonly trustedCompanyName: string | null;
  readonly phone: string | null;
  readonly contactEmail: string | null;
  readonly role: IdentityTypeEnum;
  readonly status: AccountStatus;
  /** `base_user_account.admin_level`（1 / 2 / null） */
  readonly adminLevel: number | null;
  readonly updatedAt: Date;
}

/**
 * 账号设置更新（P2）锁内读取的**纯当前值事实**：由 `AccountService.lockMyAccountSettingsFacts()`
 * 在事务内对 account 行取悲观锁后读取，仅供 `UpdateMyAccountSettingsUsecase` 做合并、
 * 「至少保留一个登录凭据」判定与同值抑制，不进入任何 GraphQL DTO。
 *
 * 与 `MyAccountSettingsSnapshot` 的差异：只含七个**可写字段的当前值**，刻意不含
 * `role` / `status` / `updatedAt` ——它们不参与合并裁决，写后校验由事务内回读
 * `findMyAccountSettingsSnapshot()`（三源收敛 + 双状态判定）承担，本事实不重复实现。
 *
 * 这是普通数据（plain object），不是 ORM Entity / QueryBuilder
 * （`queryservice.rules.md`：modules 对上游只返回稳定数据）。
 */
export interface MyAccountSettingsUpdateFacts {
  readonly accountId: number;
  readonly loginName: string | null;
  readonly loginEmail: string | null;
  readonly nickname: string;
  readonly realName: string | null;
  readonly companyName: string | null;
  readonly phone: string | null;
  readonly contactEmail: string | null;
}

/**
 * 自助凭据窄写入（P2）的稳定事实结果（modules service → usecase），
 * 依据与 `AccountCreateOutcome` 相同的「返回事实对象而不抛错」precedent。
 *
 * - `UPDATED`：两列已按传入值写入；
 * - `CREDENTIAL_CONFLICT`：并发竞争下命中 `uk_login_name` / `uk_login_email`。
 *   唯一索引冲突无法可靠告知具体列（索引名只在驱动错误文本里，向上透出等于泄露存储细节），
 *   因此刻意不带冲突维度字段；此时用例侧预检查已经通过，友好提示只能是通用文案
 *   （「无法识别具体列时返回通用凭据冲突」）。驱动错误、SQL 与索引名一律不上行
 *   （仅以 `DomainError.cause` 在 modules 内部保留）。
 */
export type MyAccountCredentialWriteOutcome =
  { readonly kind: 'UPDATED' } | { readonly kind: 'CREDENTIAL_CONFLICT' };
